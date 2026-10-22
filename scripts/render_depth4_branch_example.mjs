import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, "outputs", "tree_screenshots");
const HTML = path.join(OUT_DIR, "depth4_branch_example.html");
const PNG = path.join(OUT_DIR, "depth4_branch_example.png");
const CONTENT_PNG = path.join(OUT_DIR, "depth4_branch_example_content.png");
const GRAPH = path.join(ROOT, "data_categories", "all_other_app_types", "question_graph.json");
const WIDTH = 1800;
const HEIGHT = 920;

await fs.mkdir(OUT_DIR, { recursive: true });

const graph = JSON.parse(await fs.readFile(GRAPH, "utf8"));
const model = buildBranchModel(graph);
await fs.writeFile(HTML, renderHtml(model));

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 2,
  });
  await page.goto(pathToFileURL(HTML).href);
  await page.screenshot({ path: PNG, fullPage: false });
  await page.locator(".tree-panel").screenshot({ path: CONTENT_PNG });
  await page.close();
  console.log(PNG);
  console.log(CONTENT_PNG);
} finally {
  await browser.close();
}

function buildBranchModel(graph) {
  const questions = graph.questions || {};
  const outgoing = new Map();
  const incoming = new Map();

  for (const [sourceId, question] of Object.entries(questions)) {
    for (const option of Object.values(question.options || {})) {
      for (const targetId of option.children || []) {
        if (!questions[targetId]) continue;
        const edge = { source: sourceId, target: targetId, label: option.label };
        push(outgoing, sourceId, edge);
        push(incoming, targetId, edge);
      }
    }
  }

  const rootId = "does_the_app_contain_any_ratings_relevant_content_e_g_se_1bdb46b7";
  const gamblingId = "does_the_app_contain_gambling_simulations_of_casino_gamb_e4e21264";

  const nodes = new Map();
  const edges = [];

  addNode(rootId, 0);
  addNode(gamblingId, 1);
  edges.push({ source: rootId, target: gamblingId, label: "Yes" });

  collectSubtree(gamblingId, 1, 4, new Set([rootId]));

  const columns = Array.from({ length: 5 }, (_, depth) =>
    [...nodes.values()]
      .filter((node) => node.depth === depth)
      .sort((a, b) => a.order - b.order || a.text.localeCompare(b.text)),
  );

  return {
    nodes: [...nodes.values()],
    edges,
    columns,
    stats: {
      questions: nodes.size,
      edges: edges.length,
      depth: 4,
    },
  };

  function collectSubtree(id, depth, maxDepth, seen) {
    if (depth >= maxDepth) return;
    for (const edge of outgoing.get(id) || []) {
      addNode(edge.target, depth + 1);
      edges.push(edge);
      if (!seen.has(edge.target)) {
        seen.add(edge.target);
        collectSubtree(edge.target, depth + 1, maxDepth, seen);
      }
    }
  }

  function addNode(id, depth) {
    if (!questions[id]) return;
    const existing = nodes.get(id);
    if (existing) {
      existing.depth = Math.min(existing.depth, depth);
      return;
    }
    nodes.set(id, {
      id,
      depth,
      text: questions[id].text,
      type: questions[id].type,
      order: Number.isFinite(questions[id].order) ? questions[id].order : nodes.size,
      incomingCount: incoming.get(id)?.length || 0,
      outgoingCount: outgoing.get(id)?.length || 0,
      isRoot: depth === 0,
    });
  }
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function renderHtml(model) {
  const svg = renderSvg(model);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gambling Branch Complete Subtree</title>
<style>
  :root {
    --accent: #7b3fe4;
    --blue: #2f66e8;
    --green: #18a04d;
    --ink: #1f2933;
    --muted: #657482;
    --line: #d8dee6;
  }
  * { box-sizing: border-box; }
  body {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    margin: 0;
    overflow: hidden;
    color: var(--ink);
    background: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  }
  .canvas {
    width: 100%;
    height: 100%;
    padding: 40px 48px;
    background:
      linear-gradient(180deg, rgba(255,255,255,0.98), rgba(246,248,252,0.98)),
      radial-gradient(circle at 8% 8%, rgba(123,63,228,0.1), transparent 34%);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    height: 104px;
  }
  h1 {
    margin: 0;
    font-size: 44px;
    line-height: 1;
    letter-spacing: 0;
  }
  .subtitle {
    margin-top: 12px;
    color: var(--muted);
    font-size: 21px;
    font-weight: 750;
  }
  .stats {
    display: grid;
    grid-template-columns: repeat(3, 120px);
    gap: 10px;
  }
  .stat {
    height: 82px;
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: rgba(255,255,255,0.9);
  }
  .stat strong {
    display: block;
    color: var(--accent);
    font-size: 30px;
    line-height: 1;
  }
  .stat span {
    display: block;
    margin-top: 7px;
    color: var(--muted);
    font-size: 13px;
    font-weight: 850;
  }
  .tree-panel {
    height: 690px;
    padding: 20px 22px 16px;
    border: 2px solid rgba(123,63,228,0.48);
    border-radius: 12px;
    background: rgba(255,255,255,0.95);
    box-shadow: 0 18px 42px rgba(31,41,51,0.08);
  }
  .label-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
    color: var(--muted);
    font-size: 16px;
    font-weight: 850;
  }
  .legend {
    display: flex;
    gap: 14px;
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
  .legend span:nth-child(2)::before { background: var(--green); }
  .legend span:nth-child(3)::before { background: #9aa8b6; }
  .note {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin-top: 20px;
  }
  .note div {
    min-height: 82px;
    padding: 15px 18px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: rgba(255,255,255,0.92);
  }
  .note strong {
    display: block;
    margin-bottom: 6px;
    color: var(--accent);
    font-size: 18px;
  }
  .note span {
    color: var(--ink);
    font-size: 15px;
    line-height: 1.25;
    font-weight: 720;
  }
  svg text {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  }
</style>
</head>
<body>
  <main class="canvas">
    <header>
      <div>
        <h1>Complete Depth-4 Branch Example</h1>
        <div class="subtitle">All Other App Types: gambling branch, shown as a complete recovered subtree</div>
      </div>
      <section class="stats">
        <div class="stat"><strong>${model.stats.questions}</strong><span>Questions</span></div>
        <div class="stat"><strong>${model.stats.edges}</strong><span>Edges</span></div>
        <div class="stat"><strong>${model.stats.depth}</strong><span>Max depth</span></div>
      </section>
    </header>
    <section class="tree-panel">
      <div class="label-row">
        <div>Complete branch: all recovered questions and option-trigger edges in this subtree</div>
        <div class="legend"><span>Root</span><span>Branch</span><span>Leaf</span></div>
      </div>
      ${svg}
    </section>
    <section class="note">
      <div><strong>Why this branch?</strong><span>It is rating-relevant and demonstrates conditional follow-ups without relying on sensitive examples.</span></div>
      <div><strong>What is complete?</strong><span>The diagram includes all recovered child questions under this gambling subtree up to depth 4.</span></div>
      <div><strong>Why it matters</strong><span>Sampling must cover both shallow leaves and deeper monetary-reward paths.</span></div>
    </section>
  </main>
</body>
</html>`;
}

function renderSvg(model) {
  const width = 1648;
  const height = 600;
  const frame = { left: 24, top: 38, width: 1588, height: 520 };
  const maxNodeWidth = 270;
  const colGap = (frame.width - maxNodeWidth) / 4;
  const positions = new Map();

  model.columns.forEach((column, depth) => {
    const count = Math.max(1, column.length);
    const step = frame.height / count;
    const nodeW = depth === 0 ? 250 : depth === 4 ? 270 : 245;
    const nodeH = Math.min(94, Math.max(48, step * 0.72));
    column.forEach((node, index) => {
      positions.set(node.id, {
        x: frame.left + depth * colGap,
        y: frame.top + step * (index + 0.5),
        width: nodeW,
        height: nodeH,
      });
    });
  });

  const labels = model.columns.map((column, depth) => {
    const x = frame.left + depth * colGap;
    return `<text x="${x}" y="22" font-size="14" font-weight="850" fill="#657482">D${depth} · ${column.length}</text>`;
  }).join("");

  const edges = model.edges.map((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return "";
    const x1 = source.x + source.width;
    const y1 = source.y;
    const x2 = target.x;
    const y2 = target.y;
    const dx = Math.max(44, (x2 - x1) * 0.48);
    const midX = (x1 + x2) / 2;
    const label = firstWords(edge.label, edge.label.length > 28 ? 4 : 3);
    return `<path d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}" fill="none" stroke="#94A3B8" stroke-width="1.35" opacity="0.55"/>
      <text x="${midX}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle" font-size="10.5" font-weight="850" fill="#7B3FE4" paint-order="stroke" stroke="#fff" stroke-width="4">${escapeSvg(label)}</text>`;
  }).join("");

  const nodes = model.nodes.map((node) => {
    const pos = positions.get(node.id);
    const leaf = node.outgoingCount === 0 || node.depth === 4;
    const fill = node.isRoot ? "#DFF3ED" : leaf ? "#EEF2F6" : "#EFE7FF";
    const stroke = node.isRoot ? "#8CCBBB" : leaf ? "#C9D3DE" : "#9B6AF0";
    const type = node.depth === 0 ? "root question" : node.type;
    const fontSize = node.depth === 3 || node.depth === 4 ? 14 : 15;
    return `<g>
      <rect x="${pos.x}" y="${pos.y - pos.height / 2}" width="${pos.width}" height="${pos.height}" rx="8" fill="${fill}" stroke="${stroke}" stroke-width="${node.isRoot || !leaf ? 1.6 : 1.2}"/>
      <text x="${pos.x + 12}" y="${pos.y - pos.height / 2 + 21}" font-size="10.5" font-weight="850" fill="#7B3FE4">${escapeSvg(type.toUpperCase())}</text>
      ${wrapText(firstWords(node.text, node.depth >= 3 ? 11 : 9), pos.x + 12, pos.y - pos.height / 2 + 45, pos.width - 24, fontSize, 3)}
    </g>`;
  }).join("");

  return `<svg width="100%" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Complete gambling branch subtree">
    <rect x="0" y="0" width="${width}" height="${height}" rx="8" fill="#FBFCFE"/>
    ${labels}
    <g transform="translate(0 14)">${edges}${nodes}</g>
  </svg>`;
}

function wrapText(text, x, y, maxWidth, fontSize, maxLines) {
  const approxChars = Math.max(10, Math.floor(maxWidth / (fontSize * 0.54)));
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > approxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.join(" ").length > lines.join(" ").length && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].replace(/\s+\S*$/, "")}...`;
  }
  return lines.map((item, index) =>
    `<text x="${x}" y="${y + index * (fontSize + 3)}" font-size="${fontSize}" font-weight="850" fill="#1F2933">${escapeSvg(item)}</text>`,
  ).join("");
}

function firstWords(value, count) {
  return String(value || "")
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .trim()
    .split(/\s+/)
    .slice(0, count)
    .join(" ");
}

function escapeSvg(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
