import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const DATASET_FILE = process.env.DATASET_FILE || 'dataset_v2/samples.jsonl';
const OUT_DIR = process.env.SNAPSHOT_UPGRADE_WORK_DIR || 'snapshot_upgrade_work';
const INCLUDE_SOCIAL = process.env.INCLUDE_SOCIAL === '1';

async function readJsonLines(file) {
  const text = await readFile(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

async function main() {
  const samples = await readJsonLines(path.join(ROOT, DATASET_FILE));
  const pending = samples
    .filter((sample) => sample.provenance?.stateSource === 'reconstructed_from_graph_and_baseline')
    .filter((sample) => INCLUDE_SOCIAL || sample.category !== 'Social or Communication')
    .map((sample) => ({
      sampleId: sample.sampleId,
      category: sample.category,
      strategy: `snapshot_upgrade:${sample.strategy || 'unknown'}`,
      answers: sample.explicitAnswers,
    }));

  await mkdir(path.join(ROOT, OUT_DIR), { recursive: true });
  const output = path.join(ROOT, OUT_DIR, 'samples.jsonl');
  await writeFile(output, pending.map((sample) => JSON.stringify(sample)).join('\n') + '\n');
  await writeFile(
    path.join(ROOT, OUT_DIR, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceDataset: DATASET_FILE,
        includeSocial: INCLUDE_SOCIAL,
        samples: pending.length,
        byCategory: Object.fromEntries(
          [...new Set(pending.map((sample) => sample.category))].map((category) => [
            category,
            pending.filter((sample) => sample.category === category).length,
          ]),
        ),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`Prepared ${pending.length} reconstructed samples in ${output}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
