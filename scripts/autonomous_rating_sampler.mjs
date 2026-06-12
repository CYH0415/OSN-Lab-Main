import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const config = {
  categoryRoot: process.env.CATEGORY_OUT_ROOT || 'data_categories',
  outDir: process.env.AUTONOMOUS_OUT_DIR || 'rating_autonomous',
  targetSamples: Number(process.env.TARGET_SAMPLES || 1000),
  candidatePoolSize: Number(process.env.CANDIDATE_POOL_SIZE || 12000),
  batchSize: Number(process.env.BATCH_SIZE || 24),
  bootstrapSamples: Number(process.env.BOOTSTRAP_SAMPLES || 120),
  maxCombinationSize: Number(process.env.MAX_COMBINATION_SIZE || 4),
  activationPathsPerQuestion: Number(process.env.ACTIVATION_PATHS_PER_QUESTION || 8),
  retryLimit: Number(process.env.RETRY_LIMIT || 3),
  seed: Number(process.env.SAMPLER_SEED || 20260610),
  targetTerritory: process.env.TARGET_TERRITORY || 'Europe',
  generateOnly: process.env.GENERATE_ONLY === '1',
  pauseMs: Number(process.env.PAUSE_MS || 180),
  cdpUrl: process.env.CDP_URL || 'http://127.0.0.1:9222',
  expectedAccount: process.env.EXPECTED_GOOGLE_ACCOUNT || 'mengshu0715@gmail.com',
  contactEmail: process.env.IARC_CONTACT_EMAIL || process.env.EXPECTED_GOOGLE_ACCOUNT || 'mengshu0715@gmail.com',
};

const paths = {
  candidates: `${config.outDir}/candidates.jsonl`,
  selected: `${config.outDir}/selected.jsonl`,
  results: `${config.outDir}/results.jsonl`,
  dataset: `${config.outDir}/dataset.jsonl`,
  errors: `${config.outDir}/runner/errors.jsonl`,
  attempts: `${config.outDir}/attempts.json`,
  summary: `${config.outDir}/summary.json`,
  currentBatch: `${config.outDir}/current_batch.jsonl`,
};

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function hash(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

async function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, 'utf8'));
}

function optionEntries(question) {
  return Object.values(question?.options || {});
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
  return `${answer.questionId}::${answer.type}::${answer.optionLabel}::${answer.value}`;
}

function sampleSignature(answers) {
  return answers.map(answerKey).sort().join('|');
}

function mergeAssignments(answerSets) {
  const byAnswer = new Map();
  const radios = new Map();
  for (const answer of answerSets.flat()) {
    if (answer.type === 'radio') {
      const previous = radios.get(answer.questionId);
      if (previous && previous !== answer.optionLabel) return null;
      radios.set(answer.questionId, answer.optionLabel);
    }
    byAnswer.set(answerKey(answer), answer);
  }
  return [...byAnswer.values()];
}

function buildIncoming(graph) {
  const incoming = new Map();
  for (const question of Object.values(graph.questions || {})) {
    for (const option of optionEntries(question)) {
      for (const childId of option.children || []) {
        if (!incoming.has(childId)) incoming.set(childId, []);
        incoming.get(childId).push({
          parentId: question.key,
          optionLabel: option.label,
        });
      }
    }
  }
  return incoming;
}

function riskFor(graph, answer) {
  return graph.questions?.[answer.questionId]?.options?.[answer.optionLabel]?.risk || {};
}

function summarizeRisk(graph, answers) {
  const tags = new Set();
  let riskScore = 0;
  let maxSeverity = 0;
  let maxPriority = 0;
  let mitigationCount = 0;
  for (const answer of answers) {
    const risk = riskFor(graph, answer);
    const severity = Number(risk.severityScore || 0);
    const gate = Number(risk.gateScore || 0);
    const priority = Number(risk.samplingPriority || 0);
    riskScore += severity * 4 + gate * 1.5 + priority;
    maxSeverity = Math.max(maxSeverity, severity);
    maxPriority = Math.max(maxPriority, priority);
    if (risk.effect === 'mitigation_missing') mitigationCount += 1;
    for (const tag of risk.tags || []) tags.add(tag);
  }
  const primaryTag = [...tags].sort((left, right) => tagPriority(right) - tagPriority(left))[0] || 'neutral';
  return {
    riskScore: Math.round(riskScore * 10) / 10,
    maxSeverity,
    maxPriority,
    mitigationCount,
    tags: [...tags].sort(),
    primaryTag,
    staticBand: staticRiskBand({ riskScore, maxSeverity }),
  };
}

