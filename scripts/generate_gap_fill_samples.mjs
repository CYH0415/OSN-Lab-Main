import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ratingSampleDir } from './rating_artifact_paths.mjs';

const ROOT = process.cwd();
const COVERAGE_FILE = process.env.COVERAGE_FILE || 'dataset_v2/coverage_report.json';
const DATASET_FILE = process.env.DATASET_FILE || 'dataset_v2/samples.jsonl';
const CONFLICT_FILE = process.env.CONFLICT_FILE || 'dataset_v2/rating_conflicts.jsonl';
const OUT_DIR =
  process.env.GAP_SAMPLE_OUT_DIR || ratingSampleDir('rating_samples_gap_fill');
const LIMIT = Number(process.env.GAP_SAMPLE_LIMIT || 220);
const MAX_ANSWERS = Number(process.env.GAP_MAX_ANSWERS || 12);
const MAX_CURRENT_COUNT = Number(process.env.GAP_MAX_CURRENT_COUNT || 5);
const TARGET_COUNT = Number(process.env.GAP_TARGET_COUNT || 0);
const SINGLETON_VARIANTS = Number(process.env.GAP_SINGLETON_VARIANTS || 3);
const OTHER_VARIANTS = Number(process.env.GAP_OTHER_VARIANTS || 1);
const COVERAGE_MODE = process.env.GAP_COVERAGE_MODE || 'target';

const CATEGORY_SLUGS = {
  Game: 'game',
  'All Other App Types': 'all_other_app_types',
};

async function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function assignment(question, option) {
  return {
    questionId: question.key,
    questionText: question.text,
    type: question.type,
    optionLabel: option.label,
    value: true,
  };
}

function answerKey(answer) {
  return `${answer.questionId}\u0000${answer.type}\u0000${answer.optionLabel}\u0000${Boolean(answer.value)}`;
}

function mergeAnswers(...sets) {
  const answers = new Map();
  const radios = new Map();
  for (const answer of sets.flat()) {
    if (answer.type === 'radio') {
      const previous = radios.get(answer.questionId);
      if (previous && previous !== answer.optionLabel) return null;
      radios.set(answer.questionId, answer.optionLabel);
    }
    answers.set(answerKey(answer), answer);
  }
  return [...answers.values()];
}

function visibleQuestions(graph, selections) {
  const visible = new Set(graph.roots || []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const questionId of [...visible]) {
      const question = graph.questions[questionId];
      for (const label of selections.get(questionId) || []) {
        for (const child of question?.options?.[label]?.children || []) {
          if (!visible.has(child)) {
            visible.add(child);
            changed = true;
          }
        }
      }
    }
  }
  return visible;
}

function orderAndValidate(graph, answers) {
  const pending = [...answers];
  const ordered = [];
  const selections = new Map();
  while (pending.length) {
    const visible = visibleQuestions(graph, selections);
    const candidate = pending
      .map((answer, index) => ({
        answer,
        index,
        order: graph.questions[answer.questionId]?.order ?? Number.MAX_SAFE_INTEGER,
      }))
      .filter(({ answer }) => visible.has(answer.questionId))
      .sort((left, right) => left.order - right.order)[0];
    if (!candidate) return null;
    const question = graph.questions[candidate.answer.questionId];
    if (!question?.options?.[candidate.answer.optionLabel]) return null;
    if (question.type === 'radio') {
      selections.set(question.key, new Set([candidate.answer.optionLabel]));
    } else {
      if (!selections.has(question.key)) selections.set(question.key, new Set());
      selections.get(question.key).add(candidate.answer.optionLabel);
    }
    ordered.push(candidate.answer);
    pending.splice(candidate.index, 1);
  }
  return ordered;
}

function incomingEdges(graph) {
  const incoming = new Map();
  for (const question of Object.values(graph.questions)) {
    for (const option of Object.values(question.options || {})) {
      for (const child of option.children || []) {
        if (!incoming.has(child)) incoming.set(child, []);
        incoming.get(child).push({ question, option });
      }
    }
  }
  return incoming;
}

