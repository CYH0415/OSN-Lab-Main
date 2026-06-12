import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ratingSampleDir } from './rating_artifact_paths.mjs';

const config = {
  graphPath: process.env.RISK_GRAPH || process.argv[2] || 'data_categories/game/question_graph_risk_annotated.json',
  outDir:
    process.env.RISK_SAMPLE_OUT_DIR ||
    process.argv[3] ||
    ratingSampleDir('rating_samples_risk_game'),
  maxRiskPaths: Number(process.env.MAX_RISK_PATHS || 120),
  maxPairwise: Number(process.env.MAX_RISK_PAIRWISE || 80),
  minPriority: Number(process.env.MIN_RISK_PRIORITY || 3),
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

function riskValue(option) {
  const risk = option.risk || {};
  return (risk.severityScore || 0) * 3 + (risk.gateScore || 0) * 1.5 + (risk.samplingPriority || 0);
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
      const childPath = normalizeAnswers([...parentPath, answer]);
      if (!isCompatible(childPath)) continue;

      for (const childId of option.children || []) {
        if (!questions[childId] || paths.has(childId)) continue;
        paths.set(childId, childPath);
        queue.push(childId);
      }
    }
  }

  return paths;
}

function bestDescendantAnswers(graph, startQuestionIds, seenQuestions = new Set()) {
  const questions = graph.questions || {};
  const answers = [];

  for (const questionId of startQuestionIds || []) {
    if (seenQuestions.has(questionId)) continue;
    seenQuestions.add(questionId);
    const question = questions[questionId];
    if (!question) continue;
    const options = optionEntries(question).sort((a, b) => riskValue(b) - riskValue(a));
    if (!options.length) continue;

    if (question.type === 'radio') {
      const best = options[0];
      answers.push(assignmentFor(question, best));
      answers.push(...bestDescendantAnswers(graph, best.children || [], seenQuestions));
      continue;
    }

    if (question.type === 'checkbox') {
      const best = options[0];
      answers.push(assignmentFor(question, best));
      answers.push(...bestDescendantAnswers(graph, best.children || [], seenQuestions));
    }
  }

  return normalizeAnswers(answers);
}

function sampleRiskSummary(answers, graph) {
  const byQuestionOption = new Map();
  for (const question of Object.values(graph.questions || {})) {
    for (const option of optionEntries(question)) {
      byQuestionOption.set(`${question.key}::${option.label}`, option.risk || {});
    }
  }

  const tags = new Set();
  let score = 0;
  let maxSeverity = 0;
  let maxGate = 0;
  for (const answer of answers) {
    const risk = byQuestionOption.get(`${answer.questionId}::${answer.optionLabel}`) || {};
    maxSeverity = Math.max(maxSeverity, risk.severityScore || 0);
    maxGate = Math.max(maxGate, risk.gateScore || 0);
    score += (risk.severityScore || 0) * 3 + (risk.gateScore || 0);
    if ((risk.severityScore || 0) >= 3 || risk.effect === 'mitigation_missing') {
      for (const tag of risk.tags || []) tags.add(tag);
    }
  }
  return {
    score,
    maxSeverity,
    maxGate,
    tags: [...tags].sort(),
  };
}

function makeSample(category, categorySlug, index, strategy, answers, graph, meta = {}) {
  return {
    sampleId: `${categorySlug}_risk_${String(index).padStart(5, '0')}`,
    category,
    categorySlug,
    strategy,
    answers: normalizeAnswers(answers),
    riskSummary: sampleRiskSummary(answers, graph),
    meta,
  };
}

