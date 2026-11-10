// The swarm as a graph (dashboard Graph page, ARCHITECTURE 55): who talks where, what the agents
// remember, and how the work hangs together. Pure: bus data and the orchestrator snapshot in,
// { nodes, edges } out. Used by graph.js in the browser and by the tests.

const TASK_REF = /\bT-\d{4,}\b/g;
const FINISHED = new Set(['merged', 'cancelled']);

/** An epic's status as shown: done or cancelled once every task is finished, else its own or open. */
export function epicStatus(epic, tasks = []) {
  const mine = tasks.filter((t) => t.epicId === epic.id);
  if (mine.length && mine.every((t) => FINISHED.has(t.status))) return mine.some((t) => t.status === 'merged') ? 'done' : 'cancelled';
  return epic.status ?? 'open';
}
const EPIC_REF = /\bE-\d{4,}\b/g;
// Short-lived bus names that only add noise: one-off lookups, CLI helpers, fallback suffixes.
const EPHEMERAL = /(-lookup|-[0-9a-f]{4})$|^swarm-(ctl|operator)$/;

export const NODE_TYPES = ['agent', 'channel', 'memory', 'namespace', 'epic', 'task', 'manager', 'department'];

/**
 * bus: { agents: [], channels: [], messages: { [channelName]: [msg] }, state: [entry] }
 * snapshot: orchestrator /snapshot (tasks, epics, managers, departments) or null.
 * options: { hours?: number, clock?: { now: () => number } }
 */
export function buildGraph(bus = {}, snapshot = null, options = {}) {
  const { hours = null, clock = Date } = options;
  const cutoffMs = Number(hours) > 0 ? clock.now() - hours * 3600_000 : null;
  const nodes = new Map();
  const edges = new Map();
  const node = (id, type, label, meta = {}) => {
    if (!nodes.has(id)) nodes.set(id, { id, type, label, weight: 0, meta });
    else Object.assign(nodes.get(id).meta, meta);
    return nodes.get(id);
  };
  const edge = (a, b, kind, w = 1) => {
    if (!nodes.has(a) || !nodes.has(b) || a === b) return;
    const key = `${a}|${b}|${kind}`;
    const e = edges.get(key) ?? { a, b, kind, weight: 0 };
    e.weight += w;
    edges.set(key, e);
    nodes.get(a).weight += w;
    nodes.get(b).weight += w;
  };

  const byId = new Map((bus.agents ?? []).map((a) => [a.id, a]));
  const talked = new Set();
  for (const msgs of Object.values(bus.messages ?? {})) {
    for (const m of msgs ?? []) {
      if (cutoffMs && m.created_at && Date.parse(m.created_at) < cutoffMs) continue;
      talked.add(m.from_agent);
    }
  }
  for (const s of bus.state ?? []) {
    if (cutoffMs && s.updated_at && Date.parse(s.updated_at) < cutoffMs) continue;
    talked.add(s.updated_by);
  }
  for (const a of bus.agents ?? []) {
    if (a.status === 'offline' && EPHEMERAL.test(a.name) && !talked.has(a.id)) continue;
    node(`agent:${a.name}`, 'agent', a.name, { status: a.status, statusText: a.status_text ?? null, lastSeen: a.last_heartbeat ?? null });
  }
  const agentNode = (id) => (byId.has(id) ? `agent:${byId.get(id).name}` : null);

  // Conversations: agent -> channel, weighted by messages; mentions of tasks and epics become links.
  const mentions = [];
  for (const ch of bus.channels ?? []) node(`channel:${ch.name}`, 'channel', `#${ch.name}`, { description: ch.description ?? null });
  for (const [name, msgs] of Object.entries(bus.messages ?? {})) {
    const rawMsgs = msgs ?? [];
    const activeMsgs = cutoffMs ? rawMsgs.filter((m) => !m.created_at || Date.parse(m.created_at) >= cutoffMs) : rawMsgs;
    const cid = `channel:${name}`;
    node(cid, 'channel', `#${name}`, { messages: activeMsgs.length });
    for (const m of activeMsgs) {
      const from = agentNode(m.from_agent);
      if (from) edge(from, cid, 'talks');
      for (const ref of new Set([...(String(m.content).match(TASK_REF) ?? []), ...(String(m.content).match(EPIC_REF) ?? [])])) mentions.push([cid, ref]);
    }
  }

  // Memory: shared state entries, grouped by namespace, linked to the agent that last wrote them.
  for (const s of bus.state ?? []) {
    if (cutoffMs && s.updated_at && Date.parse(s.updated_at) < cutoffMs) continue;
    const ns = `namespace:${s.namespace}`;
    node(ns, 'namespace', `${s.namespace}/`);
    const id = `memory:${s.namespace}/${s.key}`;
    node(id, 'memory', s.key, { namespace: s.namespace, value: String(s.value ?? '').slice(0, 400), updatedAt: s.updated_at ?? null, expiresAt: s.expires_at ?? null });
    edge(ns, id, 'holds');
    const by = agentNode(s.updated_by);
    if (by) edge(by, id, 'wrote');
  }

  // Work: departments, managers, epics, tasks from the orchestrator.
  if (snapshot) {
    for (const d of snapshot.departments ?? []) {
      node(`department:${d}`, 'department', d);
      edge(`department:${d}`, `channel:dept-${d}`, 'channel');
    }
    for (const m of snapshot.managers ?? []) {
      node(`manager:${m.name}`, 'manager', m.name, { state: m.state, member: m.member ?? null });
      for (const d of m.departments ?? []) edge(`manager:${m.name}`, `department:${d}`, 'serves');
      edge(`manager:${m.name}`, `agent:${m.name}`, 'is');
    }
    for (const e of snapshot.epics ?? []) node(`epic:${e.id}`, 'epic', `${e.id} ${e.title ?? ''}`.trim(), { status: epicStatus(e, snapshot.tasks) });
    for (const t of snapshot.tasks ?? []) {
      node(`task:${t.id}`, 'task', `${t.id} ${t.title ?? ''}`.trim(), { status: t.status, pr: t.pr ?? null, repo: t.repo ?? null, department: t.department });
      edge(`task:${t.id}`, `epic:${t.epicId}`, 'part of');
      if (t.holder) edge(`manager:${t.holder}`, `task:${t.id}`, 'held');
      edge(`task:${t.id}`, `department:${t.department}`, 'in');
    }
  }
  for (const [cid, ref] of mentions) edge(cid, ref.startsWith('T-') ? `task:${ref}` : `epic:${ref}`, 'mentions');

  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** Ids of a node and its direct neighbours. */
export function neighbours(graph, id) {
  const out = new Set([id]);
  for (const e of graph.edges) {
    if (e.a === id) out.add(e.b);
    if (e.b === id) out.add(e.a);
  }
  return out;
}

/** Nodes whose label or id contains the query (case-insensitive). */
export function search(graph, query) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  return graph.nodes.filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id);
}