function activationPaths(graph) {
  const incoming = incomingEdges(graph);
  const memo = new Map();
  const visiting = new Set();

  function pathsFor(questionId) {
    if (graph.roots.includes(questionId)) {
      if (!memo.has(questionId)) memo.set(questionId, [[]]);
      return memo.get(questionId);
    }
    if (memo.has(questionId)) return memo.get(questionId);
    if (visiting.has(questionId)) return [];
    visiting.add(questionId);
    const paths = [];
    for (const edge of incoming.get(questionId) || []) {
      for (const parentPath of pathsFor(edge.question.key)) {
        const merged = mergeAnswers(parentPath, [assignment(edge.question, edge.option)]);
        const ordered = merged && orderAndValidate(graph, merged);
        if (ordered) paths.push(ordered);
      }
    }
    visiting.delete(questionId);
    const unique = new Map();
    for (const candidate of paths.sort((left, right) => left.length - right.length)) {
      unique.set(candidate.map(answerKey).sort().join('\u0001'), candidate);
      if (unique.size >= 12) break;
    }
    const result = [...unique.values()];
    memo.set(questionId, result);
    return result;
  }

  for (const questionId of Object.keys(graph.questions)) pathsFor(questionId);
  return memo;
}

function reconstructState(graph, explicitAnswers) {
  const explicit = new Map();
  for (const answer of explicitAnswers) {
    if (!explicit.has(answer.questionId)) explicit.set(answer.questionId, []);
    explicit.get(answer.questionId).push(answer);
  }
  const active = new Set(graph.roots);
  const processed = new Set();
  const state = [];
  while (true) {
    const question = [...active]
      .map((id) => graph.questions[id])
      .filter((item) => item && !processed.has(item.key))
      .sort((left, right) => left.order - right.order)[0];
    if (!question) break;
    const targets = explicit.get(question.key) || [];
    const options = Object.values(question.options || {});
    let selected;
    if (question.type === 'radio') {
      selected =
        targets.find((answer) => answer.value !== false)?.optionLabel ||
        options.find((option) => option.label === 'No')?.label ||
        options[0]?.label;
    } else {
      const chosen = targets.filter((answer) => answer.value !== false).map((answer) => answer.optionLabel);
      selected = chosen.length ? chosen : [options[0]?.label].filter(Boolean);
    }
    const selectedLabels = new Set(Array.isArray(selected) ? selected : [selected]);
    state.push([
      question.key,
      options.map((option) => [option.label, selectedLabels.has(option.label)]).sort(),
    ]);
    processed.add(question.key);
    for (const label of selectedLabels) {
      for (const child of question.options[label]?.children || []) active.add(child);
    }
  }
  return JSON.stringify(state.sort((left, right) => left[0].localeCompare(right[0])));
}

function contextAnswers(graph, pathsByQuestion) {
  const contexts = [];
  const rootAtoms = [];
  for (const rootId of graph.roots) {
    const question = graph.questions[rootId];
    if (question?.type !== 'radio') continue;
    const yes = question.options?.Yes;
    if (yes) rootAtoms.push([assignment(question, yes)]);
  }
  contexts.push(...rootAtoms);
  const subsetLimit = Math.min(rootAtoms.length, 12);
  for (let mask = 1; mask < 2 ** subsetLimit && contexts.length < 300; mask += 1) {
    if (mask.toString(2).replaceAll('0', '').length < 2) continue;
    const chosen = [];
    for (let index = 0; index < subsetLimit; index += 1) {
      if (mask & (1 << index)) chosen.push(rootAtoms[index]);
    }
    const merged = mergeAnswers(...chosen);
    if (merged) contexts.push(merged);
  }
  for (const question of Object.values(graph.questions).sort((left, right) => left.order - right.order)) {
    const paths = pathsByQuestion.get(question.key) || [];
    const shortPath = paths.find((candidate) => candidate.length <= 2);
    if (!shortPath) continue;
    for (const option of Object.values(question.options || {})) {
      const merged = mergeAnswers(shortPath, [assignment(question, option)]);
      const ordered = merged && orderAndValidate(graph, merged);
      if (ordered) contexts.push(ordered);
      if (contexts.length >= 420) break;
    }
    if (contexts.length >= 420) break;
  }
  const atoms = contexts.slice(300, 380);
  contextPairs:
  for (let left = 0; left < atoms.length; left += 1) {
    for (let right = left + 1; right < atoms.length; right += 1) {
      const merged = mergeAnswers(atoms[left], atoms[right]);
      const ordered = merged && orderAndValidate(graph, merged);
      if (ordered) contexts.push(ordered);
      if (contexts.length >= 700) break contextPairs;
    }
  }
  return contexts;
}

