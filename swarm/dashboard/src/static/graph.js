// Graph page (ARCHITECTURE 55): force-directed canvas of agents, channels, memory and work.
// Data from /api/graph (signed-in session); layout survives refreshes; still under reduced motion.
import { NODE_TYPES, buildGraph, cycleNeighbour, neighbours, search, zoomToFit } from '/graph.mjs';
import { nodeCard, renderCard } from '/graph-card.mjs';
import { applyBars } from '/bars.mjs';
import { esc } from '/render.mjs';

const $ = (id) => document.getElementById(id);
const canvas = $('g-canvas');
const ctx = canvas.getContext('2d');
const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const css = getComputedStyle(document.documentElement);
const tok = (n) => css.getPropertyValue(n).trim();
const COLORS = {
  agent: tok('--text'), channel: tok('--accent'), memory: tok('--warning'), namespace: tok('--warning'),
  epic: tok('--positive'), task: tok('--muted'), manager: tok('--accent'), department: tok('--muted'),
};
const TASK_COLOR = { merged: tok('--positive'), 'needs-human': tok('--negative'), failed: tok('--negative'), escalated: tok('--negative'), cancelled: '#55565c' };
const EDGE = { talks: 'rgba(74,138,214,.35)', wrote: 'rgba(217,164,65,.45)', mentions: 'rgba(138,140,146,.35)' };

let graph = { nodes: [], edges: [] };
let raw = null;
const pos = new Map(); // id -> { x, y, vx, vy, pinned }
const shown = new Set(NODE_TYPES);
let view = { x: 0, y: 0, k: 1 };
let hover = null;
let selected = null;
let found = new Set();
let alpha = 1;

