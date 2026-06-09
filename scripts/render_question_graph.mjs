import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const defaultInput = existsSync('data/question_graph.json')
  ? 'data/question_graph.json'
  : 'data_graph_test/question_graph.json';

const inputPath = process.argv[2] || process.env.GRAPH_INPUT || defaultInput;
const outputPath = process.argv[3] || process.env.GRAPH_OUTPUT || inputPath.replace(/\.json$/i, '.html');

if (!inputPath || !existsSync(inputPath)) {
  console.error('Question graph JSON not found. Run inspect:questionnaire first, or pass an input path.');
  console.error('Usage: node scripts/render_question_graph.mjs [input.json] [output.html]');
  process.exit(1);
}

const graph = JSON.parse(await readFile(inputPath, 'utf8'));
const model = buildViewModel(graph);
const html = renderHtml(model, {
  inputPath: resolve(inputPath),
  generatedAt: new Date().toISOString(),
});

await writeFile(outputPath, html);
console.log(`Rendered ${model.nodes.length} nodes and ${model.edges.length} edges.`);
console.log(`HTML: ${resolve(outputPath)}`);

function buildViewModel(graph) {
  const questions = graph.questions || {};
  const incoming = new Map();
  const outgoing = new Map();
  const edges = [];

  for (const [sourceId, question] of Object.entries(questions)) {
    for (const option of Object.values(question.options || {})) {
      for (const targetId of option.children || []) {
        if (!questions[targetId]) continue;
        const edge = {
          id: `${sourceId}__${option.label}__${targetId}`,
          source: sourceId,
          target: targetId,
          label: option.label,
        };
        edges.push(edge);
        if (!incoming.has(targetId)) incoming.set(targetId, []);
        if (!outgoing.has(sourceId)) outgoing.set(sourceId, []);
        incoming.get(targetId).push(edge);
        outgoing.get(sourceId).push(edge);
      }
    }
  }

  const roots = graph.roots?.length
    ? graph.roots.filter((id) => questions[id])
    : Object.keys(questions).filter((id) => !incoming.has(id));

  const depth = computeDepths(roots, questions, outgoing);

  const nodes = Object.entries(questions).map(([id, question], index) => ({
    id,
    shortId: shortId(id),
    text: question.text,
    type: question.type,
    order: Number.isFinite(question.order) ? question.order : index,
    depth: depth.get(id) ?? 0,
    isRoot: roots.includes(id),
    optionCount: Object.keys(question.options || {}).length,
    outgoingCount: outgoing.get(id)?.length || 0,
    incomingCount: incoming.get(id)?.length || 0,
    options: Object.values(question.options || {}).map((option) => ({
      label: option.label,
      children: option.children || [],
    })),
  }));

  return {
    generatedAt: graph.generatedAt,
    sourceUrl: graph.sourceUrl,
    category: graph.category,
    conflicts: graph.conflicts || [],
    roots,
    nodes,
    edges,
  };
}

function computeDepths(roots, questions, outgoing) {
  const depth = new Map();
  const queue = roots.map((id) => ({ id, depth: 0 }));

  while (queue.length) {
    const item = queue.shift();
    const previous = depth.get(item.id);
    if (previous !== undefined && previous <= item.depth) continue;
    depth.set(item.id, item.depth);

    for (const edge of outgoing.get(item.id) || []) {
      if (questions[edge.target]) queue.push({ id: edge.target, depth: item.depth + 1 });
    }
  }

  return depth;
}

