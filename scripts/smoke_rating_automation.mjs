import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { RATING_SMOKE_DIR } from './rating_artifact_paths.mjs';

const DEFAULT_URL =
  'https://play.google.com/console/u/2/developers/6147841152309536951/app/4975581156673272002/app-content/content-rating-iarc-questionnaire';

const config = {
  url: process.env.PLAY_CONSOLE_URL || DEFAULT_URL,
  category: process.env.IARC_CATEGORY || 'All Other App Types',
  outDir: process.env.OUT_DIR || RATING_SMOKE_DIR,
  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',
  expectedAccount: process.env.EXPECTED_GOOGLE_ACCOUNT || 'mengshu0715@gmail.com',
  pauseMs: Number(process.env.PAUSE_MS || 250),
  maxNormalizePasses: Number(process.env.MAX_NORMALIZE_PASSES || 80),
  submitForRating: process.env.SUBMIT_FOR_RATING === '1',
};

function cleanText(value) {
  return String(value || '')
    .replace(/\u2060?open_in_new\u200e?/g, ' ')
    .replace(/\bLearn more\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function openBrowserPage() {
  const browser = await chromium.connectOverCDP(config.cdpUrl);
  const context = browser.contexts()[0] || await browser.newContext();
  const existing = context.pages().find((candidate) => candidate.url().includes('/content-rating'));
  const page = existing || context.pages()[0] || await context.newPage();
  return {
    page,
    close: async () => {
      if (typeof browser.disconnect === 'function') browser.disconnect();
    },
  };
}

async function waitForConsole(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
  if (page.url().includes('accounts.google.com')) {
    throw new Error(`Chrome is on Google login. Log in as ${config.expectedAccount} in the debug Chrome first.`);
  }
}

async function discardCurrentChanges(page) {
  await waitForConsole(page);
  const existingConfirmDiscard = page.getByRole('button', { name: 'Discard', exact: true });
  if (await existingConfirmDiscard.count()) {
    await existingConfirmDiscard.click();
    await page.waitForTimeout(config.pauseMs * 2);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
    return;
  }

  const discard = page.getByRole('button', { name: 'Discard changes' });
  if (!(await discard.count())) return;

  console.log('Discarding current unsaved questionnaire changes.');
  await discard.click();
  await page.waitForTimeout(config.pauseMs);

  const confirmDiscard = page.getByRole('button', { name: 'Discard', exact: true });
  if (await confirmDiscard.count()) {
    await confirmDiscard.click();
    await page.waitForTimeout(config.pauseMs * 2);
  }

  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
}

async function ensureCategorySelectionStep(page) {
  await waitForConsole(page);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const body = cleanText(await page.locator('body').innerText({ timeout: 10_000 }).catch(() => ''));
    const categoryLabel = page.getByText(config.category, { exact: true });
    if (body.includes('Category') && body.includes('Terms and conditions') && (await categoryLabel.count())) {
      return;
    }

    const back = page.getByRole('button', { name: 'Back' });
    if (await back.count()) {
      await back.click();
      await page.waitForTimeout(config.pauseMs);
      continue;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error('Could not reach category selection step.');
}

async function chooseCategoryAndTerms(page) {
  console.log(`Selecting category "${config.category}".`);
  const categoryLabel = page.getByText(config.category, { exact: true });
  if (await categoryLabel.count()) {
    await categoryLabel.click();
    await page.waitForTimeout(config.pauseMs);
  }

  const terms = page.getByRole('checkbox').first();
  if (await terms.count()) {
    await terms.setChecked(true);
    await page.waitForTimeout(config.pauseMs);
  }

  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(config.pauseMs * 4);
}

async function ensureQuestionnaireStep(page) {
  await waitForConsole(page);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const questionCount = await page.locator('question').count().catch(() => 0);
    if (questionCount > 0) return;

    const body = cleanText(await page.locator('body').innerText({ timeout: 10_000 }).catch(() => ''));
    if (body.includes('Category') && body.includes('Terms and conditions')) {
      await chooseCategoryAndTerms(page);
      continue;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error('Could not reach questionnaire step.');
}

async function readQuestions(page) {
  return page.$$eval('question', (nodes) => {
    function normalize(value) {
      return String(value || '')
        .replace(/\u2060?open_in_new\u200e?/g, ' ')
        .replace(/\bLearn more\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function normalizeQuestionText(value) {
      return normalize(value)
        .replace(/(?:Yes\s*No|No\s*Yes)+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function hash(value) {
      let h = 0x811c9dc5;
      const text = normalize(value);
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    }

    function slug(value) {
      return normalize(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 56);
    }

    function extractRadioOptions(questionNode) {
      const inputs = Array.from(questionNode.querySelectorAll('input[type="radio"], input[role="radio"]'));
      return inputs
        .map((input) => {
          const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
          return {
            label: normalize(label?.innerText || label?.textContent || input.getAttribute('aria-label')),
            selected: Boolean(input.checked) || input.getAttribute('aria-checked') === 'true',
          };
        })
        .filter((option) => option.label);
    }

    function extractCheckboxOptions(questionNode) {
      return Array.from(questionNode.querySelectorAll('material-checkbox, mat-checkbox'))
        .map((box) => {
          const input = box.querySelector('input[type="checkbox"], input[role="checkbox"]');
          return {
            label: normalize(box.innerText || box.textContent || box.getAttribute('aria-label')),
            selected:
              Boolean(input?.checked) ||
              input?.getAttribute('aria-checked') === 'true' ||
              box.getAttribute('aria-checked') === 'true',
          };
        })
        .filter((option) => option.label);
    }

    return nodes
      .map((questionNode, order) => {
        const radioOptions = extractRadioOptions(questionNode);
        const checkboxOptions = extractCheckboxOptions(questionNode);
        const type = radioOptions.length ? 'radio' : checkboxOptions.length ? 'checkbox' : 'unknown';
        const options = type === 'radio' ? radioOptions : checkboxOptions;
        const rawText = normalize(questionNode.innerText || questionNode.textContent);
        let text = rawText;
        for (const option of options) text = normalize(text.replace(option.label, ' '));
        text = normalizeQuestionText(text);
        const optionSignature = options.map((option) => option.label).join('|');
        const keySource = `${type}::${text}::${optionSignature}`;
        const key = `${slug(text) || 'question'}_${hash(keySource)}`;
        return { key, text, type, order, options };
      })
      .filter((question) => question.text);
  });
}

async function setAnswer(page, assignment) {
  const changed = await page.evaluate((target) => {
    function normalize(value) {
      return String(value || '')
        .replace(/\u2060?open_in_new\u200e?/g, ' ')
        .replace(/\bLearn more\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function normalizeQuestionText(value) {
      return normalize(value)
        .replace(/(?:Yes\s*No|No\s*Yes)+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function hash(value) {
      let h = 0x811c9dc5;
      const text = normalize(value);
      for (let i = 0; i < text.length; i += 1) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(16).padStart(8, '0');
    }

    function slug(value) {
      return normalize(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 56);
    }

    function questionKeyFromNode(questionNode) {
      const radioTexts = Array.from(questionNode.querySelectorAll('input[type="radio"], input[role="radio"]'))
        .map((input) => {
          const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
          return normalize(label?.innerText || label?.textContent || input.getAttribute('aria-label'));
        })
        .filter(Boolean);
      const checkboxTexts = Array.from(questionNode.querySelectorAll('material-checkbox, mat-checkbox'))
        .map((box) => normalize(box.innerText || box.textContent))
        .filter(Boolean);
      const optionTexts = radioTexts.length ? radioTexts : checkboxTexts;
      const rawText = normalize(questionNode.innerText || questionNode.textContent);
      let text = rawText;
      for (const optionText of optionTexts) text = normalize(text.replace(optionText, ' '));
      text = normalizeQuestionText(text);
      const keySource = `${radioTexts.length ? 'radio' : checkboxTexts.length ? 'checkbox' : 'unknown'}::${text}::${optionTexts.join('|')}`;
      return `${slug(text) || 'question'}_${hash(keySource)}`;
    }

    const questionNode = Array.from(document.querySelectorAll('question')).find(
      (node) => questionKeyFromNode(node) === target.questionKey,
    );
    if (!questionNode) return false;

    if (target.type === 'radio') {
      const inputs = Array.from(questionNode.querySelectorAll('input[type="radio"], input[role="radio"]'));
      for (const input of inputs) {
        const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
        if (normalize(label?.innerText || label?.textContent || input.getAttribute('aria-label')) === target.optionLabel) {
          (label || input).click();
          return true;
        }
      }
    }

    if (target.type === 'checkbox') {
      const boxes = Array.from(questionNode.querySelectorAll('material-checkbox, mat-checkbox'));
      for (const box of boxes) {
        const label = normalize(box.innerText || box.textContent || box.getAttribute('aria-label'));
        if (label !== target.optionLabel) continue;
        const input = box.querySelector('input[type="checkbox"], input[role="checkbox"]');
        const checked =
          Boolean(input?.checked) ||
          input?.getAttribute('aria-checked') === 'true' ||
          box.getAttribute('aria-checked') === 'true';
        if (checked !== target.value) box.click();
        return true;
      }
    }

    return false;
  }, assignment);

  if (!changed) throw new Error(`Could not set answer: ${assignment.questionKey} -> ${assignment.optionLabel}`);
  await page.waitForTimeout(config.pauseMs);
}

function baselineAssignment(question) {
  if (question.type === 'radio') {
    const option = question.options.find((candidate) => candidate.label === 'No') || question.options[0];
    if (!option) return null;
    return {
      questionKey: question.key,
      questionText: question.text,
      type: 'radio',
      optionLabel: option.label,
      value: true,
    };
  }

  if (question.type === 'checkbox') {
    const selected = question.options.find((option) => option.selected);
    if (!selected) return null;
    return {
      questionKey: question.key,
      questionText: question.text,
      type: 'checkbox',
      optionLabel: selected.label,
      value: false,
    };
  }

  return null;
}

async function fillBaseline(page) {
  const applied = [];
  const seenStable = new Set();

  for (let pass = 0; pass < config.maxNormalizePasses; pass += 1) {
    const questions = await readQuestions(page);
    const signature = questions
      .map((question) => {
        const selected = question.options.filter((option) => option.selected).map((option) => option.label).join(',');
        return `${question.key}{${selected}}`;
      })
      .join('|');
    if (seenStable.has(signature)) break;
    seenStable.add(signature);

    let changed = false;
    for (const question of questions) {
      const assignment = baselineAssignment(question);
      if (!assignment) continue;

      if (question.type === 'radio') {
        const selected = question.options.find((option) => option.selected)?.label || null;
        if (selected === assignment.optionLabel) continue;
      }

      await setAnswer(page, assignment);
      applied.push(assignment);
      changed = true;
      break;
    }

    if (!changed) return applied;
  }

  return applied;
}

async function clickButtonIfAvailable(page, name) {
  const button = page.getByRole('button', { name });
  const count = await button.count();
  if (!count) return false;
  const target = button.first();
  if (!(await target.isEnabled().catch(() => false))) return false;
  await target.click();
  await page.waitForTimeout(config.pauseMs * 8);
  return true;
}

async function readRatingResult(page) {
  const bodyText = cleanText(await page.locator('body').innerText({ timeout: 20_000 }).catch(() => ''));
  const tables = await page.$$eval('table', (tables) =>
    tables.map((table) =>
      Array.from(table.querySelectorAll('tr')).map((row) =>
        Array.from(row.querySelectorAll('th,td')).map((cell) => cell.innerText.replace(/\s+/g, ' ').trim()),
      ),
    ),
  ).catch(() => []);

  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    bodyText,
    tables,
    ratings: parseRatings(bodyText),
  };
}

function parseRatings(bodyText) {
  const start = bodyText.indexOf('Your ratings');
  if (start === -1) return [];

  const endMarkers = [' If you save', ' Back Save', ' Questionnaire saved'];
  const end = endMarkers
    .map((marker) => bodyText.indexOf(marker, start))
    .filter((index) => index > start)
    .sort((a, b) => a - b)[0] || bodyText.length;
  const section = bodyText.slice(start, end).replace(/^Your ratings\s*/, '').trim();
  if (!section) return [];

  const territories = [
    'Australia',
    'Brazil',
    'North America',
    'South Korea',
    'Taiwan',
    'Saudi Arabia',
    'Europe',
    'Germany',
    'Rest of world',
    'Russia',
  ];

  const territoryPattern = new RegExp(`(?:^|\\s)(${territories.map(escapeRegExp).join('|')})\\s+Rating authority:`, 'g');
  const matches = [...section.matchAll(territoryPattern)];
  const ratings = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const next = matches[index + 1];
    const territory = match[1];
    const blockStart = match.index + match[0].length;
    const blockEnd = next?.index ?? section.length;
    const block = cleanText(section.slice(blockStart, blockEnd));

    const warningMatch = block.match(/\swarning\s(.+?)\sRating\s/);
    const warning = warningMatch?.[1] || '';
    const normalizedBlock = warningMatch
      ? cleanText(block.replace(` warning ${warning} `, ' '))
      : block;
    const descriptorMarker = ' Content descriptors ';
    const descriptorIndex = normalizedBlock.lastIndexOf(descriptorMarker);
    const beforeDescriptors = descriptorIndex === -1 ? normalizedBlock : normalizedBlock.slice(0, descriptorIndex);
    const contentDescriptors =
      descriptorIndex === -1 ? '' : normalizedBlock.slice(descriptorIndex + descriptorMarker.length).trim();
    const ratingMarker = ' Rating ';
    const ratingIndex = beforeDescriptors.lastIndexOf(ratingMarker);

    ratings.push({
      territory,
      authority: ratingIndex === -1 ? '' : beforeDescriptors.slice(0, ratingIndex).trim(),
      rating: ratingIndex === -1 ? '' : beforeDescriptors.slice(ratingIndex + ratingMarker.length).trim(),
      contentDescriptors,
      warning,
      raw: block,
    });
  }

  return ratings;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function main() {
  await mkdir(config.outDir, { recursive: true });
  const { page, close } = await openBrowserPage();
  try {
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
    await discardCurrentChanges(page);
    await ensureCategorySelectionStep(page);
    await chooseCategoryAndTerms(page);
    await ensureQuestionnaireStep(page);

    const before = await readQuestions(page);
    console.log(`Questionnaire ready: ${before.length} visible questions.`);
    const applied = await fillBaseline(page);
    const after = await readQuestions(page);
    console.log(`Baseline filled: ${applied.length} answer operations, ${after.length} visible questions after normalize.`);

    const snapshot = {
      generatedAt: new Date().toISOString(),
      category: config.category,
      submitForRating: config.submitForRating,
      applied,
      visibleAfterFill: after,
      result: null,
    };

    if (config.submitForRating) {
      const saved = await clickButtonIfAvailable(page, 'Save');
      console.log(`Save clicked: ${saved}`);
      const next = await clickButtonIfAvailable(page, 'Next');
      console.log(`Next clicked: ${next}`);
      snapshot.result = await readRatingResult(page);
      console.log(`Result URL: ${snapshot.result.url}`);
      console.log(snapshot.result.bodyText.slice(0, 1200));
    } else {
      console.log('Dry run only. Set SUBMIT_FOR_RATING=1 to click Save/Next and read the rating result page.');
    }

    const outPath = `${config.outDir}/baseline_${config.category.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}.json`;
    await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`Saved smoke artifact: ${outPath}`);
  } finally {
    await close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
