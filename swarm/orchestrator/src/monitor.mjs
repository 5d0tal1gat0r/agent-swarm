// Monitor: watches the swarm and acts on what it sees. Two parts.
//  - evaluate(snapshot) is pure: a snapshot in, a list of actions out.
//  - createExecutor() applies the actions. Alerts go to emit(). A task over its
//    token or minutes budget is cancelled. Alerts are deduped: one condition is emitted once,
//    again only after it clears, changes severity, or the cooldown passes.
import { ownerOf } from './router.mjs';
import { sleptMs } from './sleep.mjs';

const MIN = 60_000;
export const THRESHOLDS = {
  managerDownMs: 2 * MIN,
  stalledWarnMs: 15 * MIN,
  stalledCriticalMs: 25 * MIN,
  budgetWarn: 0.8,
  budgetStop: 1.0,
  queueDepth: 10,
};
const TERMINAL = new Set(['merged', 'cancelled']);
const STOP_TYPES = new Set(['stop.budget', 'stop.budget_minutes']);

/** Start of the current attempt: the latest lease, or the latest fix resume (changes_requested -> in_progress). Null if unrecorded. */
export function attemptStartMs(task) {
  const history = task.history ?? [];
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.to === 'leased' || (h.to === 'in_progress' && h.from === 'changes_requested')) return Date.parse(h.at);
  }
  return null;
}

/**
 * snapshot: { now, maxAttempts, tasks, managers: [{name, at}], unownedPaths: [], main: {sha, status} | null, paused: {reason, by, at} | null, departments,
 *   sleeps: [{from, to}] }. Time the machine slept (sleeps) does not count as silence, stall or budget (ARCHITECTURE 70).
 * Returns [{ type, severity, subject, detail, taskId? }]. Pure.
 */
export function evaluate(snapshot) {
  const { now, maxAttempts } = snapshot;
  const actions = [];
  const awake = (from) => now - from - sleptMs(snapshot.sleeps, from, now);

  for (const m of snapshot.managers) {
    const silent = awake(m.at);
    if (silent > THRESHOLDS.managerDownMs) {
      actions.push({ type: 'alert.manager_down', severity: 'critical', subject: `manager:${m.name}`, detail: `no heartbeat for ${Math.round(silent / MIN)} min` });
    }
  }

  for (const t of snapshot.tasks) {
    if (TERMINAL.has(t.status)) continue;
    if (t.status === 'in_progress') {
      const idle = awake(Date.parse(t.lastProgressAt ?? t.updatedAt));
      if (idle > THRESHOLDS.stalledCriticalMs) {
        actions.push({ type: 'alert.stalled', severity: 'critical', subject: `task:${t.id}`, taskId: t.id, detail: `no progress for ${Math.round(idle / MIN)} min` });
      } else if (idle > THRESHOLDS.stalledWarnMs) {
        actions.push({ type: 'alert.stalled', severity: 'warn', subject: `task:${t.id}`, taskId: t.id, detail: `no progress for ${Math.round(idle / MIN)} min` });
      }
    }
    const tokens = t.budget?.tokens ?? 0;
    if (tokens > 0) {
      const ratio = t.usedTokens / tokens;
      if (ratio >= THRESHOLDS.budgetStop) {
        actions.push({ type: 'stop.budget', severity: 'critical', subject: `task:${t.id}`, taskId: t.id, detail: `token budget spent: ${t.usedTokens} of ${tokens}` });
      } else if (ratio >= THRESHOLDS.budgetWarn) {
        actions.push({ type: 'alert.budget', severity: 'warn', subject: `task:${t.id}`, taskId: t.id, detail: `${Math.round(ratio * 100)}% of token budget used` });
      }
    }
    const minutes = t.budget?.minutes ?? 0;
    const startedAt = t.status === 'in_progress' && minutes > 0 ? attemptStartMs(t) : null;
    if (startedAt !== null && !Number.isNaN(startedAt)) {
      const elapsed = awake(startedAt);
      const ratio = elapsed / (minutes * MIN);
      if (ratio >= THRESHOLDS.budgetStop) {
        actions.push({ type: 'stop.budget_minutes', severity: 'critical', subject: `task:${t.id}`, taskId: t.id, detail: `minutes budget spent: ${Math.round(elapsed / MIN)} of ${minutes} min` });
      } else if (ratio >= THRESHOLDS.budgetWarn) {
        actions.push({ type: 'alert.budget_minutes', severity: 'warn', subject: `task:${t.id}`, taskId: t.id, detail: `${Math.round(ratio * 100)}% of minutes budget used (${Math.round(elapsed / MIN)} of ${minutes} min)` });
      }
    }
    if (t.attempts >= maxAttempts - 1) {
      actions.push({ type: 'alert.attempts', severity: 'warn', subject: `task:${t.id}`, taskId: t.id, detail: `attempt ${t.attempts} of ${maxAttempts}` });
    }
  }

  for (const path of snapshot.unownedPaths) {
    actions.push({ type: 'alert.unowned_path', severity: 'warn', subject: `path:${path}`, detail: `no department owns ${path}` });
  }

  if (snapshot.main && snapshot.main.status === 'red') {
    actions.push({ type: 'alert.main_red', severity: 'critical', subject: 'main', sha: snapshot.main.sha, detail: `checks red on main at ${String(snapshot.main.sha).slice(0, 7)}` });
  }

  if (snapshot.paused) {
    actions.push({ type: 'alert.paused', severity: 'warn', subject: 'swarm', detail: `swarm paused: ${snapshot.paused.reason ?? 'no reason given'}${snapshot.paused.by ? ` (by ${snapshot.paused.by})` : ''}` });
  }

  const queued = new Map();
  for (const t of snapshot.tasks) if (t.status === 'queued') queued.set(t.department, (queued.get(t.department) ?? 0) + 1);
  for (const [department, count] of queued) {
    if (count > THRESHOLDS.queueDepth) {
      actions.push({ type: 'alert.queue_depth', severity: 'warn', subject: `dept:${department}`, detail: `${count} queued (threshold ${THRESHOLDS.queueDepth})` });
    }
  }
  return actions;
}

