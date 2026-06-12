import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ratingSampleDir } from './rating_artifact_paths.mjs';

const config = {
  categoryRoot: process.env.CATEGORY_OUT_ROOT || 'data_categories',
  outDir: process.env.SAMPLE_OUT_DIR || ratingSampleDir('rating_samples'),
  pairwisePerCategory: Number(process.env.PAIRWISE_PER_CATEGORY || 250),
};

function optionEntries(question) {
  return Object.values(question.options || {});
}

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function assignmentFor(question, option) {
  return {
    questionId: question.key,
    questionText: question.text,
    type: question.type,
    optionLabel: option.label,
    value: true,
  };
}

function assignmentKey(answer) {
  return `${answer.questionId}::${answer.type}::${answer.optionLabel}::${answer.value}`;
}

function sampleSignature(answers) {
  return [...new Set(answers.map(assignmentKey))].sort().join('|');
}

function normalizeAnswers(answers) {
  const byKey = new Map();
  for (const answer of answers) {
    const key = assignmentKey(answer);
    if (!byKey.has(key)) byKey.set(key, answer);
  }
  return [...byKey.values()];
}

function isCompatible(answers) {
  const radioByQuestion = new Map();
  const checkboxByOption = new Map();

  for (const answer of answers) {
    if (answer.type === 'radio') {
      const previous = radioByQuestion.get(answer.questionId);
      if (previous && previous !== answer.optionLabel) return false;
      radioByQuestion.set(answer.questionId, answer.optionLabel);
    }

    if (answer.type === 'checkbox') {
      const key = `${answer.questionId}::${answer.optionLabel}`;
      const previous = checkboxByOption.get(key);
      if (previous !== undefined && previous !== answer.value) return false;
      checkboxByOption.set(key, answer.value);
    }
  }

  return true;
}

function buildReachPaths(graph) {
  const questions = graph.questions || {};
  const queue = [];
  const paths = new Map();

  for (const rootId of graph.roots || []) {
    if (!questions[rootId]) continue;
    paths.set(rootId, []);
    queue.push(rootId);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const questionId = queue[index];
    const question = questions[questionId];
    const parentPath = paths.get(questionId) || [];

    for (const option of optionEntries(question)) {
      const answer = assignmentFor(question, option);
      const childPath = [...parentPath, answer];
      if (!isCompatible(childPath)) continue;

      for (const childId of option.children || []) {
        if (!questions[childId]) continue;
        if (paths.has(childId)) continue;
        paths.set(childId, normalizeAnswers(childPath));
        queue.push(childId);
      }
    }
  }

  return paths;
}

function makeSample(category, slugValue, index, strategy, answers, meta = {}) {
  return {
    sampleId: `${slugValue}_${String(index).padStart(5, '0')}`,
    category,
    categorySlug: slugValue,
    strategy,
    answers: normalizeAnswers(answers),
    meta,
  };
}

function generateCategorySamples(category, slugValue, graph) {
  const questions = graph.questions || {};
  const reachPaths = buildReachPaths(graph);
  const samples = [];
  const seen = new Set();

  function add(strategy, answers, meta = {}) {
    const normalized = normalizeAnswers(answers);
    if (!isCompatible(normalized)) return false;
    const signature = `${strategy}::${sampleSignature(normalized)}`;
    const globalSignature = sampleSignature(normalized);
    if (seen.has(signature) || seen.has(globalSignature)) return false;
    seen.add(signature);
    seen.add(globalSignature);
    samples.push(makeSample(category, slugValue, samples.length + 1, strategy, normalized, meta));
    return true;
  }

  add('baseline', [], { description: 'All visible questions are completed with baseline choices by the runner.' });

  const atomic = [];
  const orderedQuestions = Object.values(questions).sort((a, b) => (a.firstSeenOrder ?? a.order ?? 0) - (b.firstSeenOrder ?? b.order ?? 0));

  for (const question of orderedQuestions) {
    const reachPath = reachPaths.get(question.key);
    if (!reachPath) continue;

    for (const option of optionEntries(question)) {
      const answer = assignmentFor(question, option);
      const answers = normalizeAnswers([...reachPath, answer]);
      if (!isCompatible(answers)) continue;

      atomic.push({
        questionId: question.key,
        optionLabel: option.label,
        answers,
        childCount: option.children?.length || 0,
      });

      add('single_factor', answers, {
        questionId: question.key,
        optionLabel: option.label,
        childCount: option.children?.length || 0,
      });
    }
  }

  for (const item of atomic.filter((candidate) => candidate.childCount > 0)) {
    add('child_path_coverage', item.answers, {
      questionId: item.questionId,
      optionLabel: item.optionLabel,
      childCount: item.childCount,
    });
  }

  let pairwiseCount = 0;
  for (let left = 0; left < atomic.length && pairwiseCount < config.pairwisePerCategory; left += 1) {
    for (let right = left + 1; right < atomic.length && pairwiseCount < config.pairwisePerCategory; right += 1) {
      const combined = normalizeAnswers([...atomic[left].answers, ...atomic[right].answers]);
      if (!isCompatible(combined)) continue;
      const added = add('pairwise', combined, {
        left: {
          questionId: atomic[left].questionId,
          optionLabel: atomic[left].optionLabel,
        },
        right: {
          questionId: atomic[right].questionId,
          optionLabel: atomic[right].optionLabel,
        },
      });
      if (added) pairwiseCount += 1;
    }
  }

  return samples.map((sample, index) => ({
    ...sample,
    sampleId: `${slugValue}_${String(index + 1).padStart(5, '0')}`,
  }));
}

async function main() {
  const manifestPath = `${config.categoryRoot}/manifest.json`;
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${resolve(manifestPath)}`);
  }

  await mkdir(config.outDir, { recursive: true });
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const allSamples = [];
  const summary = {
    generatedAt: new Date().toISOString(),
    categoryRoot: resolve(config.categoryRoot),
    outDir: resolve(config.outDir),
    config,
    categories: [],
  };

  for (const categoryInfo of manifest.categories || []) {
    const graphPath = `${config.categoryRoot}/${categoryInfo.slug}/question_graph.json`;
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    const samples = generateCategorySamples(categoryInfo.category, categoryInfo.slug || slug(categoryInfo.category), graph);
    const outPath = `${config.outDir}/${categoryInfo.slug}_samples.jsonl`;
    await writeFile(outPath, samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
    allSamples.push(...samples);

    const strategyCounts = samples.reduce((counts, sample) => {
      counts[sample.strategy] = (counts[sample.strategy] || 0) + 1;
      return counts;
    }, {});

    summary.categories.push({
      category: categoryInfo.category,
      slug: categoryInfo.slug,
      graphPath: resolve(graphPath),
      samplePath: resolve(outPath),
      sampleCount: samples.length,
      strategyCounts,
    });

    console.log(`${categoryInfo.category}: ${samples.length} samples`, strategyCounts);
  }

  const allPath = `${config.outDir}/structural_samples.jsonl`;
  await writeFile(allPath, allSamples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
  summary.allSamplesPath = resolve(allPath);
  summary.totalSamples = allSamples.length;
  await writeFile(`${config.outDir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(`Total samples: ${summary.totalSamples}`);
  console.log(`Saved: ${resolve(allPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
