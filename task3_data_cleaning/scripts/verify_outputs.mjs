import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, '..');
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(PROJECT_DIR, 'output'));
const SOURCE_DIR = path.resolve(
  process.env.SOURCE_DATASET_DIR || path.join(PROJECT_DIR, '..', 'dataset_v2'),
);
const REPOSITORY_DIR = path.resolve(SOURCE_DIR, '..');
const INACTIVE_VALUE = '__INACTIVE__';
const NOT_APPLICABLE_VALUE = '__NOT_APPLICABLE__';
const EMPTY_SELECTION_VALUE = '__NONE__';
const CATEGORY_SLUGS = {
  'All Other App Types': 'all_other_app_types',
  Game: 'game',
  'Social or Communication': 'social_or_communication',
};
const TERRITORIES = [
  'Australia',
  'Brazil',
  'Europe',
  'Germany',
  'North America',
  'Rest of world',
  'Russia',
  'Saudi Arabia',
  'South Korea',
  'Taiwan',
];
const GAME_ONLY_TERRITORIES = new Set(['Australia', 'Saudi Arabia', 'Taiwan']);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const input = text.replace(/^\uFEFF/, '');
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell.replace(/\r$/, ''));
      if (row.some((value) => value !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [headers, ...data] = rows;
  return {
    headers,
    rows: data.map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])),
    ),
  };
}

async function readCsv(name) {
  return parseCsv(await readFile(path.join(OUTPUT_DIR, name), 'utf8'));
}