/** Builds the snapshot evaluate() reads, from the store and the live heartbeats. */
export function snapshotFrom({ store, heartbeats, now, maxAttempts, departments, main = null, paused = null, repoFiles = null, sleeps = [] }) {
  const unownedPaths = repoFiles
    ? repoFiles.filter((f) => ownerOf(departments, f) === null)
    : [];
  return {
    now,
    maxAttempts,
    tasks: store.listTasks(),
    managers: [...heartbeats].map(([name, h]) => ({ name, at: h.at })),
    unownedPaths,
    main,
    paused,
    departments,
    sleeps,
  };
}

/**
 * Applies actions. emit(action) publishes an alert. stop.budget cancels the task
 * (if still open) and emits. Each alert key is emitted once; it re-emits only after
 * the condition clears, changes severity, or the cooldown passes.
 */
export function createExecutor({ store, emit, cooldownMs = 60 * MIN, log = console }) {
  const last = new Map(); // key -> { at, severity }
  return {
    apply(actions, now) {
      const active = new Set();
      for (const a of actions) {
        const key = `${a.type}|${a.subject}`;
        active.add(key);
        if (STOP_TYPES.has(a.type)) {
          try {
            const t = store.getTask(a.taskId);
            if (!TERMINAL.has(t.status)) store.cancel(a.taskId, `monitor: ${a.detail}`);
          } catch (err) {
            log.error?.(`[monitor] could not cancel ${a.taskId}: ${err.message}`);
          }
        }
        const prev = last.get(key);
        if (prev && prev.severity === a.severity && now - prev.at < cooldownMs) continue;
        last.set(key, { at: now, severity: a.severity });
        emit(a);
      }
      for (const key of [...last.keys()]) if (!active.has(key)) last.delete(key);
    },
  };
}

export function formatAction(a) {
  return `${a.severity.toUpperCase()} ${a.type} ${a.subject}: ${a.detail}`;
}
