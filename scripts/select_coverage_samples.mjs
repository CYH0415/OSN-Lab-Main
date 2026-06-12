import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const COVERAGE_FILE = process.env.COVERAGE_FILE || 'dataset_v2/coverage_report.json';
const CANDIDATE_FILE = process.env.CANDIDATE_FILE || 'rating_autonomous/candidates.jsonl';
const OUT_DIR = process.env.COVERAGE_SAMPLE_OUT_DIR || 'rating_samples_coverage';
const LIMIT = Number(process.env.COVERAGE_SAMPLE_LIMIT || 80);
const TARGET_COUNT = Number(process.env.COVERAGE_TARGET_COUNT || 6);
const MAX_ANSWERS = Number(process.env.COVERAGE_MAX_ANSWERS || 10);
const INCLUDED_CATEGORIES = new Set(
  (process.env.COVERAGE_CATEGORIES || 'Game,All Other App Types')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);

async function readJsonLines(file) {
  if (!existsSync(file)) return [];
  return (await readFile(file, 'utf8'))
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function optionKey(category, answer) {
  return `${category}\u0000${answer.questionId}\u0000${answer.optionLabel}`;
}

function answerSignature(sample) {
  return (sample.answers || sample.explicitAnswers || sample.applied || [])
    .map(
      (answer) =>
        `${answer.questionId}\u0000${answer.type}\u0000${answer.optionLabel}\u0000${Boolean(answer.value)}`,
    )
    .sort()
    .join('\u0001');
}

function stableId(sample, index) {
  const digest = createHash('sha1')
    .update(`${sample.category}\u0000${answerSignature(sample)}`)
    .digest('hex')
    .slice(0, 16);
  return `coverage_${String(index + 1).padStart(4, '0')}_${digest}`;
}

async function completedSamples() {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const completed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!(entry.name.startsWith('rating_results') || entry.name === 'rating_autonomous')) continue;
    completed.push(...(await readJsonLines(path.join(ROOT, entry.name, 'results.jsonl'))));
  }
  return completed;
}

async function main() {
  const coverage = JSON.parse(await readFile(path.join(ROOT, COVERAGE_FILE), 'utf8'));
  const candidates = await readJsonLines(path.join(ROOT, CANDIDATE_FILE));
  const completed = await completedSamples();
  const completedIds = new Set(completed.map((row) => row.sampleId));
  const completedSignatures = new Set(
    completed.map((row) => `${row.category}\u0002${answerSignature(row)}`),
  );

  const counts = new Map();
  for (const row of coverage.lowFrequencyTargetSelectedOptions || []) {
    if (!INCLUDED_CATEGORIES.has(row.category)) continue;
    counts.set(
      `${row.category}\u0000${row.questionId}\u0000${row.optionLabel}`,
      Number(row.count || 0),
    );
  }

  const pool = candidates
    .filter((sample) => INCLUDED_CATEGORIES.has(sample.category))
    .filter((sample) => !completedIds.has(sample.sampleId))
    .filter(
      (sample) =>
        !completedSignatures.has(`${sample.category}\u0002${answerSignature(sample)}`),
    )
    .filter((sample) => (sample.answers?.length || 0) <= MAX_ANSWERS)
    .map((sample) => ({
      ...sample,
      coverageKeys: [...new Set((sample.answers || []).map((answer) => optionKey(sample.category, answer)))],
    }))
    .filter((sample) => sample.coverageKeys.some((key) => counts.has(key)));

  const selected = [];
  const usedSignatures = new Set();
  while (selected.length < LIMIT) {
    let best = null;
    let bestScore = 0;

    for (const sample of pool) {
      const signature = `${sample.category}\u0002${answerSignature(sample)}`;
      if (usedSignatures.has(signature)) continue;
      let score = 0;
      let usefulTargets = 0;
      for (const key of sample.coverageKeys) {
        if (!counts.has(key)) continue;
        const deficit = Math.max(0, TARGET_COUNT - counts.get(key));
        if (!deficit) continue;
        usefulTargets += 1;
        score += deficit * deficit + 2;
      }
      if (!usefulTargets) continue;
      score += usefulTargets * 3;
      score -= (sample.answers?.length || 0) * 1.5;
      if (
        score > bestScore ||
        (score === bestScore && (sample.answers?.length || 0) < (best?.answers?.length || Infinity))
      ) {
        best = sample;
        bestScore = score;
      }
    }

    if (!best) break;
    usedSignatures.add(`${best.category}\u0002${answerSignature(best)}`);
    const coveredTargets = best.coverageKeys.filter(
      (key) => counts.has(key) && counts.get(key) < TARGET_COUNT,
    );
    for (const key of coveredTargets) counts.set(key, counts.get(key) + 1);
    selected.push({
      ...best,
      sampleId: stableId(best, selected.length),
      strategy: 'coverage_deficit',
      meta: {
        ...(best.meta || {}),
        generatedBy: 'select_coverage_samples',
        coverageTargetCount: TARGET_COUNT,
        coveredTargetCount: coveredTargets.length,
      },
    });
    delete selected.at(-1).coverageKeys;
  }

  const remaining = [...counts.entries()]
    .filter(([, count]) => count < TARGET_COUNT)
    .map(([key, count]) => {
      const [category, questionId, optionLabel] = key.split('\u0000');
      return { category, questionId, optionLabel, count, deficit: TARGET_COUNT - count };
    })
    .sort((left, right) => right.deficit - left.deficit || left.category.localeCompare(right.category));

  await mkdir(path.join(ROOT, OUT_DIR), { recursive: true });
  await writeFile(
    path.join(ROOT, OUT_DIR, 'samples.jsonl'),
    selected.map((sample) => JSON.stringify(sample)).join('\n') + (selected.length ? '\n' : ''),
  );
  await writeFile(
    path.join(ROOT, OUT_DIR, 'selection_summary.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        candidateFile: CANDIDATE_FILE,
        coverageFile: COVERAGE_FILE,
        targetCount: TARGET_COUNT,
        maxAnswers: MAX_ANSWERS,
        limit: LIMIT,
        selectedCount: selected.length,
        byCategory: selected.reduce((result, sample) => {
          result[sample.category] = (result[sample.category] || 0) + 1;
          return result;
        }, {}),
        remainingDeficits: remaining,
      },
      null,
      2,
    ) + '\n',
  );

  console.log(
    JSON.stringify(
      {
        outDir: OUT_DIR,
        selected: selected.length,
        byCategory: selected.reduce((result, sample) => {
          result[sample.category] = (result[sample.category] || 0) + 1;
          return result;
        }, {}),
        remainingDeficits: remaining.length,
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
