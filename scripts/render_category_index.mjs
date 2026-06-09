import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const rootDir = process.argv[2] || process.env.CATEGORY_OUT_ROOT || 'data_categories';
const manifestPath = `${rootDir}/manifest.json`;
const outputPath = process.argv[3] || `${rootDir}/index.html`;

if (!existsSync(manifestPath)) {
  console.error(`Manifest not found: ${resolve(manifestPath)}`);
  process.exit(1);
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const categories = [];

for (const item of manifest.categories || []) {
  const graphPath = `${rootDir}/${item.slug}/question_graph.json`;
  const graph = JSON.parse(await readFile(graphPath, 'utf8'));
  const questionCount = Object.keys(graph.questions || {}).length;
  const edgeCount = Object.values(graph.questions || {}).reduce(
    (sum, question) =>
      sum + Object.values(question.options || {}).reduce((count, option) => count + (option.children?.length || 0), 0),
    0,
  );
  categories.push({
    category: item.category,
    slug: item.slug,
    questionCount,
    edgeCount,
    rootCount: graph.roots?.length || 0,
    conflictCount: graph.conflicts?.length || 0,
    href: `${item.slug}/question_graph.html`,
  });
}

const html = renderHtml(categories, manifest);
await writeFile(outputPath, html);
console.log(`Rendered category preview index: ${resolve(outputPath)}`);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(items, meta) {
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  const firstHref = items[0]?.href || '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>IARC Category Trees</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --panel: #ffffff;
      --ink: #1f2933;
      --muted: #637282;
      --line: #d9e0e7;
      --accent: #176c7d;
      --accent-soft: #e2f2f5;
      --warn: #9a5b00;
      --warn-soft: #fff2d6;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-columns: 320px minmax(0, 1fr);
      background: var(--bg);
      color: var(--ink);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    aside {
      min-height: 100vh;
      background: var(--panel);
      border-right: 1px solid var(--line);
      display: flex;
      flex-direction: column;
    }

    header {
      padding: 18px 18px 14px;
      border-bottom: 1px solid var(--line);
    }

    h1 {
      margin: 0 0 6px;
      font-size: 18px;
      font-weight: 680;
      letter-spacing: 0;
    }

    .meta {
      color: var(--muted);
      font-size: 12px;
    }

    .category-list {
      padding: 10px;
      display: grid;
      gap: 8px;
      overflow: auto;
    }

    .category-button {
      width: 100%;
      appearance: none;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      padding: 11px;
      text-align: left;
      cursor: pointer;
    }

    .category-button:hover {
      border-color: #b8c7d4;
    }

    .category-button.active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .category-name {
      font-weight: 650;
      margin-bottom: 8px;
      overflow-wrap: anywhere;
    }

    .stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .stat {
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 12px;
      color: var(--muted);
      background: rgba(255, 255, 255, 0.72);
    }

    .stat.warn {
      color: var(--warn);
      background: var(--warn-soft);
      border-color: #f0d18f;
    }

    main {
      min-width: 0;
      height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
    }

    .viewer-bar {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 14px;
      background: rgba(255, 255, 255, 0.88);
      border-bottom: 1px solid var(--line);
    }

    .viewer-title {
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .viewer-link {
      margin-left: auto;
      color: var(--accent);
      text-decoration: none;
      font-size: 13px;
      white-space: nowrap;
    }

    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      background: #fff;
    }

    @media (max-width: 860px) {
      body {
        grid-template-columns: 1fr;
        grid-template-rows: auto minmax(0, 1fr);
      }

      aside {
        min-height: 0;
        max-height: 280px;
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }

      main { height: calc(100vh - 280px); }
    }
  </style>
</head>
<body>
  <aside>
    <header>
      <h1>IARC Category Trees</h1>
      <div class="meta">Generated ${escapeHtml(meta.generatedAt || '')}</div>
    </header>
    <div class="category-list" id="category-list"></div>
  </aside>
  <main>
    <div class="viewer-bar">
      <div class="viewer-title" id="viewer-title"></div>
      <a class="viewer-link" id="viewer-link" href="${escapeHtml(firstHref)}" target="_blank" rel="noreferrer">Open standalone</a>
    </div>
    <iframe id="viewer" src="${escapeHtml(firstHref)}" title="Question graph preview"></iframe>
  </main>
  <script>
    const categories = ${data};
    const listEl = document.getElementById('category-list');
    const viewerEl = document.getElementById('viewer');
    const titleEl = document.getElementById('viewer-title');
    const linkEl = document.getElementById('viewer-link');
    let activeSlug = categories[0]?.slug || null;

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderList() {
      listEl.innerHTML = categories.map(item => {
        const warn = item.conflictCount ? '<span class="stat warn">' + item.conflictCount + ' conflicts</span>' : '';
        return '<button class="category-button" type="button" data-slug="' + escapeHtml(item.slug) + '">' +
          '<div class="category-name">' + escapeHtml(item.category) + '</div>' +
          '<div class="stats">' +
          '<span class="stat">' + item.questionCount + ' questions</span>' +
          '<span class="stat">' + item.edgeCount + ' edges</span>' +
          '<span class="stat">' + item.rootCount + ' roots</span>' +
          warn +
          '</div>' +
          '</button>';
      }).join('');

      for (const button of listEl.querySelectorAll('[data-slug]')) {
        button.addEventListener('click', () => selectCategory(button.dataset.slug));
      }
      updateActive();
    }

    function selectCategory(slug) {
      const item = categories.find(candidate => candidate.slug === slug);
      if (!item) return;
      activeSlug = slug;
      viewerEl.src = item.href;
      titleEl.textContent = item.category;
      linkEl.href = item.href;
      updateActive();
    }

    function updateActive() {
      for (const button of listEl.querySelectorAll('[data-slug]')) {
        button.classList.toggle('active', button.dataset.slug === activeSlug);
      }
    }

    renderList();
    if (activeSlug) selectCategory(activeSlug);
  </script>
</body>
</html>`;
}