async function main() {
  const coverage = JSON.parse(await readFile(path.join(ROOT, COVERAGE_FILE), 'utf8'));
  const existing = [
    ...(await readJsonLines(path.join(ROOT, DATASET_FILE))),
    ...(await readJsonLines(path.join(ROOT, CONFLICT_FILE))),
  ];
  const graphs = {};
  for (const [category, slug] of Object.entries(CATEGORY_SLUGS)) {
    graphs[category] = JSON.parse(
      await readFile(path.join(ROOT, 'data_categories', slug, 'question_graph.json'), 'utf8'),
    );
  }
  const existingStates = new Set(
    existing
      .filter((sample) => graphs[sample.category])
      .map((sample) => `${sample.category}\u0002${JSON.stringify(
        [...sample.questionStates]
          .sort((left, right) => left.questionId.localeCompare(right.questionId))
          .map((question) => [
            question.questionId,
            question.options.map((option) => [option.label, Boolean(option.selected)]).sort(),
          ]),
      )}`),
  );
  const selectedStates = new Set();
  const samples = [];
  const diagnostics = [];
  const coverageRows =
    COVERAGE_MODE === 'selected'
      ? coverage.lowFrequencySelectedOptions || []
      : coverage.lowFrequencyTargetSelectedOptions || [];
  const targets = coverageRows
    .filter((row) => graphs[row.category] && row.count <= MAX_CURRENT_COUNT)
    .sort((left, right) => left.count - right.count);

  for (const target of targets) {
    if (samples.length >= LIMIT) break;
    const graph = graphs[target.category];
    const question = graph.questions[target.questionId];
    const option = question?.options?.[target.optionLabel];
    if (!question || !option) continue;
    const pathsByQuestion = activationPaths(graph);
    const paths = pathsByQuestion.get(question.key) || [];
    const contexts = contextAnswers(graph, pathsByQuestion);
    const wanted = TARGET_COUNT
      ? Math.max(0, TARGET_COUNT - target.count)
      : target.count === 1
        ? SINGLETON_VARIANTS
        : OTHER_VARIANTS;
    let added = 0;
    const diagnostic = { ...target, paths: paths.length, contexts: contexts.length, invalid: 0, existing: 0 };

    for (const pathAnswers of paths) {
      for (const context of [[], ...contexts]) {
        const merged = mergeAnswers(pathAnswers, [assignment(question, option)], context);
        const ordered = merged && orderAndValidate(graph, merged);
        if (!ordered || ordered.length > MAX_ANSWERS) {
          diagnostic.invalid += 1;
          continue;
        }
        const state = reconstructState(graph, ordered);
        const stateKey = `${target.category}\u0002${state}`;
        if (existingStates.has(stateKey) || selectedStates.has(stateKey)) {
          diagnostic.existing += 1;
          continue;
        }
        selectedStates.add(stateKey);
        const digest = createHash('sha1')
          .update(`${target.category}\u0000${state}`)
          .digest('hex')
          .slice(0, 16);
        samples.push({
          sampleId: `gap_${String(samples.length + 1).padStart(4, '0')}_${digest}`,
          category: target.category,
          categorySlug: CATEGORY_SLUGS[target.category],
          strategy: target.count === 1 ? 'gap_singleton' : 'gap_low_frequency',
          answers: ordered,
          meta: {
            generatedBy: 'generate_gap_fill_samples',
            targetQuestionId: target.questionId,
            targetOptionLabel: target.optionLabel,
            previousCount: target.count,
          },
        });
        added += 1;
        if (added >= wanted || samples.length >= LIMIT) break;
      }
      if (added >= wanted || samples.length >= LIMIT) break;
    }
    diagnostic.added = added;
    diagnostics.push(diagnostic);
  }

  await mkdir(path.join(ROOT, OUT_DIR), { recursive: true });
  await writeFile(
    path.join(ROOT, OUT_DIR, 'samples.jsonl'),
    samples.map((sample) => JSON.stringify(sample)).join('\n') + (samples.length ? '\n' : ''),
  );
  await writeFile(
    path.join(ROOT, OUT_DIR, 'summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        selectedCount: samples.length,
        targetCount: TARGET_COUNT || null,
        coverageMode: COVERAGE_MODE,
        byCategory: samples.reduce((counts, sample) => {
          counts[sample.category] = (counts[sample.category] || 0) + 1;
          return counts;
        }, {}),
        byStrategy: samples.reduce((counts, sample) => {
          counts[sample.strategy] = (counts[sample.strategy] || 0) + 1;
          return counts;
        }, {}),
        targetedOptionCount: new Set(
          samples.map((sample) => `${sample.category}\u0000${sample.meta.targetQuestionId}\u0000${sample.meta.targetOptionLabel}`),
        ).size,
        diagnostics: diagnostics.filter((item) => item.added === 0),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(await readFile(path.join(ROOT, OUT_DIR, 'summary.json'), 'utf8'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
