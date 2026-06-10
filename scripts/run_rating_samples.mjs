import { chromium } from 'playwright';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const DEFAULT_URL =
  'https://play.google.com/console/u/2/developers/6147841152309536951/app/4975581156673272002/app-content/content-rating-iarc-questionnaire';
const DEFAULT_OVERVIEW_URL =
  'https://play.google.com/console/u/2/developers/6147841152309536951/app/4975581156673272002/app-content/content-rating-overview';

const config = {
  url: process.env.PLAY_CONSOLE_URL || DEFAULT_URL,
  overviewUrl: process.env.PLAY_CONSOLE_OVERVIEW_URL || DEFAULT_OVERVIEW_URL,
  sampleFile: process.env.SAMPLE_FILE || 'rating_samples/structural_samples.jsonl',
  outDir: process.env.RESULT_OUT_DIR || 'rating_results',
  resultFile: process.env.RESULT_FILE || '',
  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',
  expectedAccount: process.env.EXPECTED_GOOGLE_ACCOUNT || 'mengshu0715@gmail.com',
  contactEmail: process.env.IARC_CONTACT_EMAIL || process.env.EXPECTED_GOOGLE_ACCOUNT || 'mengshu0715@gmail.com',
  pauseMs: Number(process.env.PAUSE_MS || 160),
  limit: Number(process.env.LIMIT || 20),
  maxNormalizePasses: Number(process.env.MAX_NORMALIZE_PASSES || 80),
  skipErrored: process.env.SKIP_ERRORED === '1',
};

