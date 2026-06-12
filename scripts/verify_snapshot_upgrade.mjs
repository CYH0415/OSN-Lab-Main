import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const DATASET_FILE = process.env.DATASET_FILE || 'dataset_v2/samples.jsonl';
const WORK_DIR = process.env.SNAPSHOT_UPGRADE_WORK_DIR || 'snapshot_upgrade_work';
const VERIFIED_DIR = process.env.SNAPSHOT_UPGRADE_VERIFIED_DIR || 'rating_results_snapshot_upgrade';

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

async function main() {
  const source = await readJsonLines(path.join(ROOT, DATASET_FILE));
  const replayed = await readJsonLines(path.join(ROOT, WORK_DIR, 'results.jsonl'));
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
    if (!stateMatches) {
      rejected.push({
        sampleId: candidate.sampleId,
        reason: 'replay_mismatch',
        stateMatches,
        ratingsMatch,
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

  const workEvidence = await readJsonLines(path.join(ROOT, WORK_DIR, 'evidence.jsonl'));
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
