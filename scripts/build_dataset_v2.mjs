import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  RATING_AUTONOMOUS_DIR,
  RATING_RESULT_ROOT,
} from './rating_artifact_paths.mjs';

const ROOT = process.cwd();
const OUT_DIR = process.env.DATASET_V2_OUT_DIR || 'dataset_v2';
const RESULT_ROOT = process.env.RATING_RESULT_ROOT || RATING_RESULT_ROOT;
const AUTONOMOUS_DIR = process.env.AUTONOMOUS_OUT_DIR || RATING_AUTONOMOUS_DIR;
const EXCLUDED_RESULT_DIRS = new Set([
  'rating_results_structural',
  'rating_results_structural_v2',
  'rating_results_goal1000_summary',
]);

const CATEGORY_SLUGS = {
  Game: 'game',
  'All Other App Types': 'all_other_app_types',
  'Social or Communication': 'social_or_communication',
};

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/\s+check_circle$/g, '').trim();
}

async function readJsonLines(file) {
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function explicitAnswersOf(row) {
  return row.explicitAnswers || row.applied || row.answers || [];
}

function compactRating(rating) {
  const descriptorText = cleanText(rating.contentDescriptorText || rating.contentDescriptors || '');
  const interactiveMarker = 'Interactive elements ';
  const markerIndex = descriptorText.indexOf(interactiveMarker);
  const contentDescriptorText = cleanText(
    markerIndex === -1 ? descriptorText : descriptorText.slice(0, markerIndex),
  );
  const interactiveText = cleanText(
    markerIndex === -1 ? '' : descriptorText.slice(markerIndex + interactiveMarker.length),
  );
  const interactiveElements = [
    'Users Interact',
    'Shares Location',
    'Unrestricted Internet',
    'In-App Purchases (Includes Random Items)',
    'In-Game Purchases (Includes Random Items)',
    'In-App Purchases',
    'In-Game Purchases',
  ].filter((label) => interactiveText.includes(label));

  const compact = {
    territory: rating.territory,
    authority: cleanText(rating.authority),
    label: cleanText(rating.label || rating.rating),
    contentDescriptorText: contentDescriptorText === '-' ? '' : contentDescriptorText,
    interactiveElements,
  };
  const warning = cleanText(rating.warning);
  if (warning) compact.warning = warning;
  return compact;
}

function ratingsOf(row) {
  return (row.ratings || row.result?.ratings || []).map(compactRating);
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

function hasExpectedTerritories(category, ratings) {
  const expected = expectedTerritories(category).sort();
  const actual = ratings.map((rating) => rating.territory).sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function reconstructQuestionStates(graph, explicitAnswers) {
  const explicitByQuestion = new Map();
  for (const answer of explicitAnswers) {
    if (!explicitByQuestion.has(answer.questionId)) explicitByQuestion.set(answer.questionId, []);
    explicitByQuestion.get(answer.questionId).push(answer);
  }

  const active = new Set(graph.roots);
  const processed = new Set();
  const states = [];
  let changed = true;

  while (changed) {
    changed = false;
    const activeQuestions = [...active]
      .map((key) => graph.questions[key])
      .filter(Boolean)
      .sort((a, b) => a.order - b.order);

    for (const question of activeQuestions) {
      if (processed.has(question.key)) continue;
      const explicit = explicitByQuestion.get(question.key) || [];
      const options = Object.values(question.options || {});
      let optionStates;

      if (question.type === 'radio') {
        const target = explicit.find((answer) => answer.value !== false);
        const selectedLabel =
          target?.optionLabel || options.find((option) => option.label === 'No')?.label || options[0]?.label || '';
        optionStates = options.map((option) => ({
          label: option.label,
          selected: option.label === selectedLabel,
          source: target?.optionLabel === option.label ? 'target' : 'baseline',
        }));
      } else {
        const explicitValues = new Map(explicit.map((answer) => [answer.optionLabel, Boolean(answer.value)]));
        optionStates = options.map((option) => ({
          label: option.label,
          selected: explicitValues.get(option.label) || false,
          source: explicitValues.has(option.label) ? 'target' : 'baseline',
        }));
      }

      states.push({
        questionId: question.key,
        questionText: question.text,
        type: question.type,
        order: question.order,
        options: optionStates,
      });
      processed.add(question.key);
      changed = true;

      for (const optionState of optionStates.filter((option) => option.selected)) {
        for (const child of question.options?.[optionState.label]?.children || []) {
          if (!active.has(child)) {
            active.add(child);
            changed = true;
          }
        }
      }
    }
  }

  return states.sort((a, b) => a.order - b.order);
}

function stateSignature(category, questionStates) {
  return `${category}|${[...questionStates]
    .sort((left, right) => left.questionId.localeCompare(right.questionId))
    .map((question) => {
      const options = question.options
        .map((option) => `${option.label}=${option.selected ? 1 : 0}`)
        .sort()
        .join(',');
      return `${question.questionId}[${options}]`;
    })
    .join('|')}`;
}

function ratingSignature(ratings) {
  return ratings
    .map((rating) => `${rating.territory}=${rating.label}`)
    .sort()
    .join('|');
}

function preferredRow(current, candidate) {
  if (!current) return candidate;
  const currentMeasured = current.provenance.stateSource === 'browser_snapshot';
  const candidateMeasured = candidate.provenance.stateSource === 'browser_snapshot';
  if (candidateMeasured !== currentMeasured) return candidateMeasured ? candidate : current;
  if (candidate.questionStates.length !== current.questionStates.length) {
    return candidate.questionStates.length > current.questionStates.length ? candidate : current;
  }
  return current;
}

async function main() {
  const resultSources = [];
  const resultRoot = path.resolve(ROOT, RESULT_ROOT);
  if (existsSync(resultRoot)) {
    const entries = await readdir(resultRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        entry.name.startsWith('rating_results') &&
        !EXCLUDED_RESULT_DIRS.has(entry.name)
      ) {
        resultSources.push({
          id: entry.name,
          directory: path.join(resultRoot, entry.name),
        });
      }
    }
  }
  const autonomousDir = path.resolve(ROOT, AUTONOMOUS_DIR);
  if (existsSync(autonomousDir)) {
    resultSources.push({
      id: 'rating_autonomous',
      directory: autonomousDir,
    });
  }
  resultSources.sort((left, right) => left.id.localeCompare(right.id));

  const graphs = {};
  for (const [category, slug] of Object.entries(CATEGORY_SLUGS)) {
    graphs[category] = JSON.parse(
      await readFile(path.join(ROOT, 'data_categories', slug, 'question_graph.json'), 'utf8'),
    );
  }

  const normalized = [];
  const evidence = [];
  const failures = [];

  for (const source of resultSources) {
    const dir = source.id;
    for (const row of await readJsonLines(path.join(source.directory, 'results.jsonl'))) {
      const graph = graphs[row.category];
      if (!graph || !ratingsOf(row).length) continue;
      const explicitAnswers = explicitAnswersOf(row);
      const hasSnapshot = Array.isArray(row.questionStates) && row.questionStates.length > 0;
      const questionStates = hasSnapshot
        ? row.questionStates
        : reconstructQuestionStates(graph, explicitAnswers);
      normalized.push({
        schemaVersion: 2,
        sampleId: row.sampleId,
        category: row.category,
        strategy: row.strategy || 'unknown',
        explicitAnswers,
        questionStates,
        ratings: ratingsOf(row),
        provenance: {
          stateSource: hasSnapshot ? 'browser_snapshot' : 'reconstructed_from_graph_and_baseline',
          sourceResultDir: dir,
          sourceSchemaVersion: row.schemaVersion || 1,
          ...(row.provenance?.upgradedFrom ? { upgradedFrom: row.provenance.upgradedFrom } : {}),
          ...(row.provenance?.ratingChangedOnReplay
            ? { ratingChangedOnReplay: true }
            : {}),
        },
      });
      const bodyText = row.result?.bodyText;
      const rawRatings = (row.result?.ratings || []).map(({ territory, raw }) => ({ territory, raw }));
      if (bodyText || rawRatings.some((rating) => rating.raw)) {
        evidence.push({
          sampleId: row.sampleId,
          sourceResultDir: dir,
          url: row.result?.url || '',
          title: row.result?.title || '',
          bodyText: bodyText || '',
          rawRatings,
        });
      }
    }

    for (const row of await readJsonLines(path.join(source.directory, 'evidence.jsonl'))) {
      evidence.push({ ...row, sourceResultDir: dir });
    }

    for (const failure of await readJsonLines(path.join(source.directory, 'errors.jsonl'))) {
      failures.push({ ...failure, sourceResultDir: dir });
    }
  }

  const evidenceCategories = new Map();
  for (const row of evidence) {
    const category = row.summaryCategory || parseSummaryCategory(row.bodyText);
    if (!category) continue;
    const key = evidenceKey(row.sampleId, row.sourceResultDir);
    if (!evidenceCategories.has(key)) evidenceCategories.set(key, new Set());
    evidenceCategories.get(key).add(category);
  }

  const validationQuarantine = [];
  const eligibleRows = normalized.filter((row) => {
    const key = evidenceKey(row.sampleId, row.provenance.sourceResultDir);
    const summaryCategories = [...(evidenceCategories.get(key) || [])];
    const reasons = [];
    if (summaryCategories.length !== 1) {
      reasons.push(
        summaryCategories.length
          ? `ambiguous_summary_categories:${summaryCategories.join(',')}`
          : 'missing_summary_category_evidence',
      );
    } else if (summaryCategories[0] !== row.category) {
      reasons.push(`summary_category_mismatch:${summaryCategories[0]}`);
    }
    if (!hasExpectedTerritories(row.category, row.ratings)) {
      reasons.push(`territory_set_mismatch:${row.ratings.map((rating) => rating.territory).join(',')}`);
    }
    if (!reasons.length) return true;
    validationQuarantine.push({
      ...row,
      validation: {
        reasons,
        summaryCategories,
      },
    });
    return false;
  });

  const groups = new Map();
  for (const row of eligibleRows) {
    const signature = stateSignature(row.category, row.questionStates);
    if (!groups.has(signature)) {
      groups.set(signature, {
        retained: row,
        duplicates: [],
        ratingSignatures: new Set(),
        hasVerifiedUpgrade: false,
      });
    }
    const group = groups.get(signature);
    const isVerifiedUpgrade = Boolean(row.provenance?.upgradedFrom);
    if (isVerifiedUpgrade) {
      group.ratingSignatures = new Set([ratingSignature(row.ratings)]);
      group.hasVerifiedUpgrade = true;
    } else if (!group.hasVerifiedUpgrade) {
      group.ratingSignatures.add(ratingSignature(row.ratings));
    }
    const retained = preferredRow(group.retained, row);
    if (retained !== group.retained) {
      group.duplicates.push(group.retained);
      group.retained = retained;
    } else if (row !== group.retained) {
      group.duplicates.push(row);
    }
  }

  const conflictingGroups = [...groups.values()].filter((group) => group.ratingSignatures.size > 1);
  const conflictSet = new Set(conflictingGroups);
  const samples = [...groups.values()]
    .filter((group) => !conflictSet.has(group))
    .map((group) => group.retained);
  const duplicateRows = [...groups.values()].reduce((sum, group) => sum + group.duplicates.length, 0);
  const conflictRows = conflictingGroups.flatMap((group) =>
    [group.retained, ...group.duplicates].map((row) => ({
      ...row,
      conflict: {
        stateSignature: stateSignature(row.category, row.questionStates),
        ratingSignatures: [...group.ratingSignatures],
      },
    })),
  );

  const optionCoverage = new Map();
  const targetOptionCoverage = new Map();
  const questionExposure = new Map();
  for (const sample of samples) {
    for (const question of sample.questionStates) {
      const questionKey = `${sample.category}|${question.questionId}`;
      questionExposure.set(questionKey, (questionExposure.get(questionKey) || 0) + 1);
      for (const option of question.options) {
        if (!option.selected) continue;
        const optionKey = `${sample.category}|${question.questionId}|${option.label}`;
        optionCoverage.set(optionKey, (optionCoverage.get(optionKey) || 0) + 1);
        if (option.source === 'target') {
          targetOptionCoverage.set(optionKey, (targetOptionCoverage.get(optionKey) || 0) + 1);
        }
      }
    }
  }

  const coverageRows = [...optionCoverage.entries()]
    .map(([key, count]) => {
      const [category, questionId, optionLabel] = key.split('|');
      return { category, questionId, optionLabel, count };
    })
    .sort((a, b) => a.count - b.count || a.category.localeCompare(b.category));
  const targetCoverageRows = [...targetOptionCoverage.entries()]
    .map(([key, count]) => {
      const [category, questionId, optionLabel] = key.split('|');
      return { category, questionId, optionLabel, count };
    })
    .sort((a, b) => a.count - b.count || a.category.localeCompare(b.category));

  const byCategory = {};
  const byStateSource = {};
  const byRating = {};
  for (const sample of samples) {
    byCategory[sample.category] = (byCategory[sample.category] || 0) + 1;
    byStateSource[sample.provenance.stateSource] =
      (byStateSource[sample.provenance.stateSource] || 0) + 1;
    const esrb = sample.ratings.find((rating) => rating.territory === 'North America');
    if (esrb) byRating[esrb.label] = (byRating[esrb.label] || 0) + 1;
  }

  const coverageReport = {
    generatedAt: new Date().toISOString(),
    rawSuccessfulRows: normalized.length,
    rowsEligibleAfterEvidenceValidation: eligibleRows.length,
    validationRowsQuarantined: validationQuarantine.length,
    semanticallyUniqueStatesBeforeConflictFilter: groups.size,
    semanticUniqueSamples: samples.length,
    duplicateRowsRemoved: duplicateRows,
    conflictingRatingGroups: conflictingGroups.length,
    conflictingRowsQuarantined: conflictRows.length,
    failureEventsArchived: failures.length,
    byCategory,
    byStateSource,
    esrbDistribution: byRating,
    selectedOptionVariants: coverageRows.length,
    selectedOptionSingletons: coverageRows.filter((row) => row.count === 1).length,
    selectedOptionsAtMostFive: coverageRows.filter((row) => row.count <= 5).length,
    lowFrequencySelectedOptions: coverageRows.filter((row) => row.count <= 5),
    targetSelectedOptionVariants: targetCoverageRows.length,
    targetSelectedOptionSingletons: targetCoverageRows.filter((row) => row.count === 1).length,
    targetSelectedOptionsAtMostFive: targetCoverageRows.filter((row) => row.count <= 5).length,
    lowFrequencyTargetSelectedOptions: targetCoverageRows.filter((row) => row.count <= 5),
    questionExposure: [...questionExposure.entries()]
      .map(([key, count]) => {
        const [category, questionId] = key.split('|');
        return { category, questionId, count };
      })
      .sort((a, b) => a.count - b.count),
    conflicts: conflictingGroups.map((group) => ({
      retainedSampleId: group.retained.sampleId,
      ratingSignatures: [...group.ratingSignatures],
      duplicateSampleIds: group.duplicates.map((row) => row.sampleId),
    })),
  };

  const schema = {
    schemaVersion: 2,
    sample: {
      sampleId: 'string',
      category: 'Game | All Other App Types | Social or Communication',
      strategy: 'string',
      explicitAnswers: 'Answer[]',
      questionStates: 'QuestionState[]; complete active questionnaire state',
      ratings: 'Rating[]; compact structured labels without webpage text',
      provenance: {
        stateSource: 'browser_snapshot | reconstructed_from_graph_and_baseline',
        sourceResultDir: 'string',
        sourceSchemaVersion: 'number',
      },
    },
  };

  await mkdir(path.join(ROOT, OUT_DIR), { recursive: true });
  await writeFile(
    path.join(ROOT, OUT_DIR, 'samples.jsonl'),
    samples.map((row) => JSON.stringify(row)).join('\n') + (samples.length ? '\n' : ''),
  );
  await writeFile(
    path.join(ROOT, OUT_DIR, 'debug_evidence.jsonl'),
    evidence.map((row) => JSON.stringify(row)).join('\n') + (evidence.length ? '\n' : ''),
  );
  await writeFile(
    path.join(ROOT, OUT_DIR, 'failures.jsonl'),
    failures.map((row) => JSON.stringify(row)).join('\n') + (failures.length ? '\n' : ''),
  );
  await writeFile(
    path.join(ROOT, OUT_DIR, 'rating_conflicts.jsonl'),
    conflictRows.map((row) => JSON.stringify(row)).join('\n') + (conflictRows.length ? '\n' : ''),
  );
  await writeFile(
    path.join(ROOT, OUT_DIR, 'validation_quarantine.jsonl'),
    validationQuarantine.map((row) => JSON.stringify(row)).join('\n') +
      (validationQuarantine.length ? '\n' : ''),
  );
  await writeFile(
    path.join(ROOT, OUT_DIR, 'coverage_report.json'),
    JSON.stringify(coverageReport, null, 2) + '\n',
  );
  await writeFile(path.join(ROOT, OUT_DIR, 'schema.json'), JSON.stringify(schema, null, 2) + '\n');

  console.log(
    JSON.stringify(
      {
        outDir: OUT_DIR,
        samples: samples.length,
        validationRowsQuarantined: validationQuarantine.length,
        duplicateRowsRemoved: duplicateRows,
        conflicts: conflictingGroups.length,
        conflictRowsQuarantined: conflictRows.length,
        evidence: evidence.length,
        failures: failures.length,
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