function shortId(id) {
  return id.replace(/_[0-9a-f]{8,10}$/i, '').replace(/_/g, ' ').slice(0, 54);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(model, meta) {
  const data = JSON.stringify(model).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Question Graph Preview</title>
  <style>
    :root {
      --bg: #f6f7f9;
      --panel: #ffffff;
      --ink: #1f2933;
      --muted: #657482;
      --line: #d8dee6;
      --accent: #146c94;
      --accent-soft: #d9edf5;
      --root: #156f5b;
      --root-soft: #dff3ed;
      --warn: #9a5b00;
      --warn-soft: #fff1cf;
      --shadow: 0 10px 30px rgba(31, 41, 51, 0.09);
    }

    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--ink);
      background: var(--bg);
    }

    .app {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 380px;
      min-height: 100vh;
    }

    header {
      grid-column: 1 / -1;
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 14px 18px;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      position: sticky;
      top: 0;
      z-index: 5;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .meta {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .toolbar {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    input, select, button {
      font: inherit;
      border: 1px solid var(--line);
      background: #fff;
      color: var(--ink);
      border-radius: 6px;
      height: 34px;
    }

    input[type="search"] {
      width: 260px;
      padding: 0 10px;
    }

    select { padding: 0 8px; }

    button {
      padding: 0 10px;
      cursor: pointer;
    }

    button.active {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--accent);
    }

    .zoom-control {
      display: flex;
      align-items: center;
      gap: 6px;
      height: 34px;
      padding: 0 8px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
    }

    .zoom-control button {
      width: 26px;
      height: 26px;
      padding: 0;
      border: 0;
      background: transparent;
    }

    .zoom-control input[type="range"] {
      width: 120px;
      height: 24px;
      accent-color: var(--accent);
    }

    .zoom-value {
      min-width: 42px;
      color: var(--muted);
      font-size: 12px;
      text-align: right;
    }

    main {
      min-width: 0;
      padding: 16px;
      overflow: auto;
    }

    aside {
      border-left: 1px solid var(--line);
      background: var(--panel);
      padding: 16px;
      overflow: auto;
      max-height: calc(100vh - 63px);
      position: sticky;
      top: 63px;
    }

    .stats {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 12px;
    }

    .stat {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 10px;
      box-shadow: 0 1px 3px rgba(31, 41, 51, 0.04);
    }

    .stat strong {
      display: block;
      font-size: 18px;
    }

    .graph {
      position: relative;
      min-width: 640px;
      min-height: 160px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .graph-content {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
    }

    svg.edges {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }

    .node {
      position: absolute;
      width: 320px;
      min-height: 112px;
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 8px;
      padding: 12px;
      box-shadow: 0 4px 12px rgba(31, 41, 51, 0.08);
      cursor: pointer;
      text-align: left;
    }

    .node.root {
      border-color: #8ccbbb;
      background: var(--root-soft);
    }

    .node.selected {
      outline: 3px solid rgba(20, 108, 148, 0.25);
      border-color: var(--accent);
    }

    .node.dimmed {
      opacity: 0.25;
    }

    .node-text {
      color: var(--ink);
      font-size: 13px;
      font-weight: 650;
      display: -webkit-box;
      -webkit-line-clamp: 4;
      -webkit-box-orient: vertical;
      overflow: hidden;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    .badges {
      display: flex;
      gap: 5px;
      margin-top: 8px;
      flex-wrap: wrap;
    }

    .badge {
      font-size: 11px;
      border-radius: 999px;
      padding: 2px 7px;
      background: #eef2f6;
      color: var(--muted);
    }

    .badge.root {
      background: var(--root-soft);
      color: var(--root);
    }

    .edge {
      stroke: #93a4b5;
      stroke-width: 1.6;
      fill: none;
    }

    .edge.highlight {
      stroke: var(--accent);
      stroke-width: 3;
    }

    .edge-label {
      font-size: 11px;
      fill: #52616f;
      paint-order: stroke;
      stroke: #fff;
      stroke-width: 5px;
      stroke-linejoin: round;
    }

    .edge-label.highlight {
      fill: var(--accent);
      font-weight: 650;
    }

    .detail-empty {
      color: var(--muted);
      padding: 18px;
      border: 1px dashed var(--line);
      border-radius: 8px;
    }

    .detail h2 {
      margin: 0 0 8px;
      font-size: 16px;
    }

    .detail .qid {
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11px;
      overflow-wrap: anywhere;
      margin-bottom: 14px;
    }

    .option {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px;
      margin: 10px 0;
    }

    .option-name {
      font-weight: 650;
      margin-bottom: 6px;
    }

    .child-list {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
    }

    .child-list li {
      margin: 4px 0;
      cursor: pointer;
    }

    .warning {
      border: 1px solid #f0ce80;
      background: var(--warn-soft);
      color: var(--warn);
      border-radius: 8px;
      padding: 10px;
      margin-bottom: 12px;
    }

    @media (max-width: 1050px) {
      .app { grid-template-columns: 1fr; }
      aside {
        position: static;
        max-height: none;
        border-left: 0;
        border-top: 1px solid var(--line);
      }
      header { align-items: flex-start; flex-wrap: wrap; }
      .toolbar { margin-left: 0; width: 100%; flex-wrap: wrap; }
      input[type="search"] { width: min(100%, 320px); }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div>
        <h1>Question Graph Preview</h1>
        <div class="meta">${escapeHtml(meta.inputPath)}</div>
      </div>
      <div class="toolbar">
        <input id="search" type="search" placeholder="Search question text or id">
        <select id="depthFilter" title="Depth filter"></select>
        <div class="zoom-control" aria-label="Graph zoom">
          <button id="zoomOut" type="button" title="Zoom out">-</button>
          <input id="zoomRange" type="range" min="5" max="150" step="5" value="100" title="Zoom">
          <button id="zoomIn" type="button" title="Zoom in">+</button>
          <span id="zoomValue" class="zoom-value">100%</span>
        </div>
        <button id="fit">Fit</button>
        <button id="resetZoom">100%</button>
        <button id="showRoots">Roots</button>
      </div>
    </header>
    <main>
      <div class="stats" id="stats"></div>
      <div class="graph" id="graph">
        <div class="graph-content" id="graphContent">
          <svg class="edges" id="edges" aria-hidden="true">
            <defs>
              <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L0,6 L9,3 z" fill="#93a4b5"></path>
              </marker>
              <marker id="arrowHighlight" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto" markerUnits="strokeWidth">
                <path d="M0,0 L0,6 L9,3 z" fill="#146c94"></path>
              </marker>
            </defs>
          </svg>
        </div>
      </div>
    </main>
    <aside>
      <div id="detail" class="detail-empty">Select a node to inspect its options and children.</div>
    </aside>
  </div>
  <script>
    const model = ${data};
    const state = {
      selected: null,
      search: '',
      depth: 'all',
      rootOnly: false,
      zoom: 1,
      baseWidth: 980,
      baseHeight: 680,
    };
    const nodeById = new Map(model.nodes.map(node => [node.id, node]));
    const incoming = new Map();
    const outgoing = new Map();
    for (const edge of model.edges) {
      if (!incoming.has(edge.target)) incoming.set(edge.target, []);
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      incoming.get(edge.target).push(edge);
      outgoing.get(edge.source).push(edge);
    }

    const graphEl = document.getElementById('graph');
    const graphContentEl = document.getElementById('graphContent');
    const svgEl = document.getElementById('edges');
    const detailEl = document.getElementById('detail');
    const searchEl = document.getElementById('search');
    const depthEl = document.getElementById('depthFilter');
    const fitEl = document.getElementById('fit');
    const resetZoomEl = document.getElementById('resetZoom');
    const zoomOutEl = document.getElementById('zoomOut');
    const zoomInEl = document.getElementById('zoomIn');
    const zoomRangeEl = document.getElementById('zoomRange');
    const zoomValueEl = document.getElementById('zoomValue');
    const rootsEl = document.getElementById('showRoots');

    init();

    function init() {
      renderStats();
      layout();
      renderDepthFilter();
      renderDetail(null);
      searchEl.addEventListener('input', () => {
        state.search = searchEl.value.trim().toLowerCase();
        renderVisibility();
      });
      depthEl.addEventListener('change', () => {
        state.depth = depthEl.value;
        renderVisibility();
      });
      rootsEl.addEventListener('click', () => {
        state.rootOnly = !state.rootOnly;
        rootsEl.classList.toggle('active', state.rootOnly);
        renderVisibility();
      });
      fitEl.addEventListener('click', () => {
        fitGraph();
      });
      resetZoomEl.addEventListener('click', () => {
        setZoom(1);
      });
      zoomOutEl.addEventListener('click', () => {
        setZoom(state.zoom - 0.05);
      });
      zoomInEl.addEventListener('click', () => {
        setZoom(state.zoom + 0.05);
      });
      zoomRangeEl.addEventListener('input', () => {
        setZoom(Number(zoomRangeEl.value) / 100);
      });
      window.addEventListener('resize', () => {
        drawEdges();
        applyZoom();
      });
    }

    function renderStats() {
      const stats = [
        ['Questions', model.nodes.length],
        ['Edges', model.edges.length],
        ['Roots', model.roots.length],
        ['Conflicts', model.conflicts.length],
      ];
      document.getElementById('stats').innerHTML = stats.map(([label, value]) =>
        '<div class="stat"><strong>' + value + '</strong>' + label + '</div>'
      ).join('');
      if (model.conflicts.length) {
        document.getElementById('stats').insertAdjacentHTML('beforeend',
          '<div class="warning">Conflicts detected: some option children changed by context.</div>'
        );
      }
    }

    function renderDepthFilter() {
      const depths = [...new Set(model.nodes.map(node => node.depth))].sort((a, b) => a - b);
      depthEl.innerHTML = '<option value="all">All depths</option>' +
        depths.map(depth => '<option value="' + depth + '">Depth ' + depth + '</option>').join('');
    }

    function layout() {
      const nodeWidth = 320;
      const nodeHeight = 112;
      const colWidth = 380;
      const rowHeight = 190;
      const margin = 28;

      const placed = new Set();
      let column = 0;
      let maxDepth = 0;

      function orderedChildren(node) {
        const seen = new Set();
        const children = [];
        for (const option of node.options) {
          for (const child of option.children) {
            if (nodeById.has(child) && !seen.has(child)) {
              seen.add(child);
              children.push(child);
            }
          }
        }
        return children;
      }

      function placeTree(id, preferredDepth) {
        const node = nodeById.get(id);
        if (!node || placed.has(id)) return;
        const parentDepths = (incoming.get(id) || [])
          .map(edge => nodeById.get(edge.source)?.depth)
          .filter(depth => Number.isFinite(depth));
        const depth = Math.max(
          Number.isFinite(preferredDepth) ? preferredDepth : 0,
          parentDepths.length ? Math.max(...parentDepths) + 1 : 0,
          Number.isFinite(node.depth) ? node.depth : 0,
        );
        node.depth = depth;
        node.x = margin + column * colWidth;
        node.y = margin + depth * rowHeight;
        placed.add(id);
        column += 1;
        maxDepth = Math.max(maxDepth, depth);

        for (const child of orderedChildren(node)) {
          placeTree(child, depth + 1);
        }
      }

      const orderedRoots = model.roots
        .map(id => nodeById.get(id))
        .filter(Boolean)
        .sort((a, b) => a.order - b.order)
        .map(node => node.id);
      for (const root of orderedRoots) placeTree(root, 0);

      for (const node of [...model.nodes].sort((a, b) => a.order - b.order)) {
        placeTree(node.id, node.depth);
      }

      state.baseWidth = Math.max(980, margin * 2 + column * colWidth + nodeWidth);
      state.baseHeight = Math.max(680, margin * 2 + maxDepth * rowHeight + nodeHeight);
      graphContentEl.style.width = state.baseWidth + 'px';
      graphContentEl.style.height = state.baseHeight + 'px';
      svgEl.setAttribute('viewBox', '0 0 ' + state.baseWidth + ' ' + state.baseHeight);
      applyZoom();

      for (const node of model.nodes) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'node' + (node.isRoot ? ' root' : '');
        el.id = 'node-' + cssEscape(node.id);
        el.style.left = node.x + 'px';
        el.style.top = node.y + 'px';
        el.dataset.id = node.id;
        el.title = node.text;
        el.innerHTML =
          '<div class="node-text">' + escapeHtml(node.text) + '</div>' +
          '<div class="badges">' +
          (node.isRoot ? '<span class="badge root">root</span>' : '') +
          '<span class="badge">d' + node.depth + '</span>' +
          '<span class="badge">' + node.type + '</span>' +
          '<span class="badge">' + node.outgoingCount + ' out</span>' +
          '</div>';
        el.addEventListener('click', () => selectNode(node.id));
        graphContentEl.appendChild(el);
      }

      drawEdges();
      renderVisibility();
    }

    function clampZoom(value) {
      return Math.max(0.05, Math.min(1.5, value));
    }

    function setZoom(value) {
      const previousZoom = state.zoom;
      const nextZoom = clampZoom(value);
      if (Math.abs(previousZoom - nextZoom) < 0.001) return;

      const scrollEl = graphEl.closest('main');
      const scrollRatioX = scrollEl.scrollLeft / Math.max(1, state.baseWidth * previousZoom);
      const scrollRatioY = scrollEl.scrollTop / Math.max(1, state.baseHeight * previousZoom);
      state.zoom = nextZoom;
      applyZoom();
      scrollEl.scrollLeft = scrollRatioX * state.baseWidth * nextZoom;
      scrollEl.scrollTop = scrollRatioY * state.baseHeight * nextZoom;
    }

    function applyZoom() {
      const scaledWidth = Math.max(640, Math.ceil(state.baseWidth * state.zoom));
      const scaledHeight = Math.max(160, Math.ceil(state.baseHeight * state.zoom));
      graphEl.style.width = scaledWidth + 'px';
      graphEl.style.height = scaledHeight + 'px';
      graphContentEl.style.transform = 'scale(' + state.zoom + ')';
      zoomRangeEl.value = String(Math.round(state.zoom * 100));
      zoomValueEl.textContent = Math.round(state.zoom * 100) + '%';
    }

    function fitGraph() {
      const mainEl = graphEl.closest('main');
      const availableWidth = Math.max(320, mainEl.clientWidth - 32);
      const viewportHeight = Math.max(320, window.innerHeight - graphEl.getBoundingClientRect().top - 24);
      const availableHeight = Math.min(Math.max(320, viewportHeight), state.baseHeight);
      const fit = Math.min(1, availableWidth / state.baseWidth, availableHeight / state.baseHeight);
      setZoom(fit);
      mainEl.scrollTo({ left: 0, top: 0, behavior: 'smooth' });
    }

    function drawEdges() {
      svgEl.setAttribute('width', state.baseWidth);
      svgEl.setAttribute('height', state.baseHeight);
      const nodeWidth = 320;
      const nodeHeight = 112;
      const lines = model.edges.map(edge => {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        if (!source || !target) return '';
        const x1 = source.x + nodeWidth / 2;
        const y1 = source.y + nodeHeight;
        const x2 = target.x + nodeWidth / 2;
        const y2 = target.y;
        const midY = y2 > y1 ? y1 + Math.max(28, (y2 - y1) * 0.55) : y1 + 44;
        const path = 'M' + x1 + ',' + y1 + ' V' + midY + ' H' + x2 + ' V' + y2;
        const label = edge.label.length > 44 ? edge.label.slice(0, 41) + '...' : edge.label;
        const lx = x2;
        const ly = y2 - 10;
        return '<path class="edge" data-edge-id="' + escapeHtml(edge.id) + '" data-source="' + escapeHtml(edge.source) + '" data-target="' + escapeHtml(edge.target) + '" d="' + path + '" marker-end="url(#arrow)"></path>' +
          '<text class="edge-label" data-edge-id="' + escapeHtml(edge.id) + '" data-source="' + escapeHtml(edge.source) + '" data-target="' + escapeHtml(edge.target) + '" x="' + lx + '" y="' + ly + '" text-anchor="middle">' +
          '<title>' + escapeHtml(edge.label) + '</title>' + escapeHtml(label) + '</text>';
      }).join('');
      svgEl.querySelectorAll('path.edge,text.edge-label').forEach(el => el.remove());
      svgEl.insertAdjacentHTML('beforeend', lines);
      renderVisibility();
    }

    function selectNode(id) {
      if (state.selected === id) {
        state.selected = null;
        for (const el of document.querySelectorAll('.node')) {
          el.classList.remove('selected');
        }
        renderDetail(null);
        renderVisibility();
        return;
      }
      state.selected = id;
      for (const el of document.querySelectorAll('.node')) {
        el.classList.toggle('selected', el.dataset.id === id);
      }
      renderDetail(id);
      renderVisibility();
    }

    function renderDetail(id) {
      if (!id) {
        detailEl.className = 'detail-empty';
        detailEl.textContent = 'Select a node to inspect its options and children.';
        return;
      }
      const node = nodeById.get(id);
      detailEl.className = 'detail';
      detailEl.innerHTML =
        '<h2>Question</h2>' +
        '<div class="qid">' + escapeHtml(node.id) + '</div>' +
        '<p>' + escapeHtml(node.text) + '</p>' +
        '<div class="badges">' +
        (node.isRoot ? '<span class="badge root">root</span>' : '') +
        '<span class="badge">depth ' + node.depth + '</span>' +
        '<span class="badge">' + node.type + '</span>' +
        '<span class="badge">' + node.incomingCount + ' in</span>' +
        '<span class="badge">' + node.outgoingCount + ' out</span>' +
        '</div>' +
        '<h2 style="margin-top:18px">Options</h2>' +
        node.options.map(option => {
          const children = option.children.length
            ? '<ul class="child-list">' + option.children.map(child => {
                const childNode = nodeById.get(child);
                return '<li data-child="' + escapeHtml(child) + '">' + escapeHtml(childNode ? childNode.shortId : child) + '</li>';
              }).join('') + '</ul>'
            : '<div class="meta">No child questions</div>';
          return '<div class="option"><div class="option-name">' + escapeHtml(option.label) + '</div>' + children + '</div>';
        }).join('');
      detailEl.querySelectorAll('[data-child]').forEach(el => {
        el.addEventListener('click', () => selectNode(el.dataset.child));
      });
    }

    function renderVisibility() {
      const selectedEdges = new Set();
      const related = new Set();
      if (state.selected) {
        related.add(state.selected);
        for (const edge of outgoing.get(state.selected) || []) {
          selectedEdges.add(edge.id);
          related.add(edge.target);
        }
        for (const edge of incoming.get(state.selected) || []) {
          selectedEdges.add(edge.id);
          related.add(edge.source);
        }
      }

      for (const node of model.nodes) {
        const el = document.querySelector('[data-id="' + cssEscape(node.id) + '"]');
        const matchesSearch = !state.search ||
          node.id.toLowerCase().includes(state.search) ||
          node.text.toLowerCase().includes(state.search);
        const matchesDepth = state.depth === 'all' || String(node.depth) === state.depth;
        const matchesRoot = !state.rootOnly || node.isRoot;
        const visible = matchesSearch && matchesDepth && matchesRoot;
        el.style.display = visible ? 'block' : 'none';
        const dimmed = state.selected && !related.has(node.id);
        el.classList.toggle('dimmed', Boolean(dimmed));
      }

      for (const edgeEl of svgEl.querySelectorAll('path.edge,text.edge-label')) {
        const sourceVisible = document.querySelector('[data-id="' + cssEscape(edgeEl.dataset.source) + '"]')?.style.display !== 'none';
        const targetVisible = document.querySelector('[data-id="' + cssEscape(edgeEl.dataset.target) + '"]')?.style.display !== 'none';
        edgeEl.style.display = sourceVisible && targetVisible ? 'block' : 'none';
        const highlighted = selectedEdges.has(edgeEl.dataset.edgeId);
        edgeEl.classList.toggle('highlight', highlighted);
        if (edgeEl.matches('path.edge')) {
          edgeEl.setAttribute('marker-end', highlighted ? 'url(#arrowHighlight)' : 'url(#arrow)');
        }
      }
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    }

    function cssEscape(value) {
      if (window.CSS && CSS.escape) return CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    }
  </script>
</body>
</html>`;
}
