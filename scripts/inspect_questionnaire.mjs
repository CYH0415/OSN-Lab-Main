import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { argv, stdin as input, stdout as output } from 'node:process';

const DEFAULT_URL =
  'https://play.google.com/console/u/2/developers/6147841152309536951/app/4975581156673272002/app-content/content-rating-iarc-questionnaire';

const config = {
  url: process.env.PLAY_CONSOLE_URL || DEFAULT_URL,
  category: process.env.IARC_CATEGORY || 'All Other App Types',
  outDir: process.env.OUT_DIR || 'data',
  profileDir: process.env.PW_PROFILE_DIR || '.playwright-profile',
  cdpUrl: process.env.CDP_URL || '',
  browserChannel: process.env.BROWSER_CHANNEL || '',
  expectedAccount: process.env.EXPECTED_GOOGLE_ACCOUNT || 'mengshu0715@gmail.com',
  forceGoto: process.env.FORCE_GOTO === '1',
  maxDepth: Number(process.env.MAX_DEPTH || 8),
  maxStates: Number(process.env.MAX_STATES || 500),
  maxProbes: Number(process.env.MAX_PROBES || 2000),
  maxNormalizePasses: Number(process.env.MAX_NORMALIZE_PASSES || 80),
  pauseMs: Number(process.env.PAUSE_MS || 700),
  headless: process.env.HEADLESS === '1',
  selectCategory: process.env.SELECT_CATEGORY === '1' || process.env.LIST_CATEGORIES === '1',
  listCategories: process.env.LIST_CATEGORIES === '1',
  discardChanges: process.env.DISCARD_CHANGES === '1',
};

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage:
  npm run inspect:questionnaire

Environment variables:
  PLAY_CONSOLE_URL  Google Play Console IARC questionnaire URL
  IARC_CATEGORY     Category to select on step 1, default: All Other App Types
  OUT_DIR           Output directory, default: data
  PW_PROFILE_DIR    Persistent browser profile directory, default: .playwright-profile
  CDP_URL           Connect to an already running Chrome, for example http://127.0.0.1:9222
  BROWSER_CHANNEL   Launch a real browser channel, for example chrome
  FORCE_GOTO=1      Navigate to PLAY_CONSOLE_URL even when a matching CDP tab is already open
  EXPECTED_GOOGLE_ACCOUNT
                    Account that should own Play Console access, default: mengshu0715@gmail.com
  MAX_DEPTH         Traversal depth limit, default: 8
  MAX_STATES        Traversal state limit, default: 500
  MAX_PROBES        Answer-click probe limit, default: 2000
  MAX_NORMALIZE_PASSES
                    Visible-state cleanup pass limit, default: 80
  PAUSE_MS          Delay after each answer click, default: 700
  HEADLESS=1        Run headless after the profile is already logged in
  SELECT_CATEGORY=1 Navigate back to category selection and choose IARC_CATEGORY before traversal
  DISCARD_CHANGES=1
                    Discard current unsaved questionnaire draft before selecting category
  LIST_CATEGORIES=1
                    Print available category labels and exit