const radius = (n) => 3 + Math.min(14, Math.sqrt(n.weight + 1) * 1.6) + (n.type === 'namespace' || n.type === 'epic' ? 2 : 0);
const colorOf = (n) => (n.type === 'task' ? TASK_COLOR[n.meta.status] ?? COLORS.task : COLORS[n.type]);
const visible = () => {
  const ids = new Set(graph.nodes.filter((n) => shown.has(n.type)).map((n) => n.id));
  return { nodes: graph.nodes.filter((n) => ids.has(n.id)), edges: graph.edges.filter((e) => ids.has(e.a) && ids.has(e.b)) };
};

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(300, r.width) * dpr;
  canvas.height = Math.max(300, r.height) * dpr;
  canvas.style.width = `${Math.max(300, r.width)}px`;
  canvas.style.height = `${Math.max(300, r.height)}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

// ---- layout: repulsion between all nodes, springs on edges, a pull to the centre.
function step() {
  const { nodes, edges } = visible();
  for (const n of nodes) if (!pos.has(n.id)) pos.set(n.id, { x: (Math.random() - 0.5) * 400, y: (Math.random() - 0.5) * 400, vx: 0, vy: 0 });
  for (let i = 0; i < nodes.length; i++) {
    const a = pos.get(nodes[i].id);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = pos.get(nodes[j].id);
      let dx = a.x - b.x; let dy = a.y - b.y;
      const d2 = dx * dx + dy * dy + 0.01;
      if (d2 > 250000) continue;
      const f = 900 / d2;
      dx *= f; dy *= f;
      a.vx += dx; a.vy += dy; b.vx -= dx; b.vy -= dy;
    }
  }
  for (const e of edges) {
    const a = pos.get(e.a); const b = pos.get(e.b);
    const dx = b.x - a.x; const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = ((d - 70) / d) * 0.04;
    a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
  }
  for (const n of nodes) {
    const p = pos.get(n.id);
    p.vx -= p.x * 0.004; p.vy -= p.y * 0.004;
    if (p.pinned) { p.vx = 0; p.vy = 0; continue; }
    p.x += Math.max(-20, Math.min(20, p.vx * alpha));
    p.y += Math.max(-20, Math.min(20, p.vy * alpha));
    p.vx *= 0.6; p.vy *= 0.6;
  }
  alpha = Math.max(0.02, alpha * 0.985);
}

function draw() {
  const w = canvas.clientWidth; const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  const { nodes, edges } = visible();
  const focus = selected ?? hover;
  const near = focus ? neighbours(graph, focus) : null;
  const sx = (x) => w / 2 + (x + view.x) * view.k;
  const sy = (y) => h / 2 + (y + view.y) * view.k;
  for (const e of edges) {
    const a = pos.get(e.a); const b = pos.get(e.b);
    if (!a || !b) continue;
    const lit = near && near.has(e.a) && near.has(e.b);
    ctx.strokeStyle = lit ? tok('--text') : EDGE[e.kind] ?? 'rgba(138,140,146,.22)';
    ctx.globalAlpha = near && !lit ? 0.15 : 1;
    ctx.lineWidth = Math.min(3, 0.6 + Math.log2(e.weight + 1) * 0.5);
    ctx.setLineDash(e.kind === 'mentions' ? [3, 3] : []);
    const fromX = sx(a.x); const fromY = sy(a.y);
    const toX = sx(b.x); const toY = sy(b.y);
    ctx.beginPath(); ctx.moveTo(fromX, fromY); ctx.lineTo(toX, toY); ctx.stroke();

    // Direction arrow on non-mentions edges
    if (e.kind !== 'mentions') {
      const angle = Math.atan2(toY - fromY, toX - fromX);
      const targetNode = graph.nodes.find((n) => n.id === e.b);
      const targetR = targetNode ? (radius(targetNode) + 2) * Math.max(0.6, Math.min(1.6, view.k)) : 6;
      const tipX = toX - Math.cos(angle) * targetR;
      const tipY = toY - Math.sin(angle) * targetR;
      const arrowLen = Math.min(7, 3 + ctx.lineWidth * 1.5);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath();
      ctx.moveTo(tipX, tipY);
      ctx.lineTo(tipX - arrowLen * Math.cos(angle - Math.PI / 6), tipY - arrowLen * Math.sin(angle - Math.PI / 6));
      ctx.lineTo(tipX - arrowLen * Math.cos(angle + Math.PI / 6), tipY - arrowLen * Math.sin(angle + Math.PI / 6));
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.setLineDash([]);
  ctx.font = `12px ${tok('--mono')}`;
  for (const n of nodes) {
    const p = pos.get(n.id);
    if (!p) continue;
    const r = radius(n) * Math.max(0.6, Math.min(1.6, view.k));
    const dim = near && !near.has(n.id);
    ctx.globalAlpha = dim ? 0.18 : 1;
    ctx.fillStyle = colorOf(n);
    ctx.beginPath();
    if (n.type === 'memory' || n.type === 'namespace') ctx.rect(sx(p.x) - r, sy(p.y) - r, r * 2, r * 2);
    else ctx.arc(sx(p.x), sy(p.y), r, 0, Math.PI * 2);
    ctx.fill();
    if (n.type === 'agent' && n.meta.status === 'online') { ctx.strokeStyle = tok('--positive'); ctx.lineWidth = 1.5; ctx.stroke(); }
    if (found.has(n.id) || n.id === selected) { ctx.strokeStyle = tok('--accent'); ctx.lineWidth = 2; ctx.stroke(); }
    if (!dim && (n.weight > 6 || near?.has(n.id) || found.has(n.id) || view.k > 1.3)) {
      ctx.fillStyle = n.id === focus ? tok('--text') : tok('--muted');
      ctx.fillText(n.label.length > 32 ? `${n.label.slice(0, 31)}…` : n.label, sx(p.x) + r + 4, sy(p.y) + 4);
    }
  }
  ctx.globalAlpha = 1;
}

function loop() {
  if (!still && alpha > 0.021) step();
  draw();
  requestAnimationFrame(loop);
}

// ---- interaction
const toWorld = (cx, cy) => ({ x: (cx - canvas.clientWidth / 2) / view.k - view.x, y: (cy - canvas.clientHeight / 2) / view.k - view.y });
function hit(cx, cy) {
  const p = toWorld(cx, cy);
  let best = null; let bestD = Infinity;
  for (const n of visible().nodes) {
    const q = pos.get(n.id);
    if (!q) continue;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < (radius(n) + 6) / Math.min(1, view.k) && d < bestD) { best = n.id; bestD = d; }
  }
  return best;
}
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  const id = hit(e.offsetX, e.offsetY);
  drag = { id, x: e.offsetX, y: e.offsetY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    const h = hit(e.offsetX, e.offsetY);
    if (h !== hover) { hover = h; canvas.style.cursor = h ? 'pointer' : 'grab'; if (still) draw(); }
    return;
  }
  const dx = e.offsetX - drag.x; const dy = e.offsetY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.id) {
    const p = pos.get(drag.id); const w = toWorld(e.offsetX, e.offsetY);
    Object.assign(p, { x: w.x, y: w.y, pinned: true });
    alpha = Math.max(alpha, 0.3);
  } else { view.x += dx / view.k; view.y += dy / view.k; }
  drag.x = e.offsetX; drag.y = e.offsetY;
  if (still) draw();
});
canvas.addEventListener('pointerup', () => {
  if (drag && !drag.moved) select(drag.id);
  drag = null;
});
canvas.addEventListener('dblclick', (e) => { const id = hit(e.offsetX, e.offsetY); if (id) { pos.get(id).pinned = false; alpha = 0.5; } });
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const before = toWorld(e.offsetX, e.offsetY);
  view.k = Math.max(0.2, Math.min(4, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  const after = toWorld(e.offsetX, e.offsetY);
  view.x += after.x - before.x; view.y += after.y - before.y;
  if (still) draw();
}, { passive: false });

// Task history (for timing) is fetched once per task on click; null until it arrives.
const histories = new Map();
async function loadHistory(id) {
  if (histories.has(id)) return;
  histories.set(id, undefined);
  try {
    const res = await fetch(`/api/history/${encodeURIComponent(id)}`, { cache: 'no-store', credentials: 'same-origin' });
    histories.set(id, res.ok ? (await res.json()).history ?? [] : []);
  } catch { histories.set(id, []); }
  if (selected === `task:${id}`) select(selected);
}
function select(id) {
  selected = id;
  const n = graph.nodes.find((x) => x.id === id);
  if (!n) { showCard(null); return draw(); }
  const taskId = n.type === 'task' ? id.slice('task:'.length) : null;
  const history = taskId ? histories.get(taskId) ?? null : null;
  const card = nodeCard(n, { graph, bus: raw?.bus ?? {}, snapshot: raw?.snapshot ?? null, history });
  if (card && taskId && history === null) {
    if (!raw?.online) card.needsHistory = false; else loadHistory(taskId);
  }
  const links = graph.edges.filter((e) => e.a === id || e.b === id)
    .map((e) => ({ other: e.a === id ? e.b : e.a, kind: e.kind, weight: e.weight }))
    .sort((a, b) => b.weight - a.weight);
  showCard(renderCard(card, { side: `<details class="g-section"><summary><span>Links</span><span class="g-count">${links.length}</span></summary><ul class="plain g-links">${links.slice(0, 40).map((l) => `<li><button type="button" class="act" data-node="${esc(l.other)}">${esc(graph.nodes.find((x) => x.id === l.other)?.label ?? l.other)}</button> <span class="mut">${esc(l.kind)}${l.weight > 1 ? ` ×${l.weight}` : ''}</span></li>`).join('')}</ul></details>` }));
  draw();
}
// The card sits in the bottom half of the graph column; the canvas shrinks to the top half.
function showCard(html) {
  const box = $('g-detail');
  const wasOpen = !box.hidden;
  if (html) { box.innerHTML = html; applyBars(box); box.hidden = false; } else { box.innerHTML = ''; box.hidden = true; }
  if (wasOpen !== !box.hidden) resize();
  // Stacked layout (narrow screens): the card sits below the graph, so bring it into view.
  if (!wasOpen && !box.hidden && window.matchMedia('(max-width: 900px)').matches) box.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  // Opening the card halves the canvas: bring the selected node back into view if it fell out.
  const p = selected && pos.get(selected);
  if (p && !wasOpen && !box.hidden) {
    const x = canvas.clientWidth / 2 + (p.x + view.x) * view.k; const y = canvas.clientHeight / 2 + (p.y + view.y) * view.k;
    if (x < 20 || y < 20 || x > canvas.clientWidth - 20 || y > canvas.clientHeight - 20) centre(selected);
  }
}
$('g-detail').addEventListener('click', (e) => {
  if (e.target.closest('button[data-close]')) { select(null); return; }
  const b = e.target.closest('button[data-node]'); if (b) { select(b.dataset.node); centre(b.dataset.node); }
});
function centre(id) { const p = pos.get(id); if (p) { view.x = -p.x; view.y = -p.y; draw(); } }
function fitToView() {
  const { nodes } = visible();
  const nodePositions = nodes.map((n) => pos.get(n.id)).filter(Boolean);
  const w = canvas.clientWidth; const h = canvas.clientHeight;
  view = zoomToFit(nodePositions, { width: w, height: h, padding: 60 });
  draw();
}

$('g-fit')?.addEventListener('click', fitToView);
$('g-reset')?.addEventListener('click', () => { view = { x: 0, y: 0, k: 1 }; draw(); });
$('g-time')?.addEventListener('change', (e) => {
  const hours = Number(e.target.value) || null;
  graph = buildGraph(raw.bus, raw.snapshot, { hours });
  $('g-status').textContent = `${graph.nodes.length} nodes · ${graph.edges.length} links${raw.graphAt ? ` · bus read ${Math.round((Date.now() - raw.graphAt) / 1000)}s ago` : ''}`;
  alpha = Math.max(alpha, 0.4);
  if (selected) select(selected);
  draw();
});

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.key === 'Escape') { select(null); return; }
  if (e.key === 'f' || e.key === 'F') { fitToView(); return; }
  if (e.key === '+' || e.key === '=') { view.k = Math.min(4, view.k * 1.2); draw(); return; }
  if (e.key === '-' || e.key === '_') { view.k = Math.max(0.2, view.k / 1.2); draw(); return; }
  if (selected && (e.key === 'ArrowRight' || e.key === 'ArrowDown')) {
    const next = cycleNeighbour(graph, selected, 1);
    if (next) { select(next); centre(next); }
    e.preventDefault();
  } else if (selected && (e.key === 'ArrowLeft' || e.key === 'ArrowUp')) {
    const prev = cycleNeighbour(graph, selected, -1);
    if (prev) { select(prev); centre(prev); }
    e.preventDefault();
  }
});

$('g-search').addEventListener('input', (e) => {
  found = new Set(search(graph, e.target.value));
  const first = [...found][0];
  if (first) centre(first);
  draw();
});
$('g-types').innerHTML += NODE_TYPES.map((t) => `<label class="chk"><input type="checkbox" value="${t}" checked> <span class="sw" data-t="${t}"></span>${t}</label>`).join('');
$('g-types').addEventListener('change', (e) => { if (e.target.checked) shown.add(e.target.value); else shown.delete(e.target.value); alpha = 0.6; draw(); });
for (const s of document.querySelectorAll('.sw')) s.style.background = COLORS[s.dataset.t];
$('g-legend').innerHTML = '<span class="mut">lines:</span> <span class="pk">talks</span> · <span class="warn">wrote</span> · <span class="mut">- - mentions</span> · squares are memory';

async function load() {
  const res = await fetch('/api/graph', { cache: 'no-store', credentials: 'same-origin' });
  if (res.status === 401) { location.href = '/'; return; }
  raw = await res.json();
  const hours = Number($('g-time')?.value) || null;
  graph = buildGraph(raw.bus, raw.snapshot, { hours });
  $('g-status').textContent = `${graph.nodes.length} nodes · ${graph.edges.length} links${raw.graphAt ? ` · bus read ${Math.round((Date.now() - raw.graphAt) / 1000)}s ago` : ''}`;
  alpha = Math.max(alpha, 0.4);
  if (still) for (let i = 0; i < 300; i++) step();
  if (selected) select(selected);
  draw();
}
window.addEventListener('resize', resize);
resize();
await load();
// /graph?focus=T-0007 (links from chat): open that task or epic once the layout has settled a little.
const focus = new URLSearchParams(location.search).get('focus');
if (focus && /^[TE]-\d{4,}$/.test(focus)) {
  const id = `${focus.startsWith('T-') ? 'task' : 'epic'}:${focus}`;
  if (graph.nodes.some((n) => n.id === id)) { for (let i = 0; i < 120; i++) step(); select(id); centre(id); }
}
setInterval(load, 60_000);
requestAnimationFrame(loop);
