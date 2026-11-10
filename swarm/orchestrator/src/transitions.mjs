// Task state machine. Pure table: no I/O, no schema. Only the store moves
// tasks, and only along these edges. Every other move is forbidden.

export const STATES = [
  'blocked', 'queued', 'leased', 'in_progress', 'submitted', 'in_review',
  'changes_requested', 'merged', 'failed', 'escalated', 'needs-human', 'cancelled',
];

export const TERMINAL = new Set(['merged', 'cancelled']);

const EDGES = {
  blocked: ['queued', 'cancelled'],
  queued: ['leased', 'cancelled'],
  leased: ['in_progress', 'queued', 'failed', 'cancelled'],
  in_progress: ['submitted', 'queued', 'failed', 'cancelled'],
  submitted: ['in_review', 'cancelled'],
  in_review: ['merged', 'submitted', 'changes_requested', 'needs-human', 'cancelled'],
  changes_requested: ['in_progress', 'needs-human', 'cancelled'],
  failed: ['queued', 'escalated', 'cancelled'],
  escalated: ['queued', 'needs-human', 'cancelled'],
  'needs-human': ['queued', 'cancelled'],
  merged: [],
  cancelled: [],
};

export function canTransition(from, to) {
  if (!Object.hasOwn(EDGES, from)) throw new Error(`unknown state: ${from}`);
  if (!STATES.includes(to)) throw new Error(`unknown state: ${to}`);
  return EDGES[from].includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) throw new Error(`forbidden transition: ${from} -> ${to}`);
}

/** Every allowed edge, as [from, to] pairs. Used by tests and docs. */
export function allowedEdges() {
  return Object.entries(EDGES).flatMap(([from, tos]) => tos.map((to) => [from, to]));
}
