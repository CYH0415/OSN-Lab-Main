import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATASET_DIR = process.env.DATASET_V2_OUT_DIR || 'dataset_v2';

async function readJsonLines(file) {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${index + 1}: invalid JSON: ${error.message}`);
      }
    });
}

function stateSignature(sample) {
  return JSON.stringify([
    sample.category,
    [...sample.questionStates]
      .sort((left, right) => left.questionId.localeCompare(right.questionId))
      .map((question) => [
        question.questionId,
        question.options.map((option) => [option.label, Boolean(option.selected)]).sort(),
      ]),
  ]);
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseSummaryCategory(value) {
  const text = cleanText(value);
  const ratingsStart = text.indexOf('Your ratings');
  const summary = ratingsStart === -1 ? text : text.slice(0, ratingsStart);
  const pattern = /(?:^|\s)Category (Social or Communication|All Other App Types|Game)(?=\s|$)/g;
  let category = '';
  for (const match of summary.matchAll(pattern)) category = match[1];
  return category;
}

function evidenceKey(sampleId, sourceResultDir) {
  return `${sourceResultDir}::${sampleId}`;
}

function expectedTerritories(category) {
  const common = [
    'Brazil',
    'North America',
    'Europe',
    'Germany',
    'Rest of world',
    'Russia',
    'South Korea',
  ];
  return category === 'Game'
    ? ['Australia', 'Brazil', 'North America', 'South Korea', 'Taiwan', 'Saudi Arabia', 'Europe', 'Germany', 'Rest of world', 'Russia']
    : common;
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

async function main() {
  const file = path.join(ROOT, DATASET_DIR, 'samples.jsonl');
  const samples = await readJsonLines(file);
  const evidenceFile = path.join(ROOT, DATASET_DIR, 'debug_evidence.jsonl');
  const evidence = existsSync(evidenceFile) ? await readJsonLines(evidenceFile) : [];
  const evidenceCategories = new Map();
  for (const row of evidence) {
    const category = row.summaryCategory || parseSummaryCategory(row.bodyText);
    if (!category) continue;
    const key = evidenceKey(row.sampleId, row.sourceResultDir);
    if (!evidenceCategories.has(key)) evidenceCategories.set(key, new Set());
    evidenceCategories.get(key).add(category);
  }
  const errors = [];
  const signatures = new Set();
  const ids = new Set();
  const byCategory = {};
  const byStateSource = {};

  for (const [index, sample] of samples.entries()) {
    const prefix = `row ${index + 1} (${sample.sampleId || 'missing sampleId'})`;
    assert(sample.schemaVersion === 2, `${prefix}: schemaVersion must be 2`, errors);
    assert(Boolean(sample.sampleId), `${prefix}: missing sampleId`, errors);
    assert(Boolean(sample.category), `${prefix}: missing category`, errors);
    assert(Array.isArray(sample.questionStates) && sample.questionStates.length > 0, `${prefix}: empty questionStates`, errors);
    assert(Array.isArray(sample.ratings) && sample.ratings.length > 0, `${prefix}: empty ratings`, errors);
    assert(!ids.has(sample.sampleId), `${prefix}: duplicate sampleId`, errors);
    ids.add(sample.sampleId);

    const questionIds = new Set();
    for (const question of sample.questionStates || []) {
      assert(Boolean(question.questionId), `${prefix}: question missing questionId`, errors);
      assert(!questionIds.has(question.questionId), `${prefix}: duplicate question ${question.questionId}`, errors);
      questionIds.add(question.questionId);
      assert(Array.isArray(question.options) && question.options.length > 0, `${prefix}: question ${question.questionId} has no options`, errors);
      const selected = (question.options || []).filter((option) => option.selected);
      if (question.type === 'radio') {
        assert(selected.length === 1, `${prefix}: radio ${question.questionId} has ${selected.length} selections`, errors);
      }
      for (const option of question.options || []) {
        assert(typeof option.selected === 'boolean', `${prefix}: option selection is not boolean`, errors);
        assert(option.source === 'target' || option.source === 'baseline', `${prefix}: invalid option source`, errors);
      }
    }

    for (const rating of sample.ratings || []) {
      assert(Boolean(rating.territory), `${prefix}: rating missing territory`, errors);
      assert(Boolean(rating.label), `${prefix}: rating missing label`, errors);
      assert(!('raw' in rating), `${prefix}: raw rating evidence leaked into primary dataset`, errors);
    }
    const expected = expectedTerritories(sample.category).sort();
    const actual = (sample.ratings || []).map((rating) => rating.territory).sort();
    assert(
      JSON.stringify(actual) === JSON.stringify(expected),
      `${prefix}: rating territories do not match ${sample.category}`,
      errors,
    );

    const key = evidenceKey(sample.sampleId, sample.provenance?.sourceResultDir);
    const summaryCategories = [...(evidenceCategories.get(key) || [])];
    assert(summaryCategories.length === 1, `${prefix}: expected exactly one Summary category`, errors);
    if (summaryCategories.length === 1) {
      assert(
        summaryCategories[0] === sample.category,
        `${prefix}: Summary category is ${summaryCategories[0]}, expected ${sample.category}`,
        errors,
      );
    }

    const signature = stateSignature(sample);
    assert(!signatures.has(signature), `${prefix}: duplicate semantic questionnaire state`, errors);
    signatures.add(signature);
    byCategory[sample.category] = (byCategory[sample.category] || 0) + 1;
    const source = sample.provenance?.stateSource || 'missing';
    byStateSource[source] = (byStateSource[source] || 0) + 1;
  }

  const report = {
    valid: errors.length === 0,
    samples: samples.length,
    uniqueSampleIds: ids.size,
    uniqueSemanticStates: signatures.size,
    byCategory,
    byStateSource,
    errors: errors.slice(0, 100),
    omittedErrorCount: Math.max(0, errors.length - 100),
  };
  assert(samples.length >= 1000, `dataset contains only ${samples.length} samples`, errors);
  report.valid = errors.length === 0;
  report.errors = errors.slice(0, 100);
  report.omittedErrorCount = Math.max(0, errors.length - 100);
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