/** Pure helper to generate task links for PR and control room. */
export function taskLinks(task, { repoUrl = '', controlRoomUrl = '/#tasks' } = {}) {
  const pr = task?.pr ?? task?.meta?.pr;
  const repo = task?.repo ?? task?.meta?.repo;
  let prUrl = null;
  if (pr) {
    if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
      prUrl = `https://github.com/${repo}/pull/${pr}`;
    } else if (repoUrl) {
      prUrl = `${repoUrl.replace(/\/$/, '')}/pull/${pr}`;
    }
  }
  return {
    prUrl,
    controlRoomUrl,
  };
}

/** Pure helper to calculate zoom-to-fit view bounds and scale. */
export function zoomToFit(nodes = [], { width = 800, height = 600, padding = 40, minZoom = 0.2, maxZoom = 2 } = {}) {
  const list = Array.isArray(nodes) ? nodes : Object.values(nodes);
  if (!list.length) return { x: 0, y: 0, k: 1 };
  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  for (const n of list) {
    if (!n || typeof n.x !== 'number' || typeof n.y !== 'number') continue;
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, k: 1 };
  const w = Math.max(1, maxX - minX);
  const h = Math.max(1, maxY - minY);
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const scaleX = (width - padding * 2) / w;
  const scaleY = (height - padding * 2) / h;
  const k = Math.max(minZoom, Math.min(maxZoom, Math.min(scaleX, scaleY)));
  return { x: -midX || 0, y: -midY || 0, k };
}

/** Pure helper to cycle between adjacent neighbour nodes for keyboard navigation. */
export function cycleNeighbour(graph, currentNodeId, direction = 1) {
  if (!graph || !currentNodeId) return null;
  const direct = neighbours(graph, currentNodeId);
  direct.delete(currentNodeId);
  const list = [...direct].sort();
  if (!list.length) return null;
  const idx = direction >= 0 ? 0 : list.length - 1;
  return list[idx];
}
