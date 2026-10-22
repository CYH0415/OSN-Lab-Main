import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "outputs", "tree_screenshots");
const WIDTH = 1600;
const HEIGHT = 900;

const decks = [
  {
    slug: "game",
    title: "Game Questionnaire",
    json: path.join(ROOT, "data_categories", "game", "question_graph.json"),
    png: path.join(OUT_DIR, "game_question_graph_ppt.png"),
    html: path.join(OUT_DIR, "game_question_graph_ppt.html"),
    accent: "#2f66e8",
  },
  {
    slug: "all_other",
    title: "All Other App Types",
    json: path.join(ROOT, "data_categories", "all_other_app_types", "question_graph.json"),
    png: path.join(OUT_DIR, "all_other_question_graph_ppt.png"),
    html: path.join(OUT_DIR, "all_other_question_graph_ppt.html"),
    accent: "#7b3fe4",
  },
];

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  for (const config of decks) {
    const graph = JSON.parse(await fs.readFile(config.json, "utf8"));
    const model = buildModel(graph);
    const html = renderHtml(config, model);
    await fs.writeFile(config.html, html);
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
    await page.goto(pathToFileURL(config.html).href);
    await page.screenshot({ path: config.png, fullPage: false });
    await page.close();
    console.log(config.png);
  }
} finally {
  await browser.close();
}

function buildModel(graph) {
  const questions = graph.questions || {};
  const incoming = new Map();
  const outgoing = new Map();
  const edges = [];

  for (const [sourceId, question] of Object.entries(questions)) {
    for (const option of Object.values(question.options || {})) {
      for (const targetId of option.children || []) {
        if (!questions[targetId]) continue;
        const edge = { source: sourceId, target: targetId, label: option.label };
        edges.push(edge);
        mapPush(incoming, targetId, edge);
        mapPush(outgoing, sourceId, edge);
      }
    }
  }

  const roots = graph.roots?.length
    ? graph.roots.filter((id) => questions[id])
    : Object.keys(questions).filter((id) => !incoming.has(id));
  const nodeById = new Map(Object.entries(questions).map(([id, q], index) => [id, {
    id,
    text: q.text,
    type: q.type,
    order: Number.isFinite(q.order) ? q.order : index,
    options: Object.values(q.options || {}),
    outgoingCount: outgoing.get(id)?.length || 0,
    incomingCount: incoming.get(id)?.length || 0,
  }]));

  const overview = roots
    .map((id) => nodeById.get(id))
    .filter(Boolean)
    .sort((a, b) => a.order - b.order)
    .map((root) => {
      const childIds = [...new Set((outgoing.get(root.id) || []).map((edge) => edge.target))];
      return {
        id: root.id,
        text: root.text,
        children: childIds.map((id) => nodeById.get(id)).filter(Boolean),
        outgoingCount: root.outgoingCount,
      };
    });

  const representativeRoot = [...overview].sort((a, b) => descendantCount(b.id, outgoing) - descendantCount(a.id, outgoing))[0];
  const branch = representativeRoot ? makeBranch(representativeRoot.id, nodeById, outgoing) : [];

  return {
    nodes: nodeById.size,
    edges: edges.length,
    roots: roots.length,
    conflicts: graph.conflicts?.length || 0,
    overview,
    branch,
  };
}

function mapPush(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function descendantCount(rootId, outgoing) {
  const seen = new Set();
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    for (const edge of outgoing.get(id) || []) {
      if (seen.has(edge.target)) continue;
      seen.add(edge.target);
      queue.push(edge.target);
    }
  }
  return seen.size;
}

function makeBranch(rootId, nodeById, outgoing) {
  const branch = [];
  let current = rootId;
  const seen = new Set();

  for (let depth = 0; depth < 4 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const node = nodeById.get(current);
    const nextEdges = [...(outgoing.get(current) || [])]
      .filter((edge) => nodeById.has(edge.target))
      .sort((a, b) => descendantCount(b.target, outgoing) - descendantCount(a.target, outgoing));
    branch.push({
      node,
      edges: nextEdges.slice(0, depth < 2 ? 5 : 4).map((edge) => ({
        label: edge.label,
        child: nodeById.get(edge.target),
        count: descendantCount(edge.target, outgoing),
      })),
    });
    current = nextEdges[0]?.target;
  }
  return branch;
}

function renderHtml(config, model) {
  const rootCards = model.overview.map((root, index) => {
    const childText = root.children.length
      ? `<span>${root.children.length} child node${root.children.length === 1 ? "" : "s"}</span>`
      : "<span>No child question</span>";
    return `<article class="root-card">
      <div class="root-index">${index + 1}</div>
      <div class="root-main">
        <div class="root-text">${escapeHtml(short(root.text, 105))}</div>
        <div class="root-children">${childText}</div>
      </div>
    </article>`;
  }).join("");

  const branchCols = model.branch.map((item, index) => {
    const fanout = item.edges.map((edge, edgeIndex) => `<div class="child ${edgeIndex === 0 ? "primary" : ""}">
      <div class="edge-label">${escapeHtml(short(edge.label, 46))}</div>
      <div class="child-text">${escapeHtml(short(edge.child.text, 92))}</div>
      <div class="child-meta">${edge.count ? `${edge.count} descendants` : "leaf"}</div>
    </div>`).join("");
    return `<section class="branch-col">
      <div class="depth">Depth ${index}</div>
      <div class="focus-node">
        <div class="node-type">${escapeHtml(item.node.type || "question")}</div>
        <div class="focus-text">${escapeHtml(short(item.node.text, 150))}</div>
      </div>
      <div class="fanout">${fanout}</div>
    </section>`;
  }).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.title)} PPT Tree</title>