function tagPriority(tag) {
  const order = {
    sexual_violence: 100,
    sexual_content: 95,
    nudity: 90,
    gore: 85,
    violence: 80,
    gambling: 75,
    substances: 70,
    language: 65,
    fear: 60,
    crude_humor: 55,
    ugc: 50,
    monetization: 45,
    location_sharing: 40,
    safety_mitigation: 20,
  };
  return order[tag] || 10;
}

function staticRiskBand(summary) {
  if (summary.maxSeverity >= 5 || summary.riskScore >= 80) return 'restricted';
  if (summary.maxSeverity >= 4 || summary.riskScore >= 48) return 'high';
  if (summary.maxSeverity >= 2 || summary.riskScore >= 18) return 'mid';
  return 'low';
}

function visibleQuestions(graph, selections) {
  const visible = new Set(graph.roots || []);
  let changed = true;
  while (changed) {
    changed = false;
    for (const questionId of [...visible]) {
      const question = graph.questions?.[questionId];
      if (!question) continue;
      const selected = selections.get(questionId) || new Set();
      for (const label of selected) {
        const option = question.options?.[label];
        for (const childId of option?.children || []) {
          if (!visible.has(childId)) {
            visible.add(childId);
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
    const candidates = pending
      .map((answer, index) => ({ answer, index, order: graph.questions?.[answer.questionId]?.order ?? Number.MAX_SAFE_INTEGER }))
      .filter(({ answer }) => visible.has(answer.questionId))
      .sort((left, right) => left.order - right.order);
    if (!candidates.length) return null;
    const { answer, index } = candidates[0];
    const question = graph.questions?.[answer.questionId];
    if (!question?.options?.[answer.optionLabel]) return null;
    if (question.type === 'radio') {
      selections.set(answer.questionId, new Set([answer.optionLabel]));
    } else {
      if (!selections.has(answer.questionId)) selections.set(answer.questionId, new Set());
      if (answer.value) selections.get(answer.questionId).add(answer.optionLabel);
      else selections.get(answer.questionId).delete(answer.optionLabel);
    }
    ordered.push(answer);
    pending.splice(index, 1);
  }
  return ordered;
}

function buildActivationPaths(graph) {
  const incoming = buildIncoming(graph);
  const memo = new Map();
  const visiting = new Set();

  function pathsFor(questionId) {
    if ((graph.roots || []).includes(questionId)) return [[]];
    if (memo.has(questionId)) return memo.get(questionId);
    if (visiting.has(questionId)) return [];
    visiting.add(questionId);
    const candidates = [];
    for (const edge of incoming.get(questionId) || []) {
      const parent = graph.questions?.[edge.parentId];
      const option = parent?.options?.[edge.optionLabel];
      if (!parent || !option) continue;
      for (const parentPath of pathsFor(parent.key)) {
        const merged = mergeAssignments([parentPath, [assignment(parent, option)]]);
        if (!merged) continue;
        const ordered = orderAndValidate(graph, merged);
        if (ordered) candidates.push(ordered);
      }
    }
    visiting.delete(questionId);
    const unique = new Map();
    for (const candidate of candidates.sort((left, right) => left.length - right.length)) {
      unique.set(sampleSignature(candidate), candidate);
      if (unique.size >= config.activationPathsPerQuestion) break;
    }
    const result = [...unique.values()];
    memo.set(questionId, result);
    return result;
  }

  for (const questionId of Object.keys(graph.questions || {})) pathsFor(questionId);
  return memo;
}

function makeAtoms(graph) {
  const activationPaths = buildActivationPaths(graph);
  const atoms = [];
  for (const question of Object.values(graph.questions || {}).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
    const paths = activationPaths.get(question.key) || [];
    for (const option of optionEntries(question)) {
      const risk = option.risk || {};
      const meaningful =
        Number(risk.severityScore || 0) > 0 ||
        Number(risk.gateScore || 0) > 0 ||
        Number(risk.samplingPriority || 0) > 0 ||
        (risk.tags || []).length > 0 ||
        (option.children || []).length > 0;
      if (!meaningful) continue;
      for (const path of paths) {
        const merged = mergeAssignments([path, [assignment(question, option)]]);
        if (!merged) continue;
        const ordered = orderAndValidate(graph, merged);
        if (!ordered) continue;
        const summary = summarizeRisk(graph, ordered);
        atoms.push({
          answers: ordered,
          signature: sampleSignature(ordered),
          terminalQuestionId: question.key,
          terminalOptionLabel: option.label,
          ...summary,
        });
      }
    }
  }
  const unique = new Map();
  for (const atom of atoms) unique.set(atom.signature, atom);
  return [...unique.values()];
}

function candidateFromAnswers(graph, answers, strategy, components = []) {
  const ordered = orderAndValidate(graph, answers);
  if (!ordered) return null;
  const signature = sampleSignature(ordered);
  const summary = summarizeRisk(graph, ordered);
  const sampleId = `auto_${slug(graph.category)}_${hash(`${graph.category}::${signature}`)}`;
  return {
    sampleId,
    category: graph.category,
    categorySlug: slug(graph.category),
    strategy,
    answers: ordered,
    riskSummary: summary,
    meta: {
      generatedBy: 'autonomous_rating_sampler',
      components,
      answerCount: ordered.length,
    },
  };
}

function generateCandidatePool(graph, random, limit) {
  const atoms = makeAtoms(graph);
  const candidates = new Map();
  const add = (candidate) => {
    if (candidate) candidates.set(candidate.sampleId, candidate);
  };
  add(candidateFromAnswers(graph, [], 'autonomous_baseline'));
  for (const atom of atoms) {
    add(candidateFromAnswers(graph, atom.answers, 'autonomous_single', [`${atom.terminalQuestionId}::${atom.terminalOptionLabel}`]));
  }

  const weightedAtoms = atoms.flatMap((atom) => {
    const weight = Math.max(1, atom.maxPriority + atom.maxSeverity + (atom.tags.length ? 2 : 0));
    return Array.from({ length: Math.min(weight, 10) }, () => atom);
  });
  let misses = 0;
  while (candidates.size < limit && misses < limit * 20) {
    const size = 2 + Math.floor(random() * Math.max(1, config.maxCombinationSize - 1));
    const chosen = [];
    const componentKeys = new Set();
    for (let index = 0; index < size; index += 1) {
      const atom = weightedAtoms[Math.floor(random() * weightedAtoms.length)];
      if (!atom) continue;
      const key = `${atom.terminalQuestionId}::${atom.terminalOptionLabel}`;
      if (componentKeys.has(key)) continue;
      componentKeys.add(key);
      chosen.push(atom);
    }
    const merged = mergeAssignments(chosen.map((atom) => atom.answers));
    const before = candidates.size;
    if (merged) {
      add(candidateFromAnswers(graph, merged, `autonomous_${chosen.length}_way`, [...componentKeys].sort()));
    }
    misses = candidates.size === before ? misses + 1 : 0;
  }
  return shuffled([...candidates.values()], random);
}

function ratingBucket(rating) {
  const value = String(rating || '').toLowerCase();
  if (/refused|adults only|18|19/.test(value)) return 'restricted';
  if (/16|17|mature/.test(value)) return 'high';
  if (/12|13|14|15|teen|parental guidance/.test(value)) return 'mid';
  return 'low';
}

function resultBucket(result) {
  const ratings = result.ratings || result.result?.ratings || [];
  const rating = ratings.find((item) => item.territory === config.targetTerritory);
  const label = rating?.label || rating?.rating || '';
  return ratingBucket(label);
}

function featureSet(sample) {
  const features = new Set();
  for (const tag of sample.riskSummary?.tags || []) features.add(`tag:${tag}`);
  features.add(`band:${sample.riskSummary?.staticBand || 'low'}`);
  features.add(`category:${sample.categorySlug}`);
  for (const answer of sample.answers || []) features.add(`answer:${answer.questionId}::${answer.optionLabel}`);
  return features;
}

function similarity(left, right) {
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / Math.max(1, left.size + right.size - intersection);
}

function predictBucket(candidate, completed, candidateById) {
  if (completed.length < 12) {
    return { bucket: candidate.riskSummary.staticBand, confidence: 0, uncertainty: 1 };
  }
  const targetFeatures = featureSet(candidate);
  const neighbors = completed
    .map((result) => {
      const sample = candidateById.get(result.sampleId);
      if (!sample || sample.category !== candidate.category) return null;
      return {
        bucket: resultBucket(result),
        similarity: similarity(targetFeatures, featureSet(sample)),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, 9);
  if (!neighbors.length || neighbors[0].similarity === 0) {
    return { bucket: candidate.riskSummary.staticBand, confidence: 0, uncertainty: 1 };
  }
  const votes = {};
  for (const neighbor of neighbors) {
    votes[neighbor.bucket] = (votes[neighbor.bucket] || 0) + Math.max(0.05, neighbor.similarity);
  }
  const ranked = Object.entries(votes).sort((left, right) => right[1] - left[1]);
  const total = ranked.reduce((sum, [, value]) => sum + value, 0);
  const confidence = ranked[0][1] / total;
  return { bucket: ranked[0][0], confidence, uncertainty: 1 - confidence };
}

function quotaKey(categorySlug, tag, bucket) {
  return `${categorySlug}::${tag}::${bucket}`;
}

function currentQuotaCounts(completed, candidateById) {
  const counts = new Map();
  for (const result of completed) {
    const sample = candidateById.get(result.sampleId);
    if (!sample) continue;
    const key = quotaKey(sample.categorySlug, sample.riskSummary.primaryTag, resultBucket(result));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function selectBatch(candidates, completed, attempts, batchSize) {
  const candidateById = new Map(candidates.map((sample) => [sample.sampleId, sample]));
  const completedIds = new Set(completed.map((result) => result.sampleId));
  const quotaCounts = currentQuotaCounts(completed, candidateById);
  const eligible = candidates
    .filter((sample) => !completedIds.has(sample.sampleId))
    .filter((sample) => Number(attempts[sample.sampleId] || 0) < config.retryLimit)
    .map((sample) => {
      const prediction = predictBucket(sample, completed, candidateById);
      const cell = quotaKey(sample.categorySlug, sample.riskSummary.primaryTag, prediction.bucket);
      const quality =
        prediction.uncertainty * 5 +
        Math.min(4, sample.riskSummary.maxPriority || 0) -
        Math.max(0, (sample.answers.length || 0) - 14) * 0.1;
      return { sample, cell, quality, prediction };
    });

  const byCell = new Map();
  for (const candidate of eligible) {
    if (!byCell.has(candidate.cell)) byCell.set(candidate.cell, []);
    byCell.get(candidate.cell).push(candidate);
  }
  for (const values of byCell.values()) {
    values.sort((left, right) => right.quality - left.quality || left.sample.sampleId.localeCompare(right.sample.sampleId));
  }

  const selected = [];
  const selectedPerCell = new Map();
  const selectedPerCategory = new Map();
  while (selected.length < batchSize) {
    const availableCells = [...byCell.entries()].filter(([, values]) => values.length);
    if (!availableCells.length) break;
    availableCells.sort(([leftCell], [rightCell]) => {
      const leftCategory = leftCell.split('::')[0];
      const rightCategory = rightCell.split('::')[0];
      const leftFill = (quotaCounts.get(leftCell) || 0) + (selectedPerCell.get(leftCell) || 0);
      const rightFill = (quotaCounts.get(rightCell) || 0) + (selectedPerCell.get(rightCell) || 0);
      const leftCategoryFill = selectedPerCategory.get(leftCategory) || 0;
      const rightCategoryFill = selectedPerCategory.get(rightCategory) || 0;
      return leftFill - rightFill || leftCategoryFill - rightCategoryFill || leftCell.localeCompare(rightCell);
    });
    const [cell, values] = availableCells[0];
    const picked = values.shift();
    selected.push({
      ...picked.sample,
      meta: {
        ...picked.sample.meta,
        predictedBucket: picked.prediction.bucket,
        predictionConfidence: picked.prediction.confidence,
        quotaCell: cell,
      },
    });
    selectedPerCell.set(cell, (selectedPerCell.get(cell) || 0) + 1);
    const category = picked.sample.categorySlug;
    selectedPerCategory.set(category, (selectedPerCategory.get(category) || 0) + 1);
  }
  return selected.sort((left, right) => left.category.localeCompare(right.category));
}

async function loadGraphs() {
  const manifest = JSON.parse(await readFile(`${config.categoryRoot}/manifest.json`, 'utf8'));
  const graphs = [];
  for (const category of manifest.categories || []) {
    const annotated = `${config.categoryRoot}/${category.slug}/question_graph_risk_annotated.json`;
    if (!existsSync(annotated)) throw new Error(`Annotated graph not found: ${resolve(annotated)}`);
    graphs.push(JSON.parse(await readFile(annotated, 'utf8')));
  }
  return graphs;
}

async function generateCandidates() {
  const random = mulberry32(config.seed);
  const graphs = await loadGraphs();
  const perCategory = Math.ceil(config.candidatePoolSize / Math.max(1, graphs.length));
  const candidates = [];
  for (const graph of graphs) {
    const categoryCandidates = generateCandidatePool(graph, random, perCategory);
    candidates.push(...categoryCandidates);
    console.log(`${graph.category}: generated ${categoryCandidates.length} candidates`);
  }
  await writeFile(paths.candidates, candidates.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
  return candidates;
}

function runRunner(batch) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['scripts/run_rating_samples.mjs'], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        SAMPLE_FILE: paths.currentBatch,
        RESULT_OUT_DIR: `${config.outDir}/runner`,
        RESULT_FILE: paths.results,
        LIMIT: String(batch.length),
        PAUSE_MS: String(config.pauseMs),
        CDP_URL: config.cdpUrl,
        EXPECTED_GOOGLE_ACCOUNT: config.expectedAccount,
        IARC_CONTACT_EMAIL: config.contactEmail,
      },
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Sample runner exited with code ${code}`));
    });
  });
}

async function writeSummary(candidates, completed, attempts) {
  const candidateById = new Map(candidates.map((sample) => [sample.sampleId, sample]));
  const errorEvents = await readJsonLines(paths.errors);
  const byCategory = {};
  const byBucket = {};
  const byTag = {};
  const quota = {};
  for (const result of completed) {
    const sample = candidateById.get(result.sampleId);
    if (!sample) continue;
    const bucket = resultBucket(result);
    byCategory[sample.category] = (byCategory[sample.category] || 0) + 1;
    byBucket[bucket] = (byBucket[bucket] || 0) + 1;
    byTag[sample.riskSummary.primaryTag] = (byTag[sample.riskSummary.primaryTag] || 0) + 1;
    const key = quotaKey(sample.categorySlug, sample.riskSummary.primaryTag, bucket);
    quota[key] = (quota[key] || 0) + 1;
  }
  const dataset = completed
    .map((result) => {
      const sample = candidateById.get(result.sampleId);
      if (!sample) return null;
      return {
        sampleId: sample.sampleId,
        category: sample.category,
        categorySlug: sample.categorySlug,
        strategy: sample.strategy,
        answers: sample.answers,
        riskSummary: sample.riskSummary,
        generationMeta: sample.meta,
        ratings: result.ratings || result.result?.ratings || [],
        sourceUrl: result.result?.url || '',
        collectedAt: result.finishedAt || '',
      };
    })
    .filter(Boolean);
  await writeFile(paths.dataset, dataset.map((row) => JSON.stringify(row)).join('\n') + (dataset.length ? '\n' : ''));
  const summary = {
    generatedAt: new Date().toISOString(),
    config,
    candidateCount: candidates.length,
    completedCount: completed.length,
    remainingTarget: Math.max(0, config.targetSamples - completed.length),
    attemptedCount: Object.keys(attempts).length,
    errorEventCount: errorEvents.length,
    retryCount: Object.values(attempts).reduce((sum, count) => sum + Math.max(0, Number(count) - 1), 0),
    byCategory,
    byBucket,
    byTag,
    quota,
    files: Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, resolve(value)])),
  };
  await writeFile(paths.summary, JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

async function main() {
  await mkdir(config.outDir, { recursive: true });
  await mkdir(`${config.outDir}/runner`, { recursive: true });
  let candidates = existsSync(paths.candidates) ? await readJsonLines(paths.candidates) : await generateCandidates();
  if (!candidates.length) throw new Error('Candidate pool is empty.');

  let attempts = await readJson(paths.attempts, {});
  let completed = await readJsonLines(paths.results);
  await writeSummary(candidates, completed, attempts);

  if (config.generateOnly) {
    const batch = selectBatch(candidates, completed, attempts, config.batchSize);
    await writeFile(paths.currentBatch, batch.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
    console.log(`Generated ${candidates.length} candidates; next batch contains ${batch.length} samples.`);
    return;
  }

  while (completed.length < config.targetSamples) {
    const batch = selectBatch(candidates, completed, attempts, Math.min(config.batchSize, config.targetSamples - completed.length));
    if (!batch.length) {
      throw new Error('No eligible candidates remain before reaching the target.');
    }

    await writeFile(paths.currentBatch, batch.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
    await appendFile(paths.selected, batch.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
    for (const sample of batch) attempts[sample.sampleId] = Number(attempts[sample.sampleId] || 0) + 1;
    await writeFile(paths.attempts, JSON.stringify(attempts, null, 2) + '\n');

    console.log(`Running batch of ${batch.length}; completed=${completed.length}/${config.targetSamples}`);
    await runRunner(batch);
    completed = await readJsonLines(paths.results);
    const summary = await writeSummary(candidates, completed, attempts);
    console.log(`Completed ${summary.completedCount}/${config.targetSamples}`, summary.byBucket);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
