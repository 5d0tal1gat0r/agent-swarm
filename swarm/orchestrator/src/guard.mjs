// Kill switch and main-red stop (ARCHITECTURE 44, risks 5 and 7).
// Rate limits (risk 6) live here too: merges per hour in mergeBlock, open PRs per manager via openPrsOf (api.mjs lease).
// Pause lives in bus state swarm/paused. Bus state is writable by any bus member, which
// is acceptable for a kill switch: the worst a stranger can do is stop the swarm. Any
// value pauses, except a JSON object with `paused: false`, which is what `resume` writes
// (the bus has one write path over MCP, so resume is a record, not a delete).
// The orchestrator caches the flag and refreshes it every few seconds. A failed read keeps
// the last value: a bus blip never unpauses. The `autopilot-pause` label is a follow-up.
import { REVERT_CRITERION } from './revert.mjs';

export const PAUSE = { namespace: 'swarm', key: 'paused' };
export const REFRESH_MS = 10_000;

/** { reason, by, at } when the stored value pauses; null when it does not. */
export function parsePause(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    const v = JSON.parse(value);
    if (v && typeof v === 'object') return v.paused === false ? null : { reason: v.reason ?? null, by: v.by ?? null, at: v.at ?? null };
  } catch {}
  return { reason: String(value).slice(0, 200), by: null, at: null };
}

/** Store-level setter the CLI (and later the dashboard) calls. Throws when the bus write fails. */
export async function setPause(bus, { reason = null, by = 'swarm-operator' } = {}) {
  const value = JSON.stringify({ paused: true, reason: reason ? String(reason).slice(0, 200) : null, by, at: new Date().toISOString() });
  if ((await bus.setState(PAUSE.namespace, PAUSE.key, value)) === null) throw new Error('bus write failed; pause not set');
}

export async function clearPause(bus, { by = 'swarm-operator' } = {}) {
  const value = JSON.stringify({ paused: false, by, at: new Date().toISOString() });
  if ((await bus.setState(PAUSE.namespace, PAUSE.key, value)) === null) throw new Error('bus write failed; pause not cleared');
}

/** A p0 revert made by the monitor (revert.mjs): the only merge allowed while main is red. */
export function isRevertTask(task) {
  return task.priority === 'p0' && task.department === 'platform' && (task.acceptance ?? []).some((a) => REVERT_CRITERION.test(a));
}

export const DEFAULT_MAX_MERGES_PER_HOUR = 6;
export const DEFAULT_MAX_OPEN_PRS = 2;
const HOUR_MS = 3_600_000;
const OPEN_PR_STATUSES = new Set(['submitted', 'in_review', 'changes_requested', 'in_progress']);

/**
 * Tasks that reached merge in the last hour: the latest entry into in_review (gates started, right
 * before auto-merge is armed) for armed or merged tasks, else the merged entry. Counted once per task.
 */
export function mergesInWindow(tasks, now, windowMs = HOUR_MS) {
  let n = 0;
  for (const t of tasks) {
    if (t.status !== 'in_review' && t.status !== 'merged') continue;
    const h = (t.history ?? []).filter((e) => e.to === 'in_review');
    const e = h.length ? h[h.length - 1] : (t.history ?? []).find((x) => x.to === 'merged');
    if (e && now - Date.parse(e.at) < windowMs) n += 1;
  }
  return n;
}

/** Tasks of this manager that hold an open PR (a task with a pr in submitted, in_review, changes_requested, or in_progress as a fix). */
export function openPrsOf(tasks, manager) {
  return tasks.filter((t) => t.holder === manager && t.pr && OPEN_PR_STATUSES.has(t.status)).length;
}

export function createGuard({ bus = null, log = console, store = null, policy = null, clock = Date } = {}) {
  let paused = null;
  let main = null;
  return {
    /** Re-reads bus state. A failed or unparsable read keeps the last value. */
    async refresh() {
      if (!bus) return;
      const r = await bus.readState(PAUSE.namespace, PAUSE.key);
      if (!r.ok) return;
      const next = parsePause(r.value);
      if (!paused !== !next) log.warn?.(next ? `[guard] PAUSED: ${next.reason ?? 'no reason given'}` : '[guard] resumed');
      paused = next;
    },
    setMain(m) { main = m; },
    isPaused: () => paused !== null,
    status: () => paused ?? { reason: null },
    pause: () => paused,
    /** Why a reviewed task may not merge now, or null. Paused blocks all; main red blocks all but the p0 revert. */
    mergeBlock(task) {
      if (paused) return 'paused';
      if (main?.status === 'red' && !isRevertTask(task)) return 'main_red';
      // Rate limit (risk 6): over the hourly cap the task waits as submitted, it is not dropped. The revert is exempt.
      const cap = policy?.limits?.maxMergesPerHour ?? DEFAULT_MAX_MERGES_PER_HOUR;
      if (store && !isRevertTask(task) && mergesInWindow(store.listTasks(), clock.now()) >= cap) return 'rate_limit';
      return null;
    },
  };
}
