import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "outputs", "tree_screenshots");
const WIDTH = 2000;
const HEIGHT = 1400;

const configs = [
  {
    title: "Game Questionnaire",
    slug: "game",
    accent: "#2F66E8",
    json: path.join(ROOT, "data_categories", "game", "question_graph.json"),
    html: path.join(OUT_DIR, "game_question_graph_full_tree.html"),
    png: path.join(OUT_DIR, "game_question_graph_full_tree.png"),
  },
  {
    title: "All Other App Types",
    slug: "all_other",
    accent: "#7B3FE4",
    json: path.join(ROOT, "data_categories", "all_other_app_types", "question_graph.json"),
    html: path.join(OUT_DIR, "all_other_question_graph_full_tree.html"),
    png: path.join(OUT_DIR, "all_other_question_graph_full_tree.png"),
  },
];

await fs.mkdir(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  for (const config of configs) {
    const graph = JSON.parse(await fs.readFile(config.json, "utf8"));
    const model = buildModel(graph);
    const html = renderHtml(config, model);
    await fs.writeFile(config.html, html);

    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 2,
    });
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
        push(incoming, targetId, edge);
        push(outgoing, sourceId, edge);
      }
    }
  }

  const roots = graph.roots?.length
    ? graph.roots.filter((id) => questions[id])
    : Object.keys(questions).filter((id) => !incoming.has(id));
  const rootIndex = new Map(roots.map((id, index) => [id, index]));
  const depth = computeDepths(roots, outgoing);
  const rootGroup = computeRootGroups(roots, outgoing, rootIndex);

  const nodes = Object.entries(questions).map(([id, question], index) => ({
    id,
    text: question.text,
    type: question.type,
    order: Number.isFinite(question.order) ? question.order : index,
    depth: depth.get(id) ?? 0,
    rootGroup: rootGroup.get(id) ?? 999,
    incomingCount: incoming.get(id)?.length || 0,
    outgoingCount: outgoing.get(id)?.length || 0,
    options: Object.values(question.options || {}),
    isRoot: roots.includes(id),
  }));

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const maxDepth = Math.max(...nodes.map((node) => node.depth));
  const columns = Array.from({ length: maxDepth + 1 }, (_, depthIndex) => nodes
    .filter((node) => node.depth === depthIndex)
    .sort((a, b) => a.rootGroup - b.rootGroup || a.order - b.order));

  const branchRoot = [...roots]
    .map((id) => nodeById.get(id))
    .filter(Boolean)
    .sort((a, b) => descendantCount(b.id, outgoing) - descendantCount(a.id, outgoing))[0];

  return {
    nodes,
    edges,
    roots,
    columns,
    maxDepth,
    branch: branchRoot ? makeRepresentativeBranch(branchRoot.id, nodeById, outgoing) : [],
    stats: {
      roots: roots.length,
      questions: nodes.length,
      edges: edges.length,
      maxDepth,
      conflicts: graph.conflicts?.length || 0,
    },
  };
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function computeDepths(roots, outgoing) {
  const depth = new Map();
  const queue = roots.map((id) => ({ id, depth: 0 }));
  while (queue.length) {
    const item = queue.shift();
    const previous = depth.get(item.id);
    if (previous !== undefined && previous <= item.depth) continue;
    depth.set(item.id, item.depth);
    for (const edge of outgoing.get(item.id) || []) {
      queue.push({ id: edge.target, depth: item.depth + 1 });
    }
  }
  return depth;
}