function generateRiskSamples(graph) {
  const category = graph.category || 'Game';
  const categorySlug = slug(category);
  const questions = graph.questions || {};
  const reachPaths = buildReachPaths(graph);
  const samples = [];
  const seen = new Set();

  function add(strategy, answers, meta = {}) {
    const normalized = normalizeAnswers(answers);
    if (!normalized.length && strategy !== 'baseline') return false;
    if (!isCompatible(normalized)) return false;
    const signature = sampleSignature(normalized);
    if (seen.has(signature)) return false;
    seen.add(signature);
    samples.push(makeSample(category, categorySlug, samples.length + 1, strategy, normalized, graph, meta));
    return true;
  }

  add('baseline', [], { description: 'Runner fills lowest-risk visible answers.' });

  const candidates = [];
  for (const question of Object.values(questions).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const reachPath = reachPaths.get(question.key);
    if (!reachPath) continue;
    for (const option of optionEntries(question)) {
      const risk = option.risk || {};
      if ((risk.samplingPriority || 0) < config.minPriority && (risk.severityScore || 0) < 4) continue;
      const ownAnswer = assignmentFor(question, option);
      const chain = normalizeAnswers([
        ...reachPath,
        ownAnswer,
        ...bestDescendantAnswers(graph, option.children || []),
      ]);
      if (!isCompatible(chain)) continue;
      candidates.push({
        question,
        option,
        answers: chain,
        risk,
        value: riskValue(option) + sampleRiskSummary(chain, graph).score,
      });
    }
  }

  candidates.sort((a, b) => b.value - a.value || (a.question.order ?? 0) - (b.question.order ?? 0));

  for (const candidate of candidates.slice(0, config.maxRiskPaths)) {
    add('risk_path', candidate.answers, {
      anchor: {
        questionId: candidate.question.key,
        optionLabel: candidate.option.label,
        risk: candidate.risk,
      },
    });
  }

  const bestByTag = new Map();
  for (const candidate of candidates) {
    for (const tag of candidate.risk.tags || []) {
      const existing = bestByTag.get(tag) || [];
      existing.push(candidate);
      bestByTag.set(tag, existing);
    }
  }

  for (const [tag, tagCandidates] of bestByTag.entries()) {
    for (const candidate of tagCandidates.slice(0, 8)) {
      add('tag_max_path', candidate.answers, {
        tag,
        anchor: {
          questionId: candidate.question.key,
          optionLabel: candidate.option.label,
          risk: candidate.risk,
        },
      });
    }
  }

  let pairwise = 0;
  const pairCandidates = candidates.filter((candidate) => (candidate.risk.severityScore || 0) >= 4).slice(0, 80);
  for (let left = 0; left < pairCandidates.length && pairwise < config.maxPairwise; left += 1) {
    for (let right = left + 1; right < pairCandidates.length && pairwise < config.maxPairwise; right += 1) {
      const leftTags = new Set(pairCandidates[left].risk.tags || []);
      const rightTags = new Set(pairCandidates[right].risk.tags || []);
      const overlap = [...leftTags].some((tag) => rightTags.has(tag));
      if (overlap && leftTags.size && rightTags.size) continue;

      const combined = normalizeAnswers([...pairCandidates[left].answers, ...pairCandidates[right].answers]);
      if (!isCompatible(combined)) continue;
      if (add('risk_pairwise', combined, {
        left: {
          questionId: pairCandidates[left].question.key,
          optionLabel: pairCandidates[left].option.label,
          risk: pairCandidates[left].risk,
        },
        right: {
          questionId: pairCandidates[right].question.key,
          optionLabel: pairCandidates[right].option.label,
          risk: pairCandidates[right].risk,
        },
      })) {
        pairwise += 1;
      }
    }
  }

  return samples.map((sample, index) => ({
    ...sample,
    sampleId: `${categorySlug}_risk_${String(index + 1).padStart(5, '0')}`,
  }));
}

async function main() {
  const graph = JSON.parse(await readFile(config.graphPath, 'utf8'));
  const samples = generateRiskSamples(graph);
  await mkdir(config.outDir, { recursive: true });

  const samplePath = `${config.outDir}/risk_samples.jsonl`;
  await writeFile(samplePath, samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n');

  const summary = {
    generatedAt: new Date().toISOString(),
    graphPath: resolve(config.graphPath),
    samplePath: resolve(samplePath),
    config,
    sampleCount: samples.length,
    strategyCounts: samples.reduce((counts, sample) => {
      counts[sample.strategy] = (counts[sample.strategy] || 0) + 1;
      return counts;
    }, {}),
    severityCounts: samples.reduce((counts, sample) => {
      const key = String(sample.riskSummary.maxSeverity);
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
    tagCounts: samples.reduce((counts, sample) => {
      for (const tag of sample.riskSummary.tags) counts[tag] = (counts[tag] || 0) + 1;
      return counts;
    }, {}),
  };
  await writeFile(`${config.outDir}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