async function readJsonLines(file) {
  const text = await readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function sha256File(file) {
  const bytes = await readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function slug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function selectedAnswer(question) {
  const selected = question.options.filter((option) => option.selected).map((option) => option.label);
  if (question.type === 'checkbox') {
    return selected.length ? selected.join(' || ') : EMPTY_SELECTION_VALUE;
  }
  return selected[0] || '';
}

function hashOrder(sampleId, seed) {
  return crypto.createHash('sha256').update(`${seed}\0${sampleId}`).digest('hex');
}

function expectedSplitMap(rows, testRatio, seed) {
  const strata = new Map();
  for (const row of rows) {
    const northAmerica = row.ratings.find((rating) => rating.territory === 'North America')?.label;
    const key = `${row.category}\0${northAmerica}`;
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(row);
  }
  const testIds = new Set();
  for (const group of strata.values()) {
    group.sort((left, right) => {
      const order = hashOrder(left.sampleId, seed).localeCompare(hashOrder(right.sampleId, seed));
      return order || left.sampleId.localeCompare(right.sampleId);
    });
    const rawCount = Math.round(group.length * testRatio);
    const testCount =
      group.length < 2 ? 0 : Math.max(1, Math.min(group.length - 1, rawCount));
    for (const row of group.slice(0, testCount)) testIds.add(row.sampleId);
  }
  return new Map(rows.map((row) => [row.sampleId, testIds.has(row.sampleId) ? 'test' : 'train']));
}

function assert(condition, message, errors) {
  if (!condition) errors.push(message);
}

function assertEqual(actual, expected, message, errors) {
  if (actual !== expected) errors.push(`${message}: expected ${expected}, found ${actual}`);
}

async function main() {
  const [
    clean,
    train,
    test,
    metadata,
    details,
    dictionary,
    exclusions,
    distribution,
    reportText,
    columnGroupsText,
    sourceRows,
  ] = await Promise.all([
    readCsv('clean_dataset.csv'),
    readCsv('train.csv'),
    readCsv('test.csv'),
    readCsv('sample_metadata.csv'),
    readCsv('rating_details.csv'),
    readCsv('data_dictionary.csv'),
    readCsv('excluded_samples.csv'),
    readCsv('split_distribution.csv'),
    readFile(path.join(OUTPUT_DIR, 'cleaning_report.json'), 'utf8'),
    readFile(path.join(OUTPUT_DIR, 'column_groups.json'), 'utf8'),
    readJsonLines(path.join(SOURCE_DIR, 'samples.jsonl')),
  ]);
  const report = JSON.parse(reportText);
  const columnGroups = JSON.parse(columnGroupsText);
  const graphs = Object.fromEntries(
    await Promise.all(
      Object.entries(CATEGORY_SLUGS).map(async ([category, categorySlug]) => [
        category,
        JSON.parse(
          await readFile(
            path.join(REPOSITORY_DIR, 'data_categories', categorySlug, 'question_graph.json'),
            'utf8',
          ),
        ),
      ]),
    ),
  );
  const errors = [];

  assertEqual(
    await sha256File(path.join(SOURCE_DIR, 'samples.jsonl')),
    report.sourceHashes.samplesJsonl,
    'source samples hash changed after build',
    errors,
  );
  assertEqual(sourceRows.length, report.counts.sourceRows, 'source row count mismatch', errors);
  assertEqual(
    new Set(sourceRows.map((row) => row.sampleId)).size,
    sourceRows.length,
    'source contains duplicate sample IDs',
    errors,
  );
  for (const [category, categorySlug] of Object.entries(CATEGORY_SLUGS)) {
    assertEqual(
      await sha256File(
        path.join(REPOSITORY_DIR, 'data_categories', categorySlug, 'question_graph.json'),
      ),
      report.sourceHashes.questionGraphs?.[category],
      `${category} question graph hash changed after build`,
      errors,
    );
  }
  assertEqual(clean.rows.length, report.counts.cleanRows, 'clean row count mismatch', errors);
  assertEqual(train.rows.length, report.counts.trainRows, 'train row count mismatch', errors);
  assertEqual(test.rows.length, report.counts.testRows, 'test row count mismatch', errors);
  assertEqual(
    train.rows.length + test.rows.length,
    clean.rows.length,
    'train plus test count mismatch',
    errors,
  );
  assert(
    JSON.stringify(train.headers) === JSON.stringify(test.headers),
    'train and test headers differ',
    errors,
  );
  assert(
    clean.headers.filter((header) => header !== 'split').join('\0') === train.headers.join('\0'),
    'clean headers do not match train/test after removing split',
    errors,
  );

  const questionDefinitions = new Map();
  for (const [category, graph] of Object.entries(graphs)) {
    for (const question of Object.values(graph.questions || {})) {
      if (!questionDefinitions.has(question.key)) {
        questionDefinitions.set(question.key, { categories: new Set() });
      }
      questionDefinitions.get(question.key).categories.add(category);
    }
  }
  const questionIds = [...questionDefinitions.keys()].sort();
  const answerHeaders = questionIds.map((questionId) => `answer__${questionId}`);
  const ratingHeaders = TERRITORIES.map((territory) => `rating__${slug(territory)}`);
  const expectedModelHeaders = ['sample_id', 'category', ...answerHeaders, ...ratingHeaders];
  assert(
    JSON.stringify(train.headers) === JSON.stringify(expectedModelHeaders),
    'train/test columns do not match graph-derived schema',
    errors,
  );
  assertEqual(
    answerHeaders.length,
    report.counts.uniqueQuestionColumns,
    'question column count mismatch',
    errors,
  );
  assertEqual(
    ratingHeaders.length,
    report.counts.ratingLabelColumns,
    'rating column count mismatch',
    errors,
  );

  const cleanMap = new Map();
  for (const row of clean.rows) {
    assert(!cleanMap.has(row.sample_id), `duplicate clean sample_id ${row.sample_id}`, errors);
    cleanMap.set(row.sample_id, row);
    for (const header of [...answerHeaders, ...ratingHeaders]) {
      assert(row[header] !== '', `${row.sample_id}: blank normalized value in ${header}`, errors);
    }
  }
  const sourceMap = new Map(sourceRows.map((row) => [row.sampleId, row]));
  const retainedSourceRows = [];
  for (const [sampleId, flat] of cleanMap) {
    const source = sourceMap.get(sampleId);
    assert(Boolean(source), `${sampleId}: clean row missing from source JSONL`, errors);
    if (!source) continue;
    retainedSourceRows.push(source);
    assertEqual(flat.category, source.category, `${sampleId}: category mismatch`, errors);
    const questionMap = new Map(
      source.questionStates.map((question) => [question.questionId, question]),
    );
    for (const questionId of questionIds) {
      const question = questionMap.get(questionId);
      const expected = question
        ? selectedAnswer(question)
        : questionDefinitions.get(questionId).categories.has(source.category)
          ? INACTIVE_VALUE
          : NOT_APPLICABLE_VALUE;
      assertEqual(
        flat[`answer__${questionId}`],
        expected,
        `${sampleId}: answer mismatch for ${questionId}`,
        errors,
      );
    }
    const ratingMap = new Map(source.ratings.map((rating) => [rating.territory, rating]));
    for (const territory of TERRITORIES) {
      const rating = ratingMap.get(territory);
      const expected = rating
        ? cleanText(rating.label)
        : GAME_ONLY_TERRITORIES.has(territory) && source.category !== 'Game'
          ? NOT_APPLICABLE_VALUE
          : '';
      assertEqual(
        flat[`rating__${slug(territory)}`],
        expected,
        `${sampleId}: rating mismatch for ${territory}`,
        errors,
      );
    }
  }
  assertEqual(
    retainedSourceRows.length,
    clean.rows.length,
    'clean rows could not all be linked to source',
    errors,
  );

  const expectedSplits = expectedSplitMap(
    retainedSourceRows,
    report.splitRules.testRatio,
    report.splitRules.seed,
  );
  const trainMap = new Map(train.rows.map((row) => [row.sample_id, row]));
  const testMap = new Map(test.rows.map((row) => [row.sample_id, row]));
  for (const flat of clean.rows) {
    const expectedSplit = expectedSplits.get(flat.sample_id);
    assertEqual(flat.split, expectedSplit, `${flat.sample_id}: deterministic split mismatch`, errors);
    const splitRow = expectedSplit === 'train' ? trainMap.get(flat.sample_id) : testMap.get(flat.sample_id);
    assert(Boolean(splitRow), `${flat.sample_id}: missing from ${expectedSplit}.csv`, errors);
    if (splitRow) {
      for (const header of expectedModelHeaders) {
        assertEqual(
          splitRow[header],
          flat[header],
          `${flat.sample_id}: ${expectedSplit}.csv mismatch for ${header}`,
          errors,
        );
      }
    }
  }
  assert(
    [...trainMap.keys()].every((sampleId) => !testMap.has(sampleId)),
    'train and test sample IDs overlap',
    errors,
  );

  const metadataMap = new Map(metadata.rows.map((row) => [row.sample_id, row]));
  assertEqual(metadataMap.size, metadata.rows.length, 'metadata contains duplicate sample IDs', errors);
  for (const source of retainedSourceRows) {
    const row = metadataMap.get(source.sampleId);
    assert(Boolean(row), `${source.sampleId}: metadata row missing`, errors);
    if (!row) continue;
    assertEqual(row.split, expectedSplits.get(source.sampleId), `${source.sampleId}: metadata split`, errors);
    assertEqual(row.category, source.category, `${source.sampleId}: metadata category`, errors);
    assertEqual(row.sampling_strategy, source.strategy, `${source.sampleId}: metadata strategy`, errors);
    assertEqual(
      row.state_source,
      source.provenance?.stateSource || '',
      `${source.sampleId}: metadata state source`,
      errors,
    );
    assertEqual(
      row.source_result_dir,
      source.provenance?.sourceResultDir || '',
      `${source.sampleId}: metadata source directory`,
      errors,
    );
  }
  assertEqual(metadata.rows.length, clean.rows.length, 'metadata row count mismatch', errors);

  const detailMap = new Map(
    details.rows.map((row) => [`${row.sample_id}\0${row.territory}`, row]),
  );
  assertEqual(detailMap.size, details.rows.length, 'rating details contain duplicate keys', errors);
  let expectedDetailRows = 0;
  for (const source of retainedSourceRows) {
    for (const rating of source.ratings) {
      expectedDetailRows += 1;
      const row = detailMap.get(`${source.sampleId}\0${rating.territory}`);
      assert(Boolean(row), `${source.sampleId}: missing rating detail ${rating.territory}`, errors);
      if (!row) continue;
      assertEqual(row.rating_label, cleanText(rating.label), `${source.sampleId}: detail label`, errors);
      assertEqual(
        row.content_descriptors,
        cleanText(rating.contentDescriptorText),
        `${source.sampleId}: detail descriptors`,
        errors,
      );
      assertEqual(
        row.interactive_elements,
        (rating.interactiveElements || []).join(' || '),
        `${source.sampleId}: detail interactive elements`,
        errors,
      );
      assertEqual(row.warning, cleanText(rating.warning), `${source.sampleId}: detail warning`, errors);
    }
  }
  assertEqual(details.rows.length, expectedDetailRows, 'rating detail row count mismatch', errors);
  assertEqual(details.rows.length, report.counts.ratingDetailRows, 'reported detail count mismatch', errors);

  assertEqual(
    dictionary.rows.length,
    2 + answerHeaders.length + ratingHeaders.length,
    'data dictionary row count mismatch',
    errors,
  );
  const dictionaryMap = new Map(dictionary.rows.map((row) => [row.column_name, row]));
  for (const header of answerHeaders) {
    assertEqual(dictionaryMap.get(header)?.role, 'raw_feature_candidate', `${header}: dictionary role`, errors);
    assertEqual(dictionaryMap.get(header)?.nullable, 'no', `${header}: dictionary nullable`, errors);
  }
  for (const header of ratingHeaders) {
    assertEqual(dictionaryMap.get(header)?.role, 'raw_target_candidate', `${header}: dictionary role`, errors);
    assertEqual(dictionaryMap.get(header)?.nullable, 'no', `${header}: dictionary nullable`, errors);
  }

  assert(
    JSON.stringify(columnGroups.rawFeatureColumns) ===
      JSON.stringify(['category', ...answerHeaders]),
    'column_groups rawFeatureColumns mismatch',
    errors,
  );
  assert(
    JSON.stringify(columnGroups.rawTargetColumns) === JSON.stringify(ratingHeaders),
    'column_groups rawTargetColumns mismatch',
    errors,
  );
  assert(
    ratingHeaders.every((header) => columnGroups.columnsNeverToUseAsFeatures.includes(header)),
    'column_groups does not exclude every target from features',
    errors,
  );

  const expectedExclusions =
    report.counts.task3ExcludedRows +
    report.counts.upstreamValidationQuarantineRows +
    report.counts.upstreamRatingConflictRows;
  assertEqual(exclusions.rows.length, expectedExclusions, 'exclusion audit row count mismatch', errors);
  assert(distribution.rows.length > 0, 'split_distribution.csv is empty', errors);
  assertEqual(
    report.missingValuePolicy.unexpectedBlankOutputCells,
    0,
    'report contains unexpected blank output cells',
    errors,
  );

  const digest = await sha256File(path.join(OUTPUT_DIR, 'clean_dataset.csv'));
  const result = {
    valid: errors.length === 0,
    cleanRows: clean.rows.length,
    trainRows: train.rows.length,
    testRows: test.rows.length,
    answerColumns: answerHeaders.length,
    ratingColumns: ratingHeaders.length,
    inactiveAnswerCells: report.missingValuePolicy.inactiveAnswerCells,
    notApplicableAnswerCells: report.missingValuePolicy.notApplicableAnswerCells,
    ratingDetailRows: details.rows.length,
    exclusionAuditRows: exclusions.rows.length,
    cleanDatasetSha256: digest,
    errors: errors.slice(0, 100),
    omittedErrorCount: Math.max(0, errors.length - 100),
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
