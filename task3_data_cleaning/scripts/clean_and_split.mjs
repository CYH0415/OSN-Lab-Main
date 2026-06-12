import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(SCRIPT_DIR, '..');
const SOURCE_DIR = path.resolve(
  process.env.SOURCE_DATASET_DIR || path.join(PROJECT_DIR, '..', 'dataset_v2'),
);
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || path.join(PROJECT_DIR, 'output'));
const TEST_RATIO = Number(process.env.TEST_RATIO || 0.2);
const SPLIT_SEED = process.env.SPLIT_SEED || 'osn-lab2-task3-v1';
const INACTIVE_VALUE = '__INACTIVE__';
const NOT_APPLICABLE_VALUE = '__NOT_APPLICABLE__';
const EMPTY_SELECTION_VALUE = '__NONE__';

const CATEGORY_ORDER = ['All Other App Types', 'Game', 'Social or Communication'];
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
const COMMON_TERRITORIES = [
  'Brazil',
  'North America',
  'Europe',
  'Germany',
  'Rest of world',
  'Russia',
  'South Korea',
];

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function slug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header])).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

async function readJsonLines(file) {
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${file}:${index + 1}: invalid JSON: ${error.message}`);
      }
    });
}

async function sha256File(file) {
  if (!existsSync(file)) return null;
  const bytes = await readFile(file);
  return crypto.createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function expectedTerritories(category) {
  return category === 'Game'
    ? [
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
      ]
    : COMMON_TERRITORIES;
}

function stateSignature(row) {
  return JSON.stringify([
    row.category,
    [...row.questionStates]
      .sort((left, right) => left.questionId.localeCompare(right.questionId))
      .map((question) => [
        question.questionId,
        [...question.options]
          .sort((left, right) => left.label.localeCompare(right.label))
          .map((option) => [option.label, Boolean(option.selected)]),
      ]),
  ]);
}

function ratingSignature(row) {
  return [...row.ratings]
    .sort((left, right) => left.territory.localeCompare(right.territory))
    .map((rating) => `${rating.territory}=${cleanText(rating.label)}`)
    .join('|');
}

function validateRow(row, graph) {
  const errors = [];
  if (row.schemaVersion !== 2) errors.push('schema_version_not_2');
  if (!cleanText(row.sampleId)) errors.push('missing_sample_id');
  if (!CATEGORY_ORDER.includes(row.category)) errors.push('invalid_category');
  if (!Array.isArray(row.questionStates) || !row.questionStates.length) {
    errors.push('missing_question_states');
  }
  if (!Array.isArray(row.ratings) || !row.ratings.length) errors.push('missing_ratings');
  if (!graph) errors.push('missing_category_question_graph');
  if (errors.length) return errors;

  const questionMap = new Map();
  for (const question of row.questionStates) {
    if (!cleanText(question.questionId)) {
      errors.push('question_missing_id');
      continue;
    }
    if (questionMap.has(question.questionId)) {
      errors.push(`duplicate_question:${question.questionId}`);
    }
    questionMap.set(question.questionId, question);
    const graphQuestion = graph.questions?.[question.questionId];
    if (!graphQuestion) {
      errors.push(`question_not_in_graph:${question.questionId}`);
    }
    if (!['radio', 'checkbox'].includes(question.type)) {
      errors.push(`invalid_question_type:${question.questionId}`);
    }
    if (graphQuestion && graphQuestion.type !== question.type) {
      errors.push(`question_type_mismatch:${question.questionId}`);
    }
    if (!Array.isArray(question.options) || !question.options.length) {
      errors.push(`question_missing_options:${question.questionId}`);
      continue;
    }
    const optionLabels = new Set();
    for (const option of question.options) {
      if (!cleanText(option.label)) errors.push(`option_missing_label:${question.questionId}`);
      if (optionLabels.has(option.label)) {
        errors.push(`duplicate_option:${question.questionId}:${option.label}`);
      }
      optionLabels.add(option.label);
      if (typeof option.selected !== 'boolean') {
        errors.push(`invalid_selection_flag:${question.questionId}:${option.label}`);
      }
      if (graphQuestion && !graphQuestion.options?.[option.label]) {
        errors.push(`option_not_in_graph:${question.questionId}:${option.label}`);
      }
    }
    if (graphQuestion) {
      const actualOptions = [...optionLabels].sort();
      const expectedOptions = Object.keys(graphQuestion.options || {}).sort();
      if (JSON.stringify(actualOptions) !== JSON.stringify(expectedOptions)) {
        errors.push(`question_option_set_mismatch:${question.questionId}`);
      }
    }
    const selectedCount = question.options.filter((option) => option.selected).length;
    if (question.type === 'radio' && selectedCount !== 1) {
      errors.push(`radio_selection_count:${question.questionId}:${selectedCount}`);
    }
  }

  for (const answer of row.explicitAnswers || []) {
    const question = questionMap.get(answer.questionId);
    const option = question?.options?.find((candidate) => candidate.label === answer.optionLabel);
    if (!question || !option) {
      errors.push(`explicit_answer_not_in_state:${answer.questionId}:${answer.optionLabel}`);
    } else if (answer.value === false ? option.selected : !option.selected) {
      errors.push(`explicit_answer_selection_mismatch:${answer.questionId}:${answer.optionLabel}`);
    }
  }

  const active = new Set(graph.roots || []);
  const processed = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const questionId of [...active]) {
      if (processed.has(questionId)) continue;
      const question = questionMap.get(questionId);
      if (!question) {
        errors.push(`missing_active_question:${questionId}`);
        processed.add(questionId);
        continue;
      }
      const graphQuestion = graph.questions?.[questionId];
      for (const option of question.options.filter((candidate) => candidate.selected)) {
        for (const child of graphQuestion?.options?.[option.label]?.children || []) {
          if (!active.has(child)) {
            active.add(child);
            changed = true;
          }
        }
      }
      processed.add(questionId);
      changed = true;
    }
  }
  for (const questionId of questionMap.keys()) {
    if (!active.has(questionId)) errors.push(`inactive_question_present:${questionId}`);
  }

  const actualTerritories = row.ratings.map((rating) => rating.territory).sort();
  const expected = [...expectedTerritories(row.category)].sort();
  if (JSON.stringify(actualTerritories) !== JSON.stringify(expected)) {
    errors.push('territory_set_mismatch');
  }
  const seenTerritories = new Set();
  for (const rating of row.ratings) {
    if (seenTerritories.has(rating.territory)) {
      errors.push(`duplicate_rating_territory:${rating.territory}`);
    }
    seenTerritories.add(rating.territory);
    if (!cleanText(rating.label)) errors.push(`missing_rating_label:${rating.territory}`);
  }
  return [...new Set(errors)];
}

function preferredEntry(entries) {
  return [...entries].sort((left, right) => {
    const leftMeasured = left.row.provenance?.stateSource === 'browser_snapshot' ? 1 : 0;
    const rightMeasured = right.row.provenance?.stateSource === 'browser_snapshot' ? 1 : 0;
    if (leftMeasured !== rightMeasured) return rightMeasured - leftMeasured;
    if (left.row.questionStates.length !== right.row.questionStates.length) {
      return right.row.questionStates.length - left.row.questionStates.length;
    }
    const idOrder = left.row.sampleId.localeCompare(right.row.sampleId);
    return idOrder || left.index - right.index;
  })[0];
}

function selectedAnswer(question) {
  const selected = question.options.filter((option) => option.selected).map((option) => option.label);
  if (question.type === 'checkbox') {
    return selected.length ? selected.join(' || ') : EMPTY_SELECTION_VALUE;
  }
  return selected[0] || '';
}

function hashOrder(sampleId) {
  return crypto
    .createHash('sha256')
    .update(`${SPLIT_SEED}\0${sampleId}`)
    .digest('hex');
}

function assignSplits(rows) {
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
      const order = hashOrder(left.sampleId).localeCompare(hashOrder(right.sampleId));
      return order || left.sampleId.localeCompare(right.sampleId);
    });
    const rawCount = Math.round(group.length * TEST_RATIO);
    const testCount =
      group.length < 2 ? 0 : Math.max(1, Math.min(group.length - 1, rawCount));
    for (const row of group.slice(0, testCount)) testIds.add(row.sampleId);
  }
  return new Map(rows.map((row) => [row.sampleId, testIds.has(row.sampleId) ? 'test' : 'train']));
}

function collectDistribution(rows, splitMap) {
  const counts = new Map();
  function increment(dimension, value, split) {
    const key = `${dimension}\0${value}`;
    if (!counts.has(key)) counts.set(key, { dimension, value, train: 0, test: 0 });
    counts.get(key)[split] += 1;
  }

  for (const row of rows) {
    const split = splitMap.get(row.sampleId);
    const northAmerica = row.ratings.find((rating) => rating.territory === 'North America')?.label;
    increment('category', row.category, split);
    increment('north_america_rating', northAmerica, split);
    increment('state_source', row.provenance?.stateSource || '', split);
    increment('category_x_north_america_rating', `${row.category} | ${northAmerica}`, split);
  }

  return [...counts.values()]
    .map((item) => ({
      dimension: item.dimension,
      value: item.value,
      total: item.train + item.test,
      train: item.train,
      test: item.test,
      test_ratio: ((item.test / (item.train + item.test)) || 0).toFixed(6),
    }))
    .sort(
      (left, right) =>
        left.dimension.localeCompare(right.dimension) || left.value.localeCompare(right.value),
    );
}

async function main() {
  if (!(TEST_RATIO > 0 && TEST_RATIO < 1)) {
    throw new Error(`TEST_RATIO must be between 0 and 1; received ${TEST_RATIO}`);
  }

  const sourceFiles = {
    samples: path.join(SOURCE_DIR, 'samples.jsonl'),
    schema: path.join(SOURCE_DIR, 'schema.json'),
    coverageReport: path.join(SOURCE_DIR, 'coverage_report.json'),
    validationQuarantine: path.join(SOURCE_DIR, 'validation_quarantine.jsonl'),
    ratingConflicts: path.join(SOURCE_DIR, 'rating_conflicts.jsonl'),
    failures: path.join(SOURCE_DIR, 'failures.jsonl'),
  };
  const repositoryDir = path.resolve(SOURCE_DIR, '..');
  const graphFiles = Object.fromEntries(
    Object.entries(CATEGORY_SLUGS).map(([category, categorySlug]) => [
      category,
      path.join(repositoryDir, 'data_categories', categorySlug, 'question_graph.json'),
    ]),
  );
  if (!existsSync(sourceFiles.samples)) {
    throw new Error(`Source dataset not found: ${sourceFiles.samples}`);
  }
  for (const [category, graphFile] of Object.entries(graphFiles)) {
    if (!existsSync(graphFile)) {
      throw new Error(`Question graph not found for ${category}: ${graphFile}`);
    }
  }

  const sourceRows = await readJsonLines(sourceFiles.samples);
  const validationQuarantine = await readJsonLines(sourceFiles.validationQuarantine);
  const ratingConflicts = await readJsonLines(sourceFiles.ratingConflicts);
  const failures = await readJsonLines(sourceFiles.failures);
  const graphs = Object.fromEntries(
    await Promise.all(
      Object.entries(graphFiles).map(async ([category, graphFile]) => [
        category,
        JSON.parse(await readFile(graphFile, 'utf8')),
      ]),
    ),
  );

  const exclusions = [];
  const prelim = [];
  for (const [index, row] of sourceRows.entries()) {
    const reasons = validateRow(row, graphs[row.category]);
    if (reasons.length) {
      exclusions.push({
        exclusion_stage: 'task3_validation',
        sample_id: row.sampleId || '',
        category: row.category || '',
        reason: reasons.join(' || '),
        source_file: 'samples.jsonl',
      });
    } else {
      prelim.push({ row, index });
    }
  }

  const afterIdDedup = [];
  const idGroups = new Map();
  for (const entry of prelim) {
    if (!idGroups.has(entry.row.sampleId)) idGroups.set(entry.row.sampleId, []);
    idGroups.get(entry.row.sampleId).push(entry);
  }
  for (const entries of idGroups.values()) {
    if (entries.length === 1) {
      afterIdDedup.push(entries[0]);
      continue;
    }
    const states = new Set(entries.map((entry) => stateSignature(entry.row)));
    const ratings = new Set(entries.map((entry) => ratingSignature(entry.row)));
    if (states.size > 1 || ratings.size > 1) {
      for (const entry of entries) {
        exclusions.push({
          exclusion_stage: 'task3_duplicate_id_conflict',
          sample_id: entry.row.sampleId,
          category: entry.row.category,
          reason: `duplicate sample_id with ${states.size} states and ${ratings.size} rating sets`,
          source_file: 'samples.jsonl',
        });
      }
      continue;
    }
    const retained = preferredEntry(entries);
    afterIdDedup.push(retained);
    for (const entry of entries) {
      if (entry !== retained) {
        exclusions.push({
          exclusion_stage: 'task3_duplicate_id_exact',
          sample_id: entry.row.sampleId,
          category: entry.row.category,
          reason: 'exact duplicate sample_id, questionnaire state, and rating labels',
          source_file: 'samples.jsonl',
        });
      }
    }
  }

  const retainedEntries = [];
  const stateGroups = new Map();
  for (const entry of afterIdDedup) {
    const signature = stateSignature(entry.row);
    if (!stateGroups.has(signature)) stateGroups.set(signature, []);
    stateGroups.get(signature).push(entry);
  }
  for (const entries of stateGroups.values()) {
    const ratings = new Set(entries.map((entry) => ratingSignature(entry.row)));
    if (ratings.size > 1) {
      for (const entry of entries) {
        exclusions.push({
          exclusion_stage: 'task3_rating_conflict',
          sample_id: entry.row.sampleId,
          category: entry.row.category,
          reason: `same questionnaire state produced ${ratings.size} rating label sets`,
          source_file: 'samples.jsonl',
        });
      }
      continue;
    }
    const retained = preferredEntry(entries);
    retainedEntries.push(retained);
    for (const entry of entries) {
      if (entry !== retained) {
        exclusions.push({
          exclusion_stage: 'task3_duplicate_semantic_state',
          sample_id: entry.row.sampleId,
          category: entry.row.category,
          reason: `duplicate of retained sample ${retained.row.sampleId}`,
          source_file: 'samples.jsonl',
        });
      }
    }
  }

  const rows = retainedEntries.map((entry) => entry.row);
  rows.sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  const splitMap = assignSplits(rows);

  const questionDefinitions = new Map();
  for (const [category, graph] of Object.entries(graphs)) {
    for (const question of Object.values(graph.questions || {})) {
      if (!questionDefinitions.has(question.key)) {
        questionDefinitions.set(question.key, {
          questionId: question.key,
          questionText: question.text,
          questionType: question.type,
          categories: new Set(),
          options: new Set(),
          minOrder: question.order,
        });
      }
      const definition = questionDefinitions.get(question.key);
      if (
        definition.questionText !== question.text ||
        definition.questionType !== question.type
      ) {
        throw new Error(`Inconsistent graph definition for shared question ${question.key}`);
      }
      definition.categories.add(category);
      definition.minOrder = Math.min(definition.minOrder, question.order);
      for (const option of Object.values(question.options || {})) {
        definition.options.add(option.label);
      }
    }
  }
  const questionIds = [...questionDefinitions.keys()].sort();
  const answerHeaders = questionIds.map((questionId) => `answer__${questionId}`);
  const ratingHeaders = TERRITORIES.map((territory) => `rating__${slug(territory)}`);
  const modelHeaders = ['sample_id', 'category', ...answerHeaders, ...ratingHeaders];
  const cleanHeaders = ['sample_id', 'split', 'category', ...answerHeaders, ...ratingHeaders];

  function flatten(row, includeSplit) {
    const questionMap = new Map(row.questionStates.map((question) => [question.questionId, question]));
    const ratingMap = new Map(row.ratings.map((rating) => [rating.territory, rating]));
    const flat = {
      sample_id: row.sampleId,
      category: row.category,
    };
    if (includeSplit) flat.split = splitMap.get(row.sampleId);
    for (const questionId of questionIds) {
      const question = questionMap.get(questionId);
      const definition = questionDefinitions.get(questionId);
      flat[`answer__${questionId}`] = question
        ? selectedAnswer(question)
        : definition.categories.has(row.category)
          ? INACTIVE_VALUE
          : NOT_APPLICABLE_VALUE;
    }
    for (const territory of TERRITORIES) {
      const rating = ratingMap.get(territory);
      flat[`rating__${slug(territory)}`] = rating
        ? cleanText(rating.label)
        : GAME_ONLY_TERRITORIES.has(territory) && row.category !== 'Game'
          ? NOT_APPLICABLE_VALUE
          : '';
    }
    return flat;
  }

  const cleanRows = rows.map((row) => flatten(row, true));
  const trainRows = rows
    .filter((row) => splitMap.get(row.sampleId) === 'train')
    .map((row) => flatten(row, false));
  const testRows = rows
    .filter((row) => splitMap.get(row.sampleId) === 'test')
    .map((row) => flatten(row, false));

  const metadataRows = rows.map((row) => ({
    sample_id: row.sampleId,
    split: splitMap.get(row.sampleId),
    category: row.category,
    sampling_strategy: row.strategy,
    state_source: row.provenance?.stateSource || '',
    source_result_dir: row.provenance?.sourceResultDir || '',
    source_schema_version: row.provenance?.sourceSchemaVersion ?? '',
  }));

  const ratingDetailRows = [];
  for (const row of rows) {
    for (const rating of row.ratings) {
      ratingDetailRows.push({
        sample_id: row.sampleId,
        split: splitMap.get(row.sampleId),
        category: row.category,
        territory: rating.territory,
        authority: cleanText(rating.authority),
        rating_label: cleanText(rating.label),
        content_descriptors: cleanText(rating.contentDescriptorText),
        interactive_elements: (rating.interactiveElements || []).join(' || '),
        warning: cleanText(rating.warning),
      });
    }
  }

  const dictionaryRows = [
    {
      column_name: 'sample_id',
      role: 'identifier',
      data_type: 'string',
      nullable: 'no',
      source_field: 'sampleId',
      question_id: '',
      question_type: '',
      applicable_categories: CATEGORY_ORDER.join(' || '),
      allowed_values: '',
      missing_meaning: '',
      description: 'Stable sample identifier; exclude from model features.',
    },
    {
      column_name: 'category',
      role: 'raw_feature_candidate',
      data_type: 'categorical string',
      nullable: 'no',
      source_field: 'category',
      question_id: '',
      question_type: '',
      applicable_categories: CATEGORY_ORDER.join(' || '),
      allowed_values: CATEGORY_ORDER.join(' || '),
      missing_meaning: '',
      description: 'Questionnaire category. Encoding belongs to task 4.',
    },
  ];
  for (const questionId of questionIds) {
    const definition = questionDefinitions.get(questionId);
    const allowedValues = [...definition.options].sort();
    if (definition.questionType === 'checkbox') allowedValues.push(EMPTY_SELECTION_VALUE);
    allowedValues.push(INACTIVE_VALUE);
    if (definition.categories.size < CATEGORY_ORDER.length) {
      allowedValues.push(NOT_APPLICABLE_VALUE);
    }
    dictionaryRows.push({
      column_name: `answer__${questionId}`,
      role: 'raw_feature_candidate',
      data_type: 'categorical string',
      nullable: 'no',
      source_field: 'questionStates.options[selected=true]',
      question_id: questionId,
      question_type: definition.questionType,
      applicable_categories: CATEGORY_ORDER.filter((category) =>
        definition.categories.has(category),
      ).join(' || '),
      allowed_values: allowedValues.join(' || '),
      missing_meaning: `${INACTIVE_VALUE}=branch inactive; ${NOT_APPLICABLE_VALUE}=question not used by category; ${EMPTY_SELECTION_VALUE}=active checkbox with no selection.`,
      description: cleanText(definition.questionText),
    });
  }
  for (const territory of TERRITORIES) {
    dictionaryRows.push({
      column_name: `rating__${slug(territory)}`,
      role: 'raw_target_candidate',
      data_type: 'categorical string',
      nullable: 'no',
      source_field: `ratings[territory=${territory}].label`,
      question_id: '',
      question_type: '',
      applicable_categories: GAME_ONLY_TERRITORIES.has(territory)
        ? 'Game'
        : CATEGORY_ORDER.join(' || '),
      allowed_values: [
        ...new Set(
          rows
            .map((row) => row.ratings.find((rating) => rating.territory === territory)?.label)
            .filter(Boolean),
        ),
      ]
        .sort()
        .concat(GAME_ONLY_TERRITORIES.has(territory) ? [NOT_APPLICABLE_VALUE] : [])
        .join(' || '),
      missing_meaning: GAME_ONLY_TERRITORIES.has(territory)
        ? `${NOT_APPLICABLE_VALUE}=territory is not returned for non-Game categories.`
        : '',
      description: `Raw age rating label for ${territory}; label encoding belongs to task 4.`,
    });
  }

  for (const row of validationQuarantine) {
    exclusions.push({
      exclusion_stage: 'upstream_validation_quarantine',
      sample_id: row.sampleId || '',
      category: row.category || '',
      reason: (row.validation?.reasons || ['upstream validation failure']).join(' || '),
      source_file: 'validation_quarantine.jsonl',
    });
  }
  for (const row of ratingConflicts) {
    exclusions.push({
      exclusion_stage: 'upstream_rating_conflict',
      sample_id: row.sampleId || '',
      category: row.category || '',
      reason: `same questionnaire state had ${row.conflict?.ratingSignatures?.length || 0} rating label sets`,
      source_file: 'rating_conflicts.jsonl',
    });
  }
  exclusions.sort(
    (left, right) =>
      left.exclusion_stage.localeCompare(right.exclusion_stage) ||
      left.sample_id.localeCompare(right.sample_id),
  );

  const distributionRows = collectDistribution(rows, splitMap);
  const task3Exclusions = exclusions.filter((row) => row.exclusion_stage.startsWith('task3_'));
  const categoryQuestionPairs = [...questionDefinitions.values()].reduce(
    (sum, definition) => sum + definition.categories.size,
    0,
  );
  const inactiveAnswerCells = cleanRows.reduce(
    (sum, row) =>
      sum + answerHeaders.filter((header) => row[header] === INACTIVE_VALUE).length,
    0,
  );
  const notApplicableAnswerCells = cleanRows.reduce(
    (sum, row) =>
      sum + answerHeaders.filter((header) => row[header] === NOT_APPLICABLE_VALUE).length,
    0,
  );
  const activeCheckboxNoSelectionCells = cleanRows.reduce(
    (sum, row) =>
      sum + answerHeaders.filter((header) => row[header] === EMPTY_SELECTION_VALUE).length,
    0,
  );
  const unexpectedBlankOutputCells = cleanRows.reduce(
    (sum, row) =>
      sum +
      [...answerHeaders, ...ratingHeaders].filter((header) => row[header] === '').length,
    0,
  );
  const columnGroups = {
    identifierColumns: ['sample_id'],
    splitColumns: ['split'],
    rawFeatureColumns: ['category', ...answerHeaders],
    rawTargetColumns: ratingHeaders,
    columnsNeverToUseAsFeatures: ['sample_id', ...ratingHeaders],
    missingValueSentinels: {
      inactiveBranch: INACTIVE_VALUE,
      notApplicable: NOT_APPLICABLE_VALUE,
      activeCheckboxNoSelection: EMPTY_SELECTION_VALUE,
    },
    leakageWarning:
      'All rating__* columns are outputs of the same questionnaire. When predicting any rating label, exclude every rating__* column from model features.',
    checkboxSerialization: {
      separator: ' || ',
      note: 'Multiple selected labels are joined in questionnaire option order. Split only checkbox columns listed in data_dictionary.csv.',
    },
  };

  const report = {
    generatedAt: new Date().toISOString(),
    sourceDatasetDir: SOURCE_DIR,
    outputDir: OUTPUT_DIR,
    sourceHashes: {
      samplesJsonl: await sha256File(sourceFiles.samples),
      schemaJson: await sha256File(sourceFiles.schema),
      coverageReportJson: await sha256File(sourceFiles.coverageReport),
      validationQuarantineJsonl: await sha256File(sourceFiles.validationQuarantine),
      ratingConflictsJsonl: await sha256File(sourceFiles.ratingConflicts),
      questionGraphs: Object.fromEntries(
        await Promise.all(
          Object.entries(graphFiles).map(async ([category, graphFile]) => [
            category,
            await sha256File(graphFile),
          ]),
        ),
      ),
    },
    cleaningRules: {
      requiredSchemaVersion: 2,
      validateQuestionSelections: true,
      validateExplicitAnswers: true,
      validateQuestionGraphReachability: true,
      validateCategorySpecificTerritories: true,
      duplicateKey: 'complete semantic questionnaire state',
      conflictingRatings: 'exclude all rows in the conflicting state group',
      inactiveQuestionValue: INACTIVE_VALUE,
      notApplicableValue: NOT_APPLICABLE_VALUE,
      activeCheckboxWithNoSelection: EMPTY_SELECTION_VALUE,
      imputation: 'none',
    },
    splitRules: {
      method: 'deterministic stratified holdout',
      strata: ['category', 'North America rating label'],
      testRatio: TEST_RATIO,
      seed: SPLIT_SEED,
      smallStratumRule: 'a one-row stratum stays in train; other strata retain at least one train row',
    },
    counts: {
      sourceRows: sourceRows.length,
      task3ExcludedRows: task3Exclusions.length,
      cleanRows: rows.length,
      trainRows: trainRows.length,
      testRows: testRows.length,
      uniqueQuestionColumns: questionIds.length,
      categoryQuestionPairs,
      ratingLabelColumns: ratingHeaders.length,
      ratingDetailRows: ratingDetailRows.length,
      upstreamValidationQuarantineRows: validationQuarantine.length,
      upstreamRatingConflictRows: ratingConflicts.length,
      upstreamFailureEvents: failures.length,
    },
    missingValuePolicy: {
      inactiveAnswerCells,
      notApplicableAnswerCells,
      activeCheckboxNoSelectionCells,
      notApplicableGameOnlyRatingCells:
        rows.filter((row) => row.category !== 'Game').length * GAME_ONLY_TERRITORIES.size,
      unexpectedBlankOutputCells,
      unexpectedMissingCommonRatingLabels: rows.reduce(
        (sum, row) =>
          sum +
          COMMON_TERRITORIES.filter(
            (territory) => !cleanText(row.ratings.find((rating) => rating.territory === territory)?.label),
          ).length,
        0,
      ),
    },
    outputFiles: [
      'clean_dataset.csv',
      'train.csv',
      'test.csv',
      'sample_metadata.csv',
      'rating_details.csv',
      'data_dictionary.csv',
      'split_distribution.csv',
      'excluded_samples.csv',
      'cleaning_report.json',
      'cleaning_report.md',
      'column_groups.json',
    ],
  };

  const reportMarkdown = `# Task 3 Data Cleaning Report

Generated: ${report.generatedAt}

## Result

- Source rows: ${report.counts.sourceRows}
- Additional rows excluded by task 3: ${report.counts.task3ExcludedRows}
- Clean rows: ${report.counts.cleanRows}
- Train rows: ${report.counts.trainRows}
- Test rows: ${report.counts.testRows}
- Unified question columns: ${report.counts.uniqueQuestionColumns}
- Category-question pairs represented: ${report.counts.categoryQuestionPairs}
- Rating label columns: ${report.counts.ratingLabelColumns}

## Cleaning

The pipeline validates schema version, required fields, radio selections, explicit-answer
consistency, questionnaire-graph reachability, category-specific rating territories, duplicate
sample IDs, duplicate semantic questionnaire states, and conflicting rating labels. No
statistical imputation is performed.

\`${INACTIVE_VALUE}\` means that a question belongs to the category but was not activated by the
selected branch. \`${NOT_APPLICABLE_VALUE}\` means that the question or rating territory does not
apply to the category. An active checkbox with no selected option is represented as
\`${EMPTY_SELECTION_VALUE}\`. The cleaned answer and rating columns contain no blank cells.

## Split

The split is a deterministic train/test = ${Math.round(
    (1 - TEST_RATIO) * 100,
  )}/${Math.round(TEST_RATIO * 100)} holdout, stratified by questionnaire category and North
America/ESRB rating label.
Seed: \`${SPLIT_SEED}\`.

Task 4 may create a validation set from \`train.csv\`; \`test.csv\` should remain untouched until
final evaluation. No one-hot encoding, category mapping, label encoding, resampling, or feature
selection is performed here.

All \`rating__*\` columns are targets. They must all be excluded from model features, including
when only one territory is selected as the prediction target; otherwise cross-territory labels
would cause target leakage. See \`column_groups.json\`.

## Source integrity

- samples.jsonl SHA-256: \`${report.sourceHashes.samplesJsonl}\`
- Upstream validation quarantine rows: ${report.counts.upstreamValidationQuarantineRows}
- Upstream rating-conflict rows: ${report.counts.upstreamRatingConflictRows}
- Upstream failure events: ${report.counts.upstreamFailureEvents}
`;

  await mkdir(OUTPUT_DIR, { recursive: true });
  await Promise.all([
    writeFile(path.join(OUTPUT_DIR, 'clean_dataset.csv'), toCsv(cleanHeaders, cleanRows), 'utf8'),
    writeFile(path.join(OUTPUT_DIR, 'train.csv'), toCsv(modelHeaders, trainRows), 'utf8'),
    writeFile(path.join(OUTPUT_DIR, 'test.csv'), toCsv(modelHeaders, testRows), 'utf8'),
    writeFile(
      path.join(OUTPUT_DIR, 'sample_metadata.csv'),
      toCsv(
        [
          'sample_id',
          'split',
          'category',
          'sampling_strategy',
          'state_source',
          'source_result_dir',
          'source_schema_version',
        ],
        metadataRows,
      ),
      'utf8',
    ),
    writeFile(
      path.join(OUTPUT_DIR, 'rating_details.csv'),
      toCsv(
        [
          'sample_id',
          'split',
          'category',
          'territory',
          'authority',
          'rating_label',
          'content_descriptors',
          'interactive_elements',
          'warning',
        ],
        ratingDetailRows,
      ),
      'utf8',
    ),
    writeFile(
      path.join(OUTPUT_DIR, 'data_dictionary.csv'),
      toCsv(
        [
          'column_name',
          'role',
          'data_type',
          'nullable',
          'source_field',
          'question_id',
          'question_type',
          'applicable_categories',
          'allowed_values',
          'missing_meaning',
          'description',
        ],
        dictionaryRows,
      ),
      'utf8',
    ),
    writeFile(
      path.join(OUTPUT_DIR, 'split_distribution.csv'),
      toCsv(['dimension', 'value', 'total', 'train', 'test', 'test_ratio'], distributionRows),
      'utf8',
    ),
    writeFile(
      path.join(OUTPUT_DIR, 'excluded_samples.csv'),
      toCsv(
        ['exclusion_stage', 'sample_id', 'category', 'reason', 'source_file'],
        exclusions,
      ),
      'utf8',
    ),
    writeFile(
      path.join(OUTPUT_DIR, 'cleaning_report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    ),
    writeFile(path.join(OUTPUT_DIR, 'cleaning_report.md'), reportMarkdown, 'utf8'),
    writeFile(
      path.join(OUTPUT_DIR, 'column_groups.json'),
      `${JSON.stringify(columnGroups, null, 2)}\n`,
      'utf8',
    ),
  ]);

  console.log(
    JSON.stringify(
      {
        source: sourceFiles.samples,
        output: OUTPUT_DIR,
        cleanRows: rows.length,
        trainRows: trainRows.length,
        testRows: testRows.length,
        task3ExcludedRows: task3Exclusions.length,
        questionColumns: questionIds.length,
        ratingColumns: ratingHeaders.length,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
