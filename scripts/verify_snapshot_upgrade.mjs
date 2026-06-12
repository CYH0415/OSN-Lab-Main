import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ratingResultDir, ratingWorkDir } from './rating_artifact_paths.mjs';

const ROOT = process.cwd();
const DATASET_FILE = process.env.DATASET_FILE || 'dataset_v2/samples.jsonl';
const WORK_DIR =
  process.env.SNAPSHOT_UPGRADE_WORK_DIR || ratingWorkDir('snapshot_upgrade');
const VERIFIED_DIR =
  process.env.SNAPSHOT_UPGRADE_VERIFIED_DIR ||
  ratingResultDir('rating_results_snapshot_upgrade');

async function readJsonLines(file) {
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
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

function ratingSignature(sample) {
  return JSON.stringify(
    sample.ratings
      .map((rating) => [rating.territory, rating.authority, rating.label || rating.rating])
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  );
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

async function main() {
  const source = await readJsonLines(path.join(ROOT, DATASET_FILE));
  const replayed = await readJsonLines(path.join(ROOT, WORK_DIR, 'results.jsonl'));
  const workEvidence = await readJsonLines(path.join(ROOT, WORK_DIR, 'evidence.jsonl'));
  const evidenceById = new Map();
  for (const row of workEvidence) {
    const category = row.summaryCategory || parseSummaryCategory(row.bodyText);
    if (!evidenceById.has(row.sampleId)) evidenceById.set(row.sampleId, new Set());
    if (category) evidenceById.get(row.sampleId).add(category);
  }
  const sourceById = new Map(source.map((sample) => [sample.sampleId, sample]));
  const verified = [];
  const rejected = [];

  for (const candidate of replayed) {
    const original = sourceById.get(candidate.sampleId);
    if (!original) {
      rejected.push({ sampleId: candidate.sampleId, reason: 'source_sample_missing' });
      continue;
    }

    const stateMatches = stateSignature(original) === stateSignature(candidate);
    const ratingsMatch = ratingSignature(original) === ratingSignature(candidate);
    const summaryCategories = [...(evidenceById.get(candidate.sampleId) || [])];
    const territories = candidate.ratings.map((rating) => rating.territory).sort();
    const expected = expectedTerritories(candidate.category).sort();
    const categoryMatches = summaryCategories.length === 1 && summaryCategories[0] === candidate.category;
    const territoriesMatch = JSON.stringify(territories) === JSON.stringify(expected);
    if (!stateMatches || !categoryMatches || !territoriesMatch) {
      rejected.push({
        sampleId: candidate.sampleId,
        reason: 'replay_mismatch',
        stateMatches,
        ratingsMatch,
        categoryMatches,
        summaryCategories,
        territoriesMatch,
        originalStateQuestions: original.questionStates.length,
        replayedStateQuestions: candidate.questionStates.length,
        originalRatings: original.ratings.map(({ territory, authority, label }) => ({ territory, authority, label })),
        replayedRatings: candidate.ratings.map(({ territory, authority, label, rating }) => ({
          territory,
          authority,
          label: label || rating,
        })),
      });
      continue;
    }

    verified.push({
      ...candidate,
      strategy: original.strategy,
      explicitAnswers: original.explicitAnswers,
      provenance: {
        ...candidate.provenance,
        stateSource: 'browser_snapshot',
        upgradedFrom: original.provenance,
        ratingChangedOnReplay: !ratingsMatch,
      },
    });
  }

  await mkdir(path.join(ROOT, VERIFIED_DIR), { recursive: true });
  await writeFile(
    path.join(ROOT, VERIFIED_DIR, 'results.jsonl'),
    verified.map((sample) => JSON.stringify(sample)).join('\n') + (verified.length ? '\n' : ''),
  );
  await writeFile(
    path.join(ROOT, VERIFIED_DIR, 'rejected.jsonl'),
    rejected.map((sample) => JSON.stringify(sample)).join('\n') + (rejected.length ? '\n' : ''),
  );

  const report = {
    generatedAt: new Date().toISOString(),
    replayed: replayed.length,
    verified: verified.length,
    rejected: rejected.length,
  };
  await writeFile(path.join(ROOT, VERIFIED_DIR, 'verification_report.json'), JSON.stringify(report, null, 2) + '\n');

  if (workEvidence.length) {
    await writeFile(
      path.join(ROOT, VERIFIED_DIR, 'evidence.jsonl'),
      workEvidence
        .filter((row) => verified.some((sample) => sample.sampleId === row.sampleId))
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n',
    );
  }

  const workErrors = await readJsonLines(path.join(ROOT, WORK_DIR, 'errors.jsonl'));
  if (workErrors.length) {
    await writeFile(
      path.join(ROOT, VERIFIED_DIR, 'errors.jsonl'),
      workErrors.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch(async (error) => {
  await appendFile(path.join(ROOT, WORK_DIR, 'verification_errors.log'), `${error.stack || error}\n`).catch(() => {});
  console.error(error);
  process.exit(1);
});