`);
  process.exit(0);
}

const seenQuestions = new Map();
const edges = [];
const states = [];
const skippedProbes = [];
const visitedStates = new Set();
const probedAssignments = new Set();
let probeCount = 0;

function cleanText(value) {
  return String(value || '')
    .replace(/\u2060?open_in_new\u200e?/g, ' ')
    .replace(/\bLearn more\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanQuestionText(value) {
  return cleanText(value)
    .replace(/(?:Yes\s*No|No\s*Yes)+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
}

function shortHash(value) {
  return createHash('sha1').update(cleanText(value)).digest('hex').slice(0, 10);
}

function questionKey(questionText) {
  return `${slug(questionText) || 'question'}_${shortHash(questionText)}`;
}

function assignmentKey(assignment) {
  return `${assignment.questionKey}:${assignment.type}:${assignment.optionLabel}:${assignment.value}`;
}

function pathAlreadyAnswersQuestion(path, question, assignment) {
  if (assignment.type === 'radio') {
    return path.some((item) => item.type === 'radio' && item.questionKey === question.key);
  }

  if (assignment.type === 'checkbox') {
    return path.some(
      (item) =>
        item.type === 'checkbox' &&
        item.questionKey === question.key &&
        item.optionLabel === assignment.optionLabel &&
        item.value === assignment.value,
    );
  }

  return false;
}

function selectedAssignmentsFromQuestions(questions) {
  const assignments = [];

  for (const question of questions) {
    if (question.type === 'radio') {
      const selected = question.options.find((option) => option.selected);
      if (selected) {
        assignments.push({
          questionKey: question.key,
          questionText: question.text,
          type: 'radio',
          optionLabel: selected.label,
          value: true,
        });
      }
      continue;
    }

    if (question.type === 'checkbox') {
      for (const selected of question.options.filter((option) => option.selected)) {
        assignments.push({
          questionKey: question.key,
          questionText: question.text,
          type: 'checkbox',
          optionLabel: selected.label,
          value: true,
        });
      }
    }
  }

  return assignments;
}

function restorePathFromVisibleState(questions) {
  return selectedAssignmentsFromQuestions(questions).filter((assignment) => {
    if (assignment.type === 'radio') {
      return assignment.optionLabel !== 'No';
    }
    return assignment.value;
  });
}

function mergeQuestions(questions) {
  for (const question of questions) {
    const previous = seenQuestions.get(question.key);
    if (!previous) {
      seenQuestions.set(question.key, question);
      continue;
    }

    const optionMap = new Map(previous.options.map((option) => [option.label, option]));
    for (const option of question.options) {
      if (!optionMap.has(option.label)) previous.options.push(option);
    }

    previous.observedCount += 1;
  }
}

async function promptUser(message) {
  const rl = createInterface({ input, output });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

async function waitForConsole(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});

  if (page.url().includes('accounts.google.com')) {
    console.log('Google login is required. Finish login in the opened browser, then press Enter here.');
    await promptUser('');
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {});
  }
}

async function ensureQuestionnaireStep(page) {
  await waitForConsole(page);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const questionCount = await page.locator('question').count().catch(() => 0);
    if (questionCount > 0) {
      console.log(`Questionnaire step ready: ${questionCount} visible question components.`);
      return;
    }

    const body = cleanText(await page.locator('body').innerText({ timeout: 10_000 }).catch(() => ''));

    if (body.includes('Summary')) {
      const back = page.getByRole('button', { name: 'Back' });
      if (await back.count()) {
        await back.click();
        await page.waitForTimeout(config.pauseMs);
        continue;
      }
    }

    if (body.includes('Category') && body.includes('Terms and conditions')) {
      await chooseCategoryAndTerms(page);
      continue;
    }

    console.log(`Waiting for questionnaire step, attempt ${attempt + 1}/20...`);
    await page.waitForTimeout(1500);
  }

  throw new Error('Could not reach questionnaire step. Make sure the Play Console questionnaire page is open and accessible.');
}

async function chooseCategoryAndTerms(page) {
  console.log(`Selecting category "${config.category}" and accepting IARC terms.`);
  const categoryLabel = page.getByText(config.category, { exact: true });
  if (await categoryLabel.count()) {
    await categoryLabel.click();
    await page.waitForTimeout(300);
  }

  const terms = page.getByRole('checkbox').first();
  if (await terms.count()) {
    await terms.setChecked(true);
    await page.waitForTimeout(300);
  }

  const next = page.getByRole('button', { name: 'Next' });
  await next.click();
  await page.waitForTimeout(1800);
}

async function ensureCategorySelectionStep(page) {
  await waitForConsole(page);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    const body = cleanText(await page.locator('body').innerText({ timeout: 10_000 }).catch(() => ''));
    const categoryLabel = page.getByText(config.category, { exact: true });
    if (body.includes('Category') && body.includes('Terms and conditions') && (await categoryLabel.count())) {
      console.log('Category selection step ready.');
      return;
    }

    const back = page.getByRole('button', { name: 'Back' });
    if (await back.count()) {
      await back.click();
      await page.waitForTimeout(config.pauseMs);
      continue;
    }

    console.log(`Waiting for category selection step, attempt ${attempt + 1}/30...`);
    await page.waitForTimeout(1500);
  }

  throw new Error('Could not reach category selection step.');
}

async function readCategoryLabels(page) {
  await ensureCategorySelectionStep(page);
  return page.$$eval('input[type="radio"], input[role="radio"]', (nodes) => {
    function normalize(value) {
      return String(value || '')
        .replace(/\u2060?open_in_new\u200e?/g, ' ')
        .replace(/\bLearn more\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const labels = [];
    for (const input of nodes) {
      const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
      const text = normalize(label?.innerText || label?.textContent || input.getAttribute('aria-label'));
      if (!text) continue;
      labels.push(text);
    }
    return [...new Set(labels)];
  });
}

async function discardChangesIfRequested(page) {
  if (!config.discardChanges) return;
  await discardCurrentChanges(page);
}

async function discardCurrentChanges(page) {
  await waitForConsole(page);
  const existingConfirmDiscard = page.getByRole('button', { name: 'Discard', exact: true });
  if (await existingConfirmDiscard.count()) {
    console.log('Confirming existing discard dialog.');
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
      return inputs.map((input) => {
        const label = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
        return {
          label: normalize(label?.innerText || label?.textContent || input.getAttribute('aria-label')),
          selected: Boolean(input.checked) || input.getAttribute('aria-checked') === 'true',
        };
      }).filter((option) => option.label);
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

    return nodes.map((questionNode, order) => {
      const radioOptions = extractRadioOptions(questionNode);
      const checkboxOptions = extractCheckboxOptions(questionNode);
      const type = radioOptions.length ? 'radio' : checkboxOptions.length ? 'checkbox' : 'unknown';
      const options = type === 'radio' ? radioOptions : checkboxOptions;

      const rawText = normalize(questionNode.innerText || questionNode.textContent);
      let text = rawText;
      for (const option of options) {
        text = normalize(text.replace(option.label, ' '));
      }
      text = normalizeQuestionText(text);

      const optionSignature = options.map((option) => option.label).join('|');
      const keySource = `${type}::${text}::${optionSignature}`;
      const key = `${slug(text) || 'question'}_${hash(keySource)}`;

      return {
        key,
        text,
        type,
        order,
        options,
        observedCount: 1,
      };
    }).filter((question) => question.text);
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

    const questionNode = Array.from(document.querySelectorAll('question'))
      .find((node) => questionKeyFromNode(node) === target.questionKey);
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

  if (!changed) {
    throw new Error(`Could not set answer: ${assignment.questionKey} -> ${assignment.optionLabel}`);
  }

  await page.waitForTimeout(config.pauseMs);
}

async function applyPath(page, path) {
  await ensureQuestionnaireStep(page);
  await resetToBaseline(page);

  for (let index = 0; index < path.length; index += 1) {
    const assignment = path[index];
    const visible = await readQuestions(page);
    if (!visible.some((question) => question.key === assignment.questionKey)) {
      throw new Error(
        [
          `Cannot replay path at index ${index}: target question is not visible.`,
          `Target: ${assignment.questionKey} -> ${assignment.optionLabel}`,
          `Visible: ${visible.map((question) => question.key).join(', ')}`,
        ].join('\n'),
      );
    }
    await setAnswer(page, assignment);
  }

  await normalizeVisibleQuestionsToPath(page, path);
}

async function rebuildStateFromCategory(page, path) {
  if (config.discardChanges) {
    await discardCurrentChanges(page);
  }
  await ensureCategorySelectionStep(page);
  await chooseCategoryAndTerms(page);
  await ensureQuestionnaireStep(page);

  for (const assignment of path) {
    await setAnswer(page, assignment);
  }

  await normalizeVisibleQuestionsToPath(page, path);
}

async function normalizeVisibleQuestionsToPath(page, path) {
  const keepRadioQuestions = new Set(
    path.filter((assignment) => assignment.type === 'radio').map((assignment) => assignment.questionKey),
  );
  const keepCheckboxOptions = new Set(
    path
      .filter((assignment) => assignment.type === 'checkbox' && assignment.value)
      .map((assignment) => `${assignment.questionKey}:${assignment.optionLabel}`),
  );

  for (let pass = 0; pass < config.maxNormalizePasses; pass += 1) {
    const questions = await readQuestions(page);
    let changed = false;

    for (const question of questions) {
      if (question.type === 'radio' && !keepRadioQuestions.has(question.key)) {
        const noOption = question.options.find((option) => option.label === 'No');
        const selectedOption = question.options.find((option) => option.selected);
        if (noOption && selectedOption && !noOption.selected) {
          try {
            await setAnswer(page, {
              questionKey: question.key,
              questionText: question.text,
              type: 'radio',
              optionLabel: 'No',
              value: true,
            });
            changed = true;
            break;
          } catch {
            continue;
          }
        }
      }

      if (question.type === 'checkbox') {
        const selected = question.options.find(
          (option) => option.selected && !keepCheckboxOptions.has(`${question.key}:${option.label}`),
        );
        if (selected) {
          try {
            await setAnswer(page, {
              questionKey: question.key,
              questionText: question.text,
              type: 'checkbox',
              optionLabel: selected.label,
              value: false,
            });
            changed = true;
            break;
          } catch {
            continue;
          }
        }
      }
    }

    if (!changed) return;
  }

  throw new Error(`Could not normalize visible questions to path within ${config.maxNormalizePasses} passes.`);
}

async function resetToBaseline(page) {
  for (let pass = 0; pass < config.maxNormalizePasses; pass += 1) {
    const questions = await readQuestions(page);
    let changed = false;

    for (const question of questions) {
      if (question.type === 'radio') {
        const noOption = question.options.find((option) => option.label === 'No');
        const selectedOption = question.options.find((option) => option.selected);
        if (noOption && selectedOption && !noOption.selected) {
          await setAnswer(page, {
            questionKey: question.key,
            questionText: question.text,
            type: 'radio',
            optionLabel: 'No',
            value: true,
          });
          changed = true;
          break;
        }
      }

      if (question.type === 'checkbox') {
        const selected = question.options.find((option) => option.selected);
        if (selected) {
          await setAnswer(page, {
            questionKey: question.key,
            questionText: question.text,
            type: 'checkbox',
            optionLabel: selected.label,
            value: false,
          });
          changed = true;
          break;
        }
      }
    }

    if (!changed) return;
  }

  throw new Error(`Could not reset questionnaire to baseline within ${config.maxNormalizePasses} passes.`);
}

function makeAssignments(question) {
  if (question.type === 'radio') {
    return question.options.map((option) => ({
      questionKey: question.key,
      questionText: question.text,
      type: 'radio',
      optionLabel: option.label,
      value: true,
    }));
  }

  if (question.type === 'checkbox') {
    return question.options.map((option) => ({
      questionKey: question.key,
      questionText: question.text,
      type: 'checkbox',
      optionLabel: option.label,
      value: !option.selected,
    }));
  }

  return [];
}

function selectedRadioOption(question) {
  return question.options.find((option) => option.selected)?.label || null;
}

function questionStateSignature(questions) {
  return questions
    .map((question) => {
      const selected = question.options
        .filter((option) => option.selected)
        .map((option) => option.label)
        .join(',');
      return `${question.key}{${selected}}`;
    })
    .join('|');
}

function stateMatchesExpected(currentQuestions, expectedQuestions) {
  if (currentQuestions.length !== expectedQuestions.length) return false;

  for (let index = 0; index < expectedQuestions.length; index += 1) {
    const current = currentQuestions[index];
    const expected = expectedQuestions[index];
    if (current.key !== expected.key) return false;

    if (expected.type === 'radio') {
      const expectedSelected = expected.options.find((option) => option.selected)?.label || null;
      if (!expectedSelected) continue;
      const currentSelected = current.options.find((option) => option.selected)?.label || null;
      if (expectedSelected === 'No' && !currentSelected) continue;
      if (currentSelected !== expectedSelected) return false;
      continue;
    }

    const expectedSelectedLabels = expected.options
      .filter((option) => option.selected)
      .map((option) => option.label)
      .join(',');
    const currentSelectedLabels = current.options
      .filter((option) => option.selected)
      .map((option) => option.label)
      .join(',');
    if (currentSelectedLabels !== expectedSelectedLabels) return false;
  }

  return true;
}

async function restoreStateIfDirty(page, expectedQuestions, expectedSignature, reason, decisionPath) {
  const current = await readQuestions(page);
  if (stateMatchesExpected(current, expectedQuestions)) return current;

  console.warn(`Dirty backtrack detected after ${reason}; restoring visible state.`);
  const expectedByKey = new Map(expectedQuestions.map((question) => [question.key, question]));

  for (let pass = 0; pass < config.maxNormalizePasses; pass += 1) {
    const questions = await readQuestions(page);
    if (stateMatchesExpected(questions, expectedQuestions)) return questions;

    let changed = false;

    for (const question of questions) {
      const expected = expectedByKey.get(question.key);

      if (question.type === 'radio') {
        const expectedSelected = expected?.options.find((option) => option.selected)?.label || null;
        const currentSelected = question.options.find((option) => option.selected)?.label || null;

        if (expectedSelected && currentSelected !== expectedSelected) {
          await setAnswer(page, {
            questionKey: question.key,
            questionText: question.text,
            type: 'radio',
            optionLabel: expectedSelected,
            value: true,
          });
          changed = true;
          break;
        }

        if (!expected && currentSelected && currentSelected !== 'No') {
          const noOption = question.options.find((option) => option.label === 'No');
          if (noOption) {
            await setAnswer(page, {
              questionKey: question.key,
              questionText: question.text,
              type: 'radio',
              optionLabel: 'No',
              value: true,
            });
            changed = true;
            break;
          }
        }
      }

      if (question.type === 'checkbox') {
        const expectedSelectedLabels = new Set(
          expected?.options.filter((option) => option.selected).map((option) => option.label) || [],
        );
        const mismatched = question.options.find((option) => option.selected !== expectedSelectedLabels.has(option.label));
        if (mismatched) {
          await setAnswer(page, {
            questionKey: question.key,
            questionText: question.text,
            type: 'checkbox',
            optionLabel: mismatched.label,
            value: expectedSelectedLabels.has(mismatched.label),
          });
          changed = true;
          break;
        }
      }
    }

    if (!changed) break;
  }

  const restored = await readQuestions(page);
  if (!stateMatchesExpected(restored, expectedQuestions)) {
    console.warn(`Visible-state restore was not enough after ${reason}; rebuilding current DFS state from category.`);
    await rebuildStateFromCategory(page, decisionPath);
    const rebuilt = await readQuestions(page);
    if (stateMatchesExpected(rebuilt, expectedQuestions)) return rebuilt;

    const restoredSignature = questionStateSignature(rebuilt);
    throw new Error(
      [
        `Restored path signature still differs after ${reason}.`,
        `Expected: ${expectedSignature}`,
        `Actual:   ${restoredSignature}`,
      ].join('\n'),
    );
  }
  return restored;
}

async function backtrackAnswer(page, question, previousRadioLabel, assignment) {
  if (assignment.type === 'checkbox') {
    await setAnswer(page, {
      ...assignment,
      value: !assignment.value,
    });
    return;
  }

  if (assignment.type !== 'radio') return;

  if (previousRadioLabel && previousRadioLabel !== assignment.optionLabel) {
    await setAnswer(page, {
      questionKey: question.key,
      questionText: question.text,
      type: 'radio',
      optionLabel: previousRadioLabel,
      value: true,
    });
    return;
  }

  const noOption = question.options.find((option) => option.label === 'No');
  if (!previousRadioLabel && noOption && assignment.optionLabel !== 'No') {
    await setAnswer(page, {
      questionKey: question.key,
      questionText: question.text,
      type: 'radio',
      optionLabel: 'No',
      value: true,
    });
  }
}

async function discover(page, decisionPath = [], depth = 0, scopeKeys = null) {
  if (states.length >= config.maxStates || probeCount >= config.maxProbes || depth > config.maxDepth) return;

  const before = await readQuestions(page);
  const stateRestorePath = restorePathFromVisibleState(before);
  const activeScopeKeys = scopeKeys || before.map((question) => question.key);
  const activeScope = new Set(activeScopeKeys);
  const key = `${questionStateSignature(before)}::${[...activeScope].sort().join(',')}`;
  if (visitedStates.has(key)) return;
  visitedStates.add(key);

  mergeQuestions(before);
  const scopedQuestions = before.filter((question) => activeScope.has(question.key));
  const beforeKeys = new Set(before.map((question) => question.key));
  const stateSignature = questionStateSignature(before);

  console.log(
    `State ${states.length + 1}: depth=${depth}, path=${decisionPath.length}, visibleQuestions=${before.length}, scope=${scopedQuestions.length}, probes=${probeCount}/${config.maxProbes}`,
  );

  states.push({
    id: states.length + 1,
    depth,
    path: decisionPath,
    restorePath: stateRestorePath,
    scopeQuestionKeys: activeScopeKeys,
    visibleQuestionKeys: [...beforeKeys],
  });

  for (const question of scopedQuestions) {
    const assignments = makeAssignments(question);

    for (const assignment of assignments) {
      if (states.length >= config.maxStates || probeCount >= config.maxProbes) return;
      if (pathAlreadyAnswersQuestion(decisionPath, question, assignment)) continue;
      const probeKey = assignmentKey(assignment);
      if (probedAssignments.has(probeKey)) continue;

      const previousRadioLabel = question.type === 'radio' ? selectedRadioOption(question) : null;
      const expectedSignature = stateSignature;
      probeCount += 1;
      console.log(
        `Probe ${probeCount}/${config.maxProbes}: ${question.key} -> ${assignment.optionLabel}`,
      );
      try {
        await setAnswer(page, assignment);
      } catch (error) {
        console.warn(`Skipped probe: ${question.key} -> ${assignment.optionLabel}: ${error.message}`);
        skippedProbes.push({
          questionKey: question.key,
          questionText: question.text,
          answer: assignment,
          contextPath: decisionPath,
          reason: error.message,
        });
        continue;
      }
      probedAssignments.add(probeKey);

      const after = await readQuestions(page);
      mergeQuestions(after);

      const afterKeys = new Set(after.map((item) => item.key));
      const added = [...afterKeys].filter((item) => !beforeKeys.has(item));
      const removed = [...beforeKeys].filter((item) => !afterKeys.has(item));

      edges.push({
        from: question.key,
        fromText: question.text,
        answer: {
          label: assignment.optionLabel,
          type: assignment.type,
          value: assignment.value,
        },
        contextPath: decisionPath,
        restorePath: stateRestorePath,
        visibleBefore: [...beforeKeys],
        visibleAfter: [...afterKeys],
        added,
        removed,
      });

      if (added.length > 0) {
        await discover(page, [...decisionPath, assignment], depth + 1, added);
      }

      try {
        await backtrackAnswer(page, question, previousRadioLabel, assignment);
      } catch (error) {
        console.warn(`Backtrack warning: ${question.key} -> ${assignment.optionLabel}: ${error.message}`);
      }
      await restoreStateIfDirty(page, before, expectedSignature, `${question.key} -> ${assignment.optionLabel}`, decisionPath);
    }
  }
}

function renderMarkdown(result) {
  const lines = [
    '# Google Play IARC Questionnaire Tree',
    '',
    `Generated at: ${result.generatedAt}`,
    `Category: ${result.category}`,
    `Question count: ${Object.keys(result.questions).length}`,
    `Edge count: ${result.edges.length}`,
    `State count: ${result.states.length}`,
    '',
    '## Questions',
    '',
  ];

  for (const question of Object.values(result.questions).sort((a, b) => a.firstSeenOrder - b.firstSeenOrder)) {
    lines.push(`### ${question.key}`);
    lines.push('');
    lines.push(question.text);
    lines.push('');
    lines.push(`Type: \`${question.type}\``);
    lines.push('');
    for (const option of question.options) {
      lines.push(`- ${option.label}`);
    }
    lines.push('');
  }

  lines.push('## Edges');
  lines.push('');
  for (const edge of result.edges) {
    if (!edge.added.length && !edge.removed.length) continue;
    lines.push(`- \`${edge.from}\` + \`${edge.answer.label}\``);
    if (edge.added.length) lines.push(`  - added: ${edge.added.map((item) => `\`${item}\``).join(', ')}`);
    if (edge.removed.length) lines.push(`  - removed: ${edge.removed.map((item) => `\`${item}\``).join(', ')}`);
  }
  lines.push('');

  return `${lines.join('\n')}\n`;
}

function buildQuestionGraph(result) {
  const graph = {
    generatedAt: result.generatedAt,
    configuredUrl: result.configuredUrl,
    sourceUrl: result.sourceUrl,
    category: result.category,
    roots: [],
    questions: {},
    conflicts: [],
  };

  for (const [key, question] of Object.entries(result.questions)) {
    graph.questions[key] = {
      key,
      text: cleanQuestionText(question.text),
      type: question.type,
      order: question.firstSeenOrder,
      options: Object.fromEntries(
        question.options.map((option) => [
          option.label,
          {
            label: option.label,
            children: [],
          },
        ]),
      ),
    };
  }

  const childKeys = new Set();

  function ensureOption(question, label) {
    if (!question.options[label]) {
      question.options[label] = {
        label,
        children: [],
      };
    }
    return question.options[label];
  }

  function mergeOptionChildren(questionKey, optionLabel, nextChildren, contextPath, inferred = false) {
    const question = graph.questions[questionKey];
    if (!question || !nextChildren.length) return;

    const option = ensureOption(question, optionLabel);
    const existing = option.children;

    if (existing.length === 0) {
      option.children = nextChildren;
    } else {
      const same =
        existing.length === nextChildren.length &&
        existing.every((child, index) => child === nextChildren[index]);

      if (!same) {
        graph.conflicts.push({
          questionKey,
          answer: optionLabel,
          existingChildren: existing,
          newChildren: nextChildren,
          contextPath,
          inferred,
        });
        option.children = [...new Set([...existing, ...nextChildren])];
      }
    }

    for (const child of nextChildren) childKeys.add(child);
  }

  function previousRadioOption(edge) {
    const source = result.questions[edge.from];
    if (!source || edge.answer?.type !== 'radio') return null;

    const selected = source.options.find((option) => option.selected && option.label !== edge.answer.label);
    if (selected) return selected.label;

    const otherOptions = source.options.filter((option) => option.label !== edge.answer.label);
    return otherOptions.length === 1 ? otherOptions[0].label : null;
  }

  for (const edge of result.edges) {
    if (!edge.added.length) continue;

    mergeOptionChildren(edge.from, edge.answer.label, [...new Set(edge.added)], edge.contextPath);
  }

  for (const edge of result.edges) {
    if (edge.answer?.type !== 'checkbox' || edge.answer?.value !== false || !edge.removed?.length) continue;

    const removedChildren = [...new Set(edge.removed)].filter((child) => graph.questions[child]);
    mergeOptionChildren(edge.from, edge.answer.label, removedChildren, edge.contextPath, true);
  }

  for (const edge of result.edges) {
    if (!edge.removed?.length) continue;

    const optionLabel = previousRadioOption(edge);
    if (!optionLabel) continue;

    const inferredChildren = [...new Set(edge.removed)].filter((child) => graph.questions[child]);
    mergeOptionChildren(edge.from, optionLabel, inferredChildren, edge.contextPath, true);
  }

  for (const question of Object.values(graph.questions)) {
    for (const option of Object.values(question.options)) {
      const directChildren = new Set(option.children);
      if (!directChildren.size) continue;
      option.children = option.children.filter((child) => {
        for (const possibleParent of directChildren) {
          if (possibleParent === child) continue;
          const parentQuestion = graph.questions[possibleParent];
          if (!parentQuestion) continue;
          if (Object.values(parentQuestion.options).some((parentOption) => parentOption.children.includes(child))) {
            return false;
          }
        }
        return true;
      });
    }
  }

  graph.roots = Object.keys(graph.questions)
    .filter((key) => !childKeys.has(key))
    .sort((a, b) => {
      const qa = result.questions[a]?.firstSeenOrder ?? 0;
      const qb = result.questions[b]?.firstSeenOrder ?? 0;
      return qa - qb;
    });

  return graph;
}

function renderGraphMarkdown(graph) {
  const lines = [
    '# Google Play IARC Question Graph',
    '',
    `Generated at: ${graph.generatedAt}`,
    `Category: ${graph.category}`,
    `Question count: ${Object.keys(graph.questions).length}`,
    `Root count: ${graph.roots.length}`,
    `Conflict count: ${graph.conflicts.length}`,
    '',
    '## Roots',
    '',
    ...graph.roots.map((root) => `- \`${root}\``),
    '',
    '## Questions',
    '',
  ];

  for (const key of Object.keys(graph.questions)) {
    const question = graph.questions[key];
    lines.push(`### ${key}`);
    lines.push('');
    lines.push(question.text);
    lines.push('');
    lines.push(`Type: \`${question.type}\``);
    lines.push('');

    for (const option of Object.values(question.options)) {
      lines.push(`- ${option.label}`);
      if (option.children.length) {
        lines.push(`  - children: ${option.children.map((child) => `\`${child}\``).join(', ')}`);
      }
    }
    lines.push('');
  }

  if (graph.conflicts.length) {
    lines.push('## Conflicts');
    lines.push('');
    for (const conflict of graph.conflicts) {
      lines.push(`- \`${conflict.questionKey}\` / \`${conflict.answer}\``);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

async function main() {
  await mkdir(config.outDir, { recursive: true });

  const { page, close, shouldNavigate } = await openBrowserPage();
  page.setDefaultTimeout(15_000);

  if (shouldNavigate) {
    await page.goto(config.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  }

  await discardChangesIfRequested(page);

  if (config.listCategories) {
    const labels = await readCategoryLabels(page);
    console.log(JSON.stringify(labels, null, 2));
    await close();
    return;
  }

  if (config.selectCategory) {
    await ensureCategorySelectionStep(page);
    await chooseCategoryAndTerms(page);
  }

  await ensureQuestionnaireStep(page);
  const actualSourceUrl = page.url();

  await resetToBaseline(page);
  await discover(page);
  await resetToBaseline(page).catch((error) => {
    console.warn(`Warning: could not reset questionnaire after traversal: ${error.message}`);
  });

  const questions = {};
  let order = 0;
  for (const [key, value] of seenQuestions) {
    questions[key] = {
      ...value,
      firstSeenOrder: order,
    };
    order += 1;
  }

  const result = {
    generatedAt: new Date().toISOString(),
    configuredUrl: config.url,
    sourceUrl: actualSourceUrl,
    category: config.category,
    traversalConfig: config,
    questions,
    edges,
    states,
    skippedProbes,
  };
  const graph = buildQuestionGraph(result);

  const jsonPath = `${config.outDir}/questionnaire_tree.json`;
  const mdPath = `${config.outDir}/questionnaire_tree.md`;
  const graphJsonPath = `${config.outDir}/question_graph.json`;
  const graphMdPath = `${config.outDir}/question_graph.md`;
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(mdPath, renderMarkdown(result));
  await writeFile(graphJsonPath, `${JSON.stringify(graph, null, 2)}\n`);
  await writeFile(graphMdPath, renderGraphMarkdown(graph));

  console.log(`Saved ${Object.keys(questions).length} questions, ${edges.length} edges, ${states.length} states.`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${mdPath}`);
  console.log(`Graph JSON: ${graphJsonPath}`);
  console.log(`Graph Markdown: ${graphMdPath}`);

  await close();
}

async function openBrowserPage() {
  if (config.cdpUrl) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(config.cdpUrl);
    } catch (error) {
      throw new Error(
        [
          `Could not connect to Chrome DevTools at ${config.cdpUrl}.`,
          '',
          'Start the dedicated real Chrome first:',
          '  bash scripts/open_debug_chrome.sh',
          '',
          'Then run:',
          '  EXPECTED_GOOGLE_ACCOUNT="mengshu0715@gmail.com" CDP_URL="http://127.0.0.1:9222" npm run inspect:questionnaire',
          '',
          `Original error: ${error.message}`,
        ].join('\n'),
      );
    }
    const context = browser.contexts()[0] || await browser.newContext();
    const existing = context.pages().find((candidate) => candidate.url().includes('/content-rating-iarc-questionnaire'));
    const page = existing || context.pages()[0] || await context.newPage();
    return {
      page,
      shouldNavigate: config.forceGoto || !existing,
      close: async () => {
        if (typeof browser.disconnect === 'function') {
          browser.disconnect();
        }
      },
    };
  }

  const launchOptions = {
    headless: config.headless,
    viewport: { width: 1440, height: 1100 },
  };
  if (config.browserChannel) launchOptions.channel = config.browserChannel;

  const context = await chromium.launchPersistentContext(config.profileDir, launchOptions);
  const page = context.pages()[0] || await context.newPage();
  return {
    page,
    shouldNavigate: true,
    close: async () => {
      await context.close();
    },
  };
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
