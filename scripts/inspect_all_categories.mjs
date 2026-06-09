import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const rootOutDir = process.env.CATEGORY_OUT_ROOT || 'data_categories';
const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
const expectedAccount = process.env.EXPECTED_GOOGLE_ACCOUNT || 'mengshu0715@gmail.com';

const traversalDefaults = {
  MAX_STATES: '5000',
  MAX_PROBES: '20000',
  MAX_DEPTH: '100',
  PAUSE_MS: '20',
  MAX_NORMALIZE_PASSES: '120',
};

function slug(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function run(command, args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolveRun({ stdout, stderr });
      } else {
        const error = new Error(`${command} ${args.join(' ')} exited with code ${code}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function parseJsonArrayFromOutput(output) {
  const start = output.lastIndexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not parse category list from inspect output.');
  }
  return JSON.parse(output.slice(start, end + 1));
}

async function main() {
  await mkdir(rootOutDir, { recursive: true });

  console.log('Reading available IARC categories...');
  const listed = await run('node', ['scripts/inspect_questionnaire.mjs'], {
    CDP_URL: cdpUrl,
    EXPECTED_GOOGLE_ACCOUNT: expectedAccount,
    LIST_CATEGORIES: '1',
    PAUSE_MS: process.env.PAUSE_MS || traversalDefaults.PAUSE_MS,
  });

  const categories = parseJsonArrayFromOutput(listed.stdout);
  if (!categories.length) throw new Error('No IARC categories found.');
  console.log(`Found ${categories.length} categories: ${categories.join(', ')}`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    rootOutDir: resolve(rootOutDir),
    categories: [],
  };

  for (const category of categories) {
    const outDir = `${rootOutDir}/${slug(category)}`;
    await mkdir(outDir, { recursive: true });

    console.log(`\n=== Inspecting category: ${category} ===`);
    await run('node', ['scripts/inspect_questionnaire.mjs'], {
      ...traversalDefaults,
      ...Object.fromEntries(
        Object.keys(traversalDefaults)
          .filter((key) => process.env[key])
          .map((key) => [key, process.env[key]]),
      ),
      CDP_URL: cdpUrl,
      EXPECTED_GOOGLE_ACCOUNT: expectedAccount,
      SELECT_CATEGORY: '1',
      DISCARD_CHANGES: '1',
      IARC_CATEGORY: category,
      OUT_DIR: outDir,
    });

    const graphJson = `${outDir}/question_graph.json`;
    const graphHtml = `${outDir}/question_graph.html`;
    if (existsSync(graphJson)) {
      console.log(`Rendering graph preview for ${category}...`);
      await run('node', ['scripts/render_question_graph.mjs', graphJson, graphHtml], {});
    }

    manifest.categories.push({
      category,
      slug: slug(category),
      outDir: resolve(outDir),
      files: {
        questionnaireTreeJson: resolve(`${outDir}/questionnaire_tree.json`),
        questionnaireTreeMarkdown: resolve(`${outDir}/questionnaire_tree.md`),
        questionGraphJson: resolve(graphJson),
        questionGraphMarkdown: resolve(`${outDir}/question_graph.md`),
        questionGraphHtml: resolve(graphHtml),
      },
    });
  }

  const manifestPath = `${rootOutDir}/manifest.json`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\nSaved manifest: ${resolve(manifestPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