function cleanText(value) {
  return String(value || '')
    .replace(/\u2060?open_in_new\u200e?/g, ' ')
    .replace(/\bLearn more\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function categorySlug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isFatalBrowserError(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('Target page, context or browser has been closed') ||
    message.includes('Browser has been closed') ||
    message.includes('browserType.connectOverCDP')
  );
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

async function bodyText(page) {
  return cleanText(await page.locator('body').innerText({ timeout: 10_000 }).catch(() => ''));
}

async function dismissOverlays(page) {
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(100);

  const close = page.getByRole('button', { name: 'Close' });
  if (await close.count() && await close.first().isEnabled().catch(() => false)) {
    await close.first().click({ timeout: 1500 }).catch(() => {});
    await page.waitForTimeout(100);
  }
}

async function discardCurrentChanges(page) {
  await waitForConsole(page);
  const existingConfirmDiscard = page.getByRole('button', { name: 'Discard', exact: true });
  if (await existingConfirmDiscard.count() && await existingConfirmDiscard.first().isEnabled().catch(() => false)) {
    await existingConfirmDiscard.first().click();
    await page.waitForTimeout(config.pauseMs * 2);
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
    return;
  }

  const discard = page.getByRole('button', { name: 'Discard changes' });
  if (!(await discard.count())) return;
  if (!(await discard.first().isEnabled().catch(() => false))) return;

  await discard.first().click();
  await page.waitForTimeout(config.pauseMs);
  const confirmDiscard = page.getByRole('button', { name: 'Discard', exact: true });
  if (await confirmDiscard.count() && await confirmDiscard.first().isEnabled().catch(() => false)) {
    await confirmDiscard.first().click();
    await page.waitForTimeout(config.pauseMs * 2);
  }
  await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
}

async function ensureCategorySelectionStep(page, category) {
  await waitForConsole(page);

  for (let attempt = 0; attempt < 35; attempt += 1) {
    const text = await bodyText(page);
    const categoryLabel = page.getByText(category, { exact: true });
    if (text.includes('Category') && text.includes('Terms and conditions') && (await categoryLabel.count())) return;

    const back = page.getByRole('button', { name: 'Back' });
    if (await back.count() && await back.first().isEnabled().catch(() => false)) {
      await dismissOverlays(page);
      await back.first().click();
      await page.waitForTimeout(config.pauseMs * 2);
      continue;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Could not reach category selection step for ${category}.`);
}

async function chooseCategoryAndTerms(page, category) {
  const emailFilled = await page.evaluate((email) => {
    const input = document.querySelector('input[type="email"]');
    if (!input) return false;
    if (input.value === email) return true;
    input.focus();
    input.value = email;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.blur();
    return true;
  }, config.contactEmail);
  if (emailFilled) {
    await page.waitForTimeout(config.pauseMs);
  }

  const categoryLabel = page.getByText(category, { exact: true });
  if (await categoryLabel.count()) {
    await categoryLabel.click();
    await page.waitForTimeout(config.pauseMs);
  }

  const termsChanged = await page.evaluate(() => {
    const checkbox = document.querySelector('input[type="checkbox"], input[role="checkbox"]');
    if (!checkbox) return false;
    if (checkbox.checked || checkbox.getAttribute('aria-checked') === 'true') return true;
    const label = checkbox.id ? document.querySelector(`label[for="${CSS.escape(checkbox.id)}"]`) : null;
    (label || checkbox).click();
    return true;
  });
  if (termsChanged) {
    await page.waitForTimeout(config.pauseMs);
  }

  await page.getByRole('button', { name: 'Next' }).click();
  await page.waitForTimeout(config.pauseMs * 5);
}

async function readPageState(page, category) {
  const questionCount = await page.locator('question').count().catch(() => 0);
  const text = await bodyText(page);
  const categoryLabel = page.getByText(category, { exact: true });
  const hasCategoryLabel = Boolean(await categoryLabel.count().catch(() => 0));
  const next = page.getByRole('button', { name: 'Next', exact: true });
  const hasNext = Boolean(await next.count().catch(() => 0));
  const back = page.getByRole('button', { name: 'Back', exact: true });
  const hasBack = Boolean(await back.count().catch(() => 0));

  if (questionCount > 0) {
    return {
      kind: text.includes(category) ? 'target-questionnaire' : 'other-questionnaire',
      questionCount,
      text,
    };
  }
  if (hasCategoryLabel && hasNext && text.includes('Terms and conditions')) {
    return { kind: 'category', questionCount, text };
  }
  if (text.includes('Your ratings') || text.includes('Summary Ratings shown below')) {
    return { kind: 'summary', questionCount, text };
  }
  if (text.includes('Start new questionnaire') || text.includes('Your current ratings')) {
    return { kind: 'overview', questionCount, text };
  }
  if (!text || (!hasNext && !hasBack && text.includes('Loading Google Play Console'))) {
    return { kind: 'loading', questionCount, text };
  }
  return { kind: 'unknown', questionCount, text };
}

async function recoverToCategorySelection(page, category) {
  if (!page.url().includes('content-rating-iarc-questionnaire')) {
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
  }

  for (let attempt = 0; attempt < 90; attempt += 1) {
    const state = await readPageState(page, category);
    if (attempt === 0 || attempt % 10 === 9) {
      console.log(
        `Recover category attempt ${attempt + 1}: state=${state.kind} url=${page.url()} text="${state.text.slice(0, 160)}"`,
      );
    }

    if (state.kind === 'target-questionnaire') return 'questionnaire';
    if (state.kind === 'category') return 'category';
    if (state.kind === 'loading' || state.kind === 'unknown') {
      if (attempt === 30 || attempt === 60) {
        await page.goto(config.overviewUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => {});
      }
      await page.waitForTimeout(1000);
      continue;
    }

    if (state.kind === 'overview') {
      const start = page.getByRole('button', { name: 'Start new questionnaire' });
      if (await start.count() && await start.first().isEnabled().catch(() => false)) {
        await start.first().click();
        await page.waitForTimeout(config.pauseMs * 8);
        continue;
      }

      const edit = page.getByRole('button', { name: 'Edit' });
      if (await edit.count() && await edit.first().isEnabled().catch(() => false)) {
        await edit.first().click();
        await page.waitForTimeout(config.pauseMs * 8);
        continue;
      }
    }

    if (state.kind === 'summary' || state.kind === 'other-questionnaire') {
      const back = page.getByRole('button', { name: 'Back', exact: true });
      if (await back.count() && await back.first().isEnabled().catch(() => false)) {
        await dismissOverlays(page);
        await back.first().click();
        await page.waitForTimeout(config.pauseMs * 3);
        continue;
      }
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Could not recover questionnaire state for ${category}.`);
}

async function ensureQuestionnaireStep(page, category) {
  await waitForConsole(page);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const questionCount = await page.locator('question').count().catch(() => 0);
    if (questionCount > 0) return;

    const text = await bodyText(page);
    if (text.includes('Category') && text.includes('Terms and conditions')) {
      await chooseCategoryAndTerms(page, category);
      continue;
    }

    const back = page.getByRole('button', { name: 'Back' });
    if (await back.count() && await back.first().isEnabled().catch(() => false)) {
      await dismissOverlays(page);
      await back.first().click();
      await page.waitForTimeout(config.pauseMs * 2);
      continue;
    }

    await page.waitForTimeout(1000);
  }

  throw new Error(`Could not reach questionnaire step for ${category}.`);
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
      return Array.from(questionNode.querySelectorAll('input[type="radio"], input[role="radio"]'))
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
      (node) => questionKeyFromNode(node) === target.questionId,
    );
    if (!questionNode) return false;

    if (target.type === 'radio') {
      for (const input of Array.from(questionNode.querySelectorAll('input[type="radio"], input[role="radio"]'))) {
        const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
        if (normalize(label?.innerText || label?.textContent || input.getAttribute('aria-label')) === target.optionLabel) {
          (label || input).click();
          return true;
        }
      }
    }

    if (target.type === 'checkbox') {
      for (const box of Array.from(questionNode.querySelectorAll('material-checkbox, mat-checkbox'))) {
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

  if (!changed) throw new Error(`Could not set answer: ${assignment.questionId} -> ${assignment.optionLabel}`);
  await page.waitForTimeout(config.pauseMs);
}

function baselineAssignment(question, protectedAnswers = new Set()) {
  const hasProtectedQuestionAnswer = question.options.some((option) =>
    protectedAnswers.has(`${question.key}::${question.type}::${option.label}`),
  );

  if (question.type === 'radio') {
    if (hasProtectedQuestionAnswer) return null;
    const option = question.options.find((candidate) => candidate.label === 'No') || question.options[0];
    if (!option) return null;
    return {
      questionId: question.key,
      questionText: question.text,
      type: 'radio',
      optionLabel: option.label,
      value: true,
    };
  }

  if (question.type === 'checkbox') {
    const selected = question.options.find(
      (option) => option.selected && !protectedAnswers.has(`${question.key}::${question.type}::${option.label}`),
    );
    if (!selected) return null;
    return {
      questionId: question.key,
      questionText: question.text,
      type: 'checkbox',
      optionLabel: selected.label,
      value: false,
    };
  }

  return null;
}

function protectedAssignmentKey(answer) {
  return `${answer.questionId}::${answer.type}::${answer.optionLabel}`;
}

async function fillBaseline(page, protectedAnswers = new Set()) {
  for (let pass = 0; pass < config.maxNormalizePasses; pass += 1) {
    const questions = await readQuestions(page);
    let changed = false;

    for (const question of questions) {
      const assignment = baselineAssignment(question, protectedAnswers);
      if (!assignment) continue;

      if (question.type === 'radio') {
        const selected = question.options.find((option) => option.selected)?.label || null;
        if (selected === assignment.optionLabel) continue;
      }

      await setAnswer(page, assignment);
      changed = true;
      break;
    }

    if (!changed) return;
  }

  throw new Error(`Could not fill baseline within ${config.maxNormalizePasses} passes.`);
}

async function applySampleAnswers(page, sample) {
  await fillBaseline(page);
  const applied = [];

  for (let index = 0; index < sample.answers.length; index += 1) {
    const answer = sample.answers[index];
    const visible = await readQuestions(page);
    if (!visible.some((question) => question.key === answer.questionId)) {
      throw new Error(
        `Sample ${sample.sampleId} answer ${index} is not visible: ${answer.questionId} -> ${answer.optionLabel}`,
      );
    }

    await setAnswer(page, answer);
    applied.push(answer);

    const nextAnswer = sample.answers[index + 1];
    if (nextAnswer) {
      await waitForQuestionVisible(page, nextAnswer.questionId, config.pauseMs * 25);
    }
  }

  await fillBaseline(page, new Set(applied.map(protectedAssignmentKey)));
  return applied;
}

async function waitForQuestionVisible(page, questionId, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const visible = await readQuestions(page);
    if (visible.some((question) => question.key === questionId)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function clickButtonIfAvailable(page, name) {
  await dismissOverlays(page);
  const button = page.getByRole('button', { name, exact: true });
  if (!(await button.count())) return false;
  const target = button.first();
  if (!(await target.isEnabled().catch(() => false))) return false;
  await target.click();
  await page.waitForTimeout(config.pauseMs * 8);
  return true;
}

async function waitForSaveSettled(page) {
  await page.waitForTimeout(Math.max(500, config.pauseMs * 4));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = await bodyText(page);
    const next = page.getByRole('button', { name: 'Next', exact: true });
    const nextEnabled = await next.first().isEnabled().catch(() => false);
    if (
      text.includes('Your changes have been saved') ||
      text.includes('Questionnaire saved') ||
      (nextEnabled && !text.includes('Submitting...') && !text.includes('Loading...'))
    ) {
      return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function waitForSummaryRatings(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const text = await bodyText(page);
    if (parseRatings(text).length > 0) return true;
    if (text.includes('Your ratings') && text.includes('Rating authority:')) {
      return true;
    }
    await page.waitForTimeout(500);
  }
  return false;
}

async function advanceToSummary(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = await clickButtonIfAvailable(page, 'Next');
    if (!next) return false;
    if (await waitForSummaryRatings(page)) return true;

    const questionCount = await page.locator('question').count().catch(() => 0);
    if (!questionCount) return false;
    await waitForSaveSettled(page);
  }
  return false;
}

async function returnToQuestionnaire(page) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const questionCount = await page.locator('question').count().catch(() => 0);
    if (questionCount > 0) return true;

    const back = page.getByRole('button', { name: 'Back' });
    if (await back.count() && await back.first().isEnabled().catch(() => false)) {
      await dismissOverlays(page);
      await back.first().click();
      await page.waitForTimeout(config.pauseMs * 3);
      continue;
    }

    await page.waitForTimeout(500);
  }

  return false;
}

function parseRatings(text) {
  const start = text.indexOf('Your ratings');
  if (start === -1) return [];
  const endMarkers = [' If you save', ' Back Save', ' Questionnaire saved'];
  const end = endMarkers
    .map((marker) => text.indexOf(marker, start))
    .filter((index) => index > start)
    .sort((a, b) => a - b)[0] || text.length;
  const section = text.slice(start, end).replace(/^Your ratings\s*/, '').trim();
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

  return matches.map((match, index) => {
    const next = matches[index + 1];
    const block = cleanText(section.slice(match.index + match[0].length, next?.index ?? section.length));
    const warningMatch = block.match(/\swarning\s(.+?)\sRating\s/);
    const warning = warningMatch?.[1] || '';
    const normalizedBlock = warningMatch ? cleanText(block.replace(` warning ${warning} `, ' ')) : block;
    const descriptorMarker = ' Content descriptors ';
    const descriptorIndex = normalizedBlock.lastIndexOf(descriptorMarker);
    const beforeDescriptors = descriptorIndex === -1 ? normalizedBlock : normalizedBlock.slice(0, descriptorIndex);
    const contentDescriptors =
      descriptorIndex === -1 ? '' : normalizedBlock.slice(descriptorIndex + descriptorMarker.length).trim();
    const ratingMarker = ' Rating ';
    const ratingIndex = beforeDescriptors.lastIndexOf(ratingMarker);
    return {
      territory: match[1],
      authority: ratingIndex === -1 ? '' : beforeDescriptors.slice(0, ratingIndex).trim(),
      rating: ratingIndex === -1 ? '' : beforeDescriptors.slice(ratingIndex + ratingMarker.length).trim(),
      contentDescriptors,
      warning,
      raw: block,
    };
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function readRatingResult(page) {
  const text = cleanText(await page.locator('body').innerText({ timeout: 20_000 }).catch(() => ''));
  return {
    url: page.url(),
    title: await page.title().catch(() => ''),
    bodyText: text,
    ratings: parseRatings(text),
  };
}

async function loadSamples() {
  const text = await readFile(config.sampleFile, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function loadCompleted(resultPath) {
  if (!existsSync(resultPath)) return new Set();
  const text = await readFile(resultPath, 'utf8');
  return new Set(
    text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line).sampleId),
  );
}

async function loadErrored(errorPath) {
  if (!existsSync(errorPath)) return new Set();
  const text = await readFile(errorPath, 'utf8');
  return new Set(
    text
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line).sampleId),
  );
}

async function isCurrentQuestionnaireForCategory(page, category) {
  const questionCount = await page.locator('question').count().catch(() => 0);
  if (!questionCount) return false;
  const text = await bodyText(page);
  return text.includes(category) && text.includes('Questionnaire');
}

async function prepareCategory(page, category) {
  if (await isCurrentQuestionnaireForCategory(page, category)) return;
  const recoveredState = await recoverToCategorySelection(page, category);
  if (recoveredState === 'questionnaire') return;
  await chooseCategoryAndTerms(page, category);
  await ensureQuestionnaireStep(page, category);
}

async function main() {
  await mkdir(config.outDir, { recursive: true });
  const resultPath = config.resultFile || `${config.outDir}/results.jsonl`;
  const errorPath = `${config.outDir}/errors.jsonl`;
  const samples = await loadSamples();
  const completed = await loadCompleted(resultPath);
  const errored = config.skipErrored ? await loadErrored(errorPath) : new Set();
  const pending = samples
    .filter((sample) => !completed.has(sample.sampleId) && !errored.has(sample.sampleId))
    .slice(0, config.limit || undefined);
  await writeFile(`${config.outDir}/run_config.json`, JSON.stringify({ ...config, resultPath }, null, 2) + '\n');

  console.log(
    `Loaded ${samples.length} samples; completed=${completed.size}; skippedErrored=${errored.size}; pending this run=${pending.length}`,
  );
  if (!pending.length) return;

  const { page, close } = await openBrowserPage();
  let activeCategory = '';

  try {
    for (let index = 0; index < pending.length; index += 1) {
      const sample = pending[index];
      const startedAt = new Date().toISOString();
      console.log(`[${index + 1}/${pending.length}] ${sample.sampleId} ${sample.category} ${sample.strategy}`);

      try {
        if (sample.category !== activeCategory) {
          await prepareCategory(page, sample.category);
          activeCategory = sample.category;
        } else {
          await ensureQuestionnaireStep(page, sample.category);
        }

        const applied = await applySampleAnswers(page, sample);
        const saved = await clickButtonIfAvailable(page, 'Save');
        if (saved) await waitForSaveSettled(page);
        const next = await advanceToSummary(page);
        const result = await readRatingResult(page);
        if (!result.ratings.length) {
          const recovered = await returnToQuestionnaire(page);
          const error = new Error('No ratings parsed from Summary page.');
          error.recoveredSameCategory = recovered;
          error.pageUrl = result.url;
          error.bodyTextPreview = result.bodyText.slice(0, 1000);
          throw error;
        }

        await appendFile(
          resultPath,
          `${JSON.stringify({
            sampleId: sample.sampleId,
            category: sample.category,
            categorySlug: sample.categorySlug || categorySlug(sample.category),
            strategy: sample.strategy,
            answers: sample.answers,
            applied,
            saved,
            next,
            result,
            startedAt,
            finishedAt: new Date().toISOString(),
          })}\n`,
        );
      } catch (error) {
        if (isFatalBrowserError(error)) {
          throw error;
        }
        await appendFile(
          errorPath,
          `${JSON.stringify({
            sampleId: sample.sampleId,
            category: sample.category,
            strategy: sample.strategy,
            error: error.message,
            recoveredSameCategory: Boolean(error.recoveredSameCategory),
            pageUrl: error.pageUrl || page.url(),
            bodyTextPreview: error.bodyTextPreview || '',
            at: new Date().toISOString(),
          })}\n`,
        );
        console.error(`Failed ${sample.sampleId}: ${error.message}`);
        if (!error.recoveredSameCategory) {
          activeCategory = '';
        }
      }
    }
  } finally {
    await close();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