<style>
  :root {
    --accent: ${config.accent};
    --accent-soft: color-mix(in srgb, var(--accent) 12%, white);
    --ink: #1f2933;
    --muted: #657482;
    --line: #d8dee6;
    --root: #156f5b;
    --root-soft: #dff3ed;
    --bg: #f6f7f9;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    overflow: hidden;
    background: white;
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  }
  .page {
    width: 100%;
    height: 100%;
    padding: 34px 42px;
    background: linear-gradient(#ffffff, #f9fbfd);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
    height: 112px;
  }
  h1 {
    margin: 0;
    font-size: 42px;
    line-height: 1;
    letter-spacing: 0;
  }
  .subtitle {
    margin-top: 12px;
    font-size: 20px;
    color: var(--muted);
    font-weight: 650;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 124px);
    gap: 10px;
  }
  .stat {
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: #fff;
  }
  .stat strong {
    display: block;
    font-size: 30px;
    line-height: 1;
    color: var(--accent);
  }
  .stat span {
    display: block;
    margin-top: 6px;
    font-size: 14px;
    color: var(--muted);
    font-weight: 650;
  }
  .section-title {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 30px;
    margin: 0 0 10px;
    font-size: 18px;
    font-weight: 800;
    color: var(--ink);
  }
  .section-title::before {
    content: "";
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
  }
  .overview {
    height: 260px;
    margin-top: 8px;
  }
  .root-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 8px;
  }
  .root-card {
    height: 102px;
    display: grid;
    grid-template-columns: 26px 1fr;
    gap: 8px;
    padding: 9px;
    border: 1px solid #b8d8cf;
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 3px 9px rgba(31, 41, 51, 0.05);
    overflow: hidden;
  }
  .root-index {
    width: 25px;
    height: 25px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--root-soft);
    color: var(--root);
    font-weight: 850;
    font-size: 13px;
  }
  .root-text {
    height: 50px;
    font-size: 11px;
    line-height: 1.25;
    font-weight: 800;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .root-children {
    display: flex;
    gap: 5px;
    flex-wrap: nowrap;
    margin-top: 7px;
    overflow: hidden;
  }
  .root-children span {
    max-width: 100%;
    padding: 3px 6px;
    border-radius: 999px;
    background: #eef2f6;
    color: var(--muted);
    font-size: 9px;
    line-height: 1.15;
    font-weight: 700;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .branch-wrap {
    height: 430px;
    margin-top: 14px;
  }
  .branch {
    position: relative;
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 18px;
    height: 345px;
  }
  .branch::before {
    content: "";
    position: absolute;
    left: 11%;
    right: 11%;
    top: 106px;
    border-top: 3px solid #b9c6d3;
  }
  .branch-col {
    position: relative;
    padding: 0 4px;
  }
  .depth {
    width: max-content;
    margin: 0 auto 8px;
    padding: 4px 11px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 13px;
    font-weight: 850;
  }
  .focus-node {
    position: relative;
    min-height: 116px;
    padding: 14px 14px 12px;
    border: 2px solid var(--accent);
    border-radius: 8px;
    background: #fff;
    box-shadow: 0 10px 24px rgba(31, 41, 51, 0.09);
    z-index: 1;
  }
  .node-type {
    display: inline-block;
    margin-bottom: 8px;
    padding: 3px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 12px;
    font-weight: 850;
  }
  .focus-text {
    font-size: 18px;
    line-height: 1.2;
    font-weight: 850;
  }
  .fanout {
    display: grid;
    gap: 7px;
    margin-top: 12px;
  }
  .child {
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-left: 5px solid #b9c6d3;
    border-radius: 8px;
    background: #fff;
  }
  .child.primary {
    border-left-color: var(--accent);
    background: #fbfdff;
  }
  .edge-label {
    color: var(--accent);
    font-size: 12px;
    font-weight: 850;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .child-text {
    margin-top: 3px;
    font-size: 12px;
    line-height: 1.18;
    font-weight: 750;
  }
  .child-meta {
    margin-top: 4px;
    font-size: 10px;
    color: var(--muted);
    font-weight: 750;
  }
</style>
</head>
<body>
  <main class="page">
    <header>
      <div>
        <h1>${escapeHtml(config.title)}</h1>
        <div class="subtitle">Real question graph screenshot: root forest plus representative expanded branch</div>
      </div>
      <div class="stats">
        <div class="stat"><strong>${model.roots}</strong><span>Root questions</span></div>
        <div class="stat"><strong>${model.nodes}</strong><span>Questions</span></div>
        <div class="stat"><strong>${model.edges}</strong><span>Edges</span></div>
        <div class="stat"><strong>${model.conflicts}</strong><span>Conflicts</span></div>
      </div>
    </header>
    <section class="overview">
      <h2 class="section-title">Root-level forest overview</h2>
      <div class="root-grid">${rootCards}</div>
    </section>
    <section class="branch-wrap">
      <h2 class="section-title">Representative deep branch with real option-triggered child questions</h2>
      <div class="branch">${branchCols}</div>
    </section>
  </main>
</body>
</html>`;
}

function short(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