function computeRootGroups(roots, outgoing, rootIndex) {
  const groups = new Map();
  for (const root of roots) {
    const group = rootIndex.get(root) ?? 999;
    const queue = [root];
    while (queue.length) {
      const id = queue.shift();
      const current = groups.get(id);
      if (current !== undefined && current <= group) continue;
      groups.set(id, group);
      for (const edge of outgoing.get(id) || []) queue.push(edge.target);
    }
  }
  return groups;
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

function makeRepresentativeBranch(rootId, nodeById, outgoing) {
  const branch = [];
  const seen = new Set();
  let current = rootId;
  while (current && branch.length < 5 && !seen.has(current)) {
    seen.add(current);
    const node = nodeById.get(current);
    const nextEdges = [...(outgoing.get(current) || [])]
      .filter((edge) => nodeById.has(edge.target))
      .sort((a, b) => descendantCount(b.target, outgoing) - descendantCount(a.target, outgoing));
    branch.push({
      node,
      edgeLabel: branch.length ? "" : "root",
      nextLabel: nextEdges[0]?.label,
    });
    current = nextEdges[0]?.target;
  }
  return branch;
}

function renderHtml(config, model) {
  const tree = layoutTree(model);
  const treeSvg = renderTreeSvg(config, model, tree);
  const branchSvg = renderBranchSvg(config, model.branch);
  const stats = [
    ["Roots", model.stats.roots],
    ["Questions", model.stats.questions],
    ["Edges", model.stats.edges],
    ["Max depth", model.stats.maxDepth],
  ].map(([label, value]) => `<div class="stat"><strong>${value}</strong><span>${label}</span></div>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.title)} Full Tree</title>
<style>
  :root {
    --accent: ${config.accent};
    --ink: #1f2933;
    --muted: #657482;
    --line: #d8dee6;
    --panel: #ffffff;
    --bg: #f6f7f9;
  }
  * { box-sizing: border-box; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    margin: 0;
    overflow: hidden;
    color: var(--ink);
    background: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  }
  .page {
    width: 100%;
    height: 100%;
    padding: 34px 40px 38px;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.98), rgba(248,250,252,0.98)),
      radial-gradient(circle at 15% 0%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 35%);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    height: 118px;
  }
  h1 {
    margin: 0;
    font-size: 48px;
    line-height: 1;
    letter-spacing: 0;
  }
  .subtitle {
    margin-top: 12px;
    font-size: 21px;
    color: var(--muted);
    font-weight: 700;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 128px);
    gap: 10px;
  }
  .stat {
    height: 86px;
    padding: 13px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: rgba(255,255,255,0.88);
  }
  .stat strong {
    display: block;
    color: var(--accent);
    font-size: 32px;
    line-height: 1;
  }
  .stat span {
    display: block;
    margin-top: 7px;
    color: var(--muted);
    font-size: 14px;
    font-weight: 800;
  }
  .tree-panel {
    height: 930px;
    padding: 20px 22px 16px;
    border: 2px solid color-mix(in srgb, var(--accent) 50%, #d8dee6);
    border-radius: 10px;
    background: #fff;
    box-shadow: 0 18px 42px rgba(31, 41, 51, 0.08);
  }
  .label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    color: var(--muted);
    font-size: 16px;
    font-weight: 800;
  }
  .legend {
    display: flex;
    gap: 16px;
  }
  .legend span::before {
    content: "";
    display: inline-block;
    width: 11px;
    height: 11px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
  .legend span:nth-child(2)::before { background: #18A04D; }
  .legend span:nth-child(3)::before { background: #9AA8B6; }
  .branch-panel {
    height: 245px;
    margin-top: 22px;
    padding: 18px 22px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(255,255,255,0.9);
  }
  .branch-title {
    margin-bottom: 10px;
    color: var(--ink);
    font-size: 18px;
    font-weight: 850;
  }
  svg text {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  }
</style>
</head>
<body>
  <main class="page">
    <header>
      <div>
        <h1>${escapeHtml(config.title)}</h1>
        <div class="subtitle">Complete questionnaire tree, compressed to fit one rectangular image</div>
      </div>
      <section class="stats">${stats}</section>
    </header>
    <section class="tree-panel">
      <div class="label-row">
        <div>Full tree: every recovered question node and option-trigger edge</div>
        <div class="legend"><span>Root</span><span>Question</span><span>Shared / leaf</span></div>
      </div>
      ${treeSvg}
    </section>
    <section class="branch-panel">
      <div class="branch-title">Representative expanded branch</div>
      ${branchSvg}
    </section>
  </main>
</body>
</html>`;
}

function layoutTree(model) {
  const frame = { left: 28, top: 30, width: 1818, height: 800 };
  const maxNodeWidth = 168;
  const maxDepth = Math.max(1, model.maxDepth);
  const columnGap = (frame.width - maxNodeWidth) / maxDepth;
  const positions = new Map();
  const columnMeta = [];

  for (const [depth, column] of model.columns.entries()) {
    const count = Math.max(1, column.length);
    const step = frame.height / count;
    const nodeHeight = Math.max(7, Math.min(28, step * 0.68));
    const nodeWidth = depth === 0 ? 168 : Math.max(72, Math.min(148, columnGap * 0.48));
    const columnX = frame.left + depth * columnGap;
    columnMeta.push({ depth, count, step, nodeHeight, nodeWidth, x: columnX });

    column.forEach((node, index) => {
      const y = frame.top + step * (index + 0.5);
      positions.set(node.id, { x: columnX, y, width: nodeWidth, height: nodeHeight, showLabel: nodeHeight >= 10 });
    });
  }

  return { frame, positions, columnMeta };
}

function renderTreeSvg(config, model, tree) {
  const edgeSvg = model.edges.map((edge) => {
    const source = tree.positions.get(edge.source);
    const target = tree.positions.get(edge.target);
    if (!source || !target) return "";
    const x1 = source.x + source.width;
    const y1 = source.y;
    const x2 = target.x;
    const y2 = target.y;
    const dx = Math.max(38, (x2 - x1) * 0.42);
    const opacity = Math.abs(y2 - y1) > 260 ? 0.18 : 0.32;
    return `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} C${(x1 + dx).toFixed(1)},${y1.toFixed(1)} ${(x2 - dx).toFixed(1)},${y2.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="#7f91a3" stroke-width="1.1" opacity="${opacity}"/>`;
  }).join("");

  const columnLabels = tree.columnMeta.map((meta) => {
    return `<text x="${meta.x}" y="18" font-size="13" font-weight="800" fill="#657482">D${meta.depth} · ${meta.count}</text>`;
  }).join("");

  const nodeSvg = model.nodes.map((node) => {
    const pos = tree.positions.get(node.id);
    const fill = node.isRoot ? "#DFF3ED" : node.outgoingCount ? colorMix(config.accent, "#FFFFFF", 0.12 + Math.min(node.depth, 5) * 0.055) : "#EEF2F6";
    const stroke = node.isRoot ? "#8CCBBB" : node.incomingCount > 1 ? config.accent : "#C9D3DE";
    const label = firstWords(node.text, pos.height < 13 ? 2 : 4);
    const textY = pos.y + Math.min(4, pos.height * 0.26);
    if (pos.height < 9) {
      return `<circle cx="${pos.x + 4}" cy="${pos.y}" r="${node.isRoot ? 4.3 : 3.2}" fill="${fill}" stroke="${stroke}" stroke-width="1.1"/>`;
    }
    return `<g>
      <rect x="${pos.x}" y="${pos.y - pos.height / 2}" width="${pos.width}" height="${pos.height}" rx="${Math.min(5, pos.height / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${node.isRoot ? 1.5 : 1}"/>
      <text x="${pos.x + 6}" y="${textY}" font-size="${Math.max(6.5, Math.min(11, pos.height * 0.58))}" font-weight="${node.isRoot ? 850 : 700}" fill="#1F2933">${escapeSvg(label)}</text>
    </g>`;
  }).join("");

  return `<svg width="100%" height="850" viewBox="0 0 1874 850" role="img" aria-label="${escapeHtml(config.title)} complete tree">
    <rect x="0" y="0" width="1874" height="850" rx="8" fill="#FBFCFE"/>
    ${columnLabels}
    <g transform="translate(0 10)">${edgeSvg}${nodeSvg}</g>
  </svg>`;
}

function renderBranchSvg(config, branch) {
  const width = 1874;
  const height = 168;
  const gap = 26;
  const nodeWidth = (width - gap * (branch.length - 1)) / Math.max(1, branch.length);
  const nodes = branch.map((item, index) => {
    const x = index * (nodeWidth + gap);
    const y = 18;
    const edge = index < branch.length - 1
      ? `<path d="M${x + nodeWidth},${height / 2} H${x + nodeWidth + gap}" stroke="#94A3B8" stroke-width="2.2" marker-end="url(#branchArrow)"/>
         <text x="${x + nodeWidth + gap / 2}" y="${height / 2 - 8}" text-anchor="middle" font-size="11" font-weight="800" fill="${config.accent}">${escapeSvg(firstWords(item.nextLabel || "Yes", 2))}</text>`
      : "";
    return `<g>
      <rect x="${x}" y="${y}" width="${nodeWidth}" height="118" rx="8" fill="#FFFFFF" stroke="${config.accent}" stroke-width="2"/>
      <text x="${x + 16}" y="${y + 28}" font-size="13" font-weight="850" fill="${config.accent}">Depth ${index}</text>
      <text x="${x + 16}" y="${y + 60}" font-size="18" font-weight="850" fill="#1F2933">${escapeSvg(firstWords(item.node.text, 5))}</text>
      <text x="${x + 16}" y="${y + 88}" font-size="13" font-weight="750" fill="#657482">${escapeSvg(item.node.type || "question")}</text>
      ${edge}
    </g>`;
  }).join("");

  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <marker id="branchArrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
        <path d="M0,0 L0,6 L7,3 z" fill="#94A3B8"></path>
      </marker>
    </defs>
    ${nodes}
  </svg>`;
}

function firstWords(value, count) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, count)
    .join(" ");
}

function colorMix(hex, white, amount) {
  const c = hexToRgb(hex);
  const w = hexToRgb(white);
  const mix = (a, b) => Math.round(a * amount + b * (1 - amount));
  return `rgb(${mix(c.r, w.r)}, ${mix(c.g, w.g)}, ${mix(c.b, w.b)})`;
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeSvg(value) {
  return escapeHtml(value);
}
