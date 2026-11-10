// Dispatcher: keeps work moving between the orchestrator and the managers. Two loops.
//  - listener: reads the orchestrator's bus inbox every listenMs. Managers send it
//    direct messages, honoured from known managers only: "ready" starts a dispatch pass
//    (coalesced: one running, one pending); "blocked <task> <reason>" and "help <text>"
//    become one-line alerts (max 200 chars, one per sender and kind per cooldown).
//  - dispatch pass, every dispatchMs and on "ready": planDispatch() matches idle,
//    online managers (fresh heartbeat; the bus is only a hint for the nudge) to departments with queued tasks and tells them to lease now.
//    A department with queued work and no online manager raises an alert.
// comm_poll cannot block for this: the bus has no mark-read over MCP, so old unread
// mail makes every poll return at once. The listener tracks the highest message id and persists it in the store.
import { SWARM_CHANNEL } from './events.mjs';
import { readPauses } from './controls.mjs';

const MIN = 60_000;
export const DISPATCH = {
  listenMs: 10_000,
  dispatchMs: 2 * MIN,
  onlineMs: 2 * MIN,
  cooldownMs: 10 * MIN,
  alertMaxChars: 200,
  alertCooldownMs: 10 * MIN,
};

const oneLine = (text, max = DISPATCH.alertMaxChars) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** "ready", "blocked T-0001 reason", "help text" -> { kind, ... }; anything else -> null. */
export function parseManagerMessage(content) {
  const text = String(content ?? '').trim();
  if (/^ready\b/i.test(text)) return { kind: 'ready' };
  let m = /^blocked\s+(\S+)\s*(.*)$/is.exec(text);
  if (m) return { kind: 'blocked', taskId: m[1], reason: m[2] || 'no reason given' };
  m = /^help\b\s*(.*)$/is.exec(text);
  if (m) return { kind: 'help', text: m[1] || 'no detail' };
  return null;
}

/**
 * Pure. managers: [{ name, departments, at, freeSlots, running }] (at = last heartbeat, ms or 0).
 * Online = fresh heartbeat only. busOnline (bus agent names that are online or idle) is a hint:
 * a covering manager that is bus-online but has no fresh heartbeat stays offline (no assignment),
 * but still gets a nudge so it wakes and heartbeats. queued: Map department -> [task ids], best first.
 * Returns { presence: [{ name, state }], actions: [{ type, ... }] }.
 */
export function planDispatch({ now, managers, busOnline = new Set(), queued, onlineMs = DISPATCH.onlineMs }) {
  const presence = managers.map((m) => {
    const online = now - (m.at ?? 0) <= onlineMs;
    const free = Number.isInteger(m.freeSlots) ? m.freeSlots : (m.running?.length ? 0 : 1);
    return { ...m, state: !online ? 'offline' : free > 0 ? 'idle' : 'busy', free: online ? free : 0 };
  });
  const actions = [];
  for (const [department, ids] of queued) {
    if (!ids.length) continue;
    const covering = presence.filter((m) => m.departments.includes(department));
    if (!covering.some((m) => m.state !== 'offline')) {
      actions.push({ type: 'dispatch.no_manager', department, count: ids.length });
      for (const m of covering) {
        if (busOnline.has(m.name)) actions.push({ type: 'dispatch.nudge', manager: m.name, department, taskId: ids[0], count: 1 });
      }
      continue;
    }
    let next = 0;
    for (const m of covering) {
      if (next >= ids.length) break;
      if (m.free < 1) continue;
      const take = Math.min(m.free, ids.length - next);
      actions.push({ type: 'dispatch.nudge', manager: m.name, department, taskId: ids[next], count: take });
      m.free -= take;
      next += take;
    }
  }
  return { presence: presence.map(({ name, state }) => ({ name, state })), actions };
}

/** Managers from the token file joined with their last heartbeats. */
export function managersFrom(tokens, heartbeats) {
  return Object.entries(tokens.managers ?? {})
    // A token with no departments (an owner's admin token) is not a manager that can lease.
    .filter(([, t]) => (t.roles ?? ['manager']).includes('manager') && (t.departments ?? []).length > 0)
    .map(([name, t]) => {
      const h = heartbeats.get(name);
      return { name, departments: t.departments ?? [], at: h?.at ?? 0, freeSlots: h?.freeSlots, running: h?.running ?? [] };
    });
}

export function queuedByDepartment(store, departmentIds) {
  return new Map(departmentIds.map((d) => [d, store.queueOf(d).map((t) => t.id)]));
}

/** Applies planDispatch actions with a per-subject cooldown, so one queued task nudges a manager once per cooldown. */
export function createDispatchExecutor({ bus, emit, cooldownMs = DISPATCH.cooldownMs }) {
  const last = new Map();
  const due = (key, now) => {
    if (now - (last.get(key) ?? -Infinity) < cooldownMs) return false;
    last.set(key, now);
    return true;
  };
  return {
    async apply(actions, now) {
      for (const a of actions) {
        if (a.type === 'dispatch.nudge' && due(`nudge|${a.manager}|${a.taskId}`, now)) {
          await bus?.direct(a.manager, `dispatch: ${a.count} task(s) queued in ${a.department}, next ${a.taskId}. Lease now.`);
          emit({ ...a, severity: 'info', subject: `manager:${a.manager}`, detail: `nudged for ${a.taskId} (${a.count} queued in ${a.department})` });
        } else if (a.type === 'dispatch.no_manager' && due(`none|${a.department}`, now)) {
          emit({ ...a, severity: 'warn', subject: `dept:${a.department}`, detail: `${a.count} queued, no manager online` });
        }
      }
    },
  };
}

const INBOX_LIMIT = 100;
export const MAX_REPLAY_MS = 30 * MIN;
const LAST_ID_KEY = 'dispatcher.last_message_id';

/** Bus created_at ("YYYY-MM-DD HH:MM:SS", UTC, no Z) -> ms, or NaN. */
const busTime = (s) => (typeof s === 'string' && /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d/.test(s) ? Date.parse(`${s.replace(' ', 'T').replace(/Z$/, '')}Z`) : NaN);

/**
 * Reads new direct messages. With a store, the last handled id is persisted (meta table), so after
 * a restart the messages newer than it are handled, but only those under maxReplayMs old (no stale
 * "ready" flood). Without a stored id (first run, or no store) the first read only records the
 * newest id and handles nothing. The bus inbox has no offset/before/since parameter, so paging is
 * impossible: when a full batch does not reach the stored id, a warning says messages were skipped.
 */
export function createBusListener({ bus, onMessage, store = null, clock = Date, maxReplayMs = MAX_REPLAY_MS, log = console }) {
  const stored = store?.getMeta(LAST_ID_KEY);
  let lastId = stored == null ? null : Number(stored);
  if (!Number.isInteger(lastId)) lastId = null;
  const save = () => { if (lastId !== null) store?.setMeta(LAST_ID_KEY, lastId); };
  return {
    async tick() {
      const msgs = await bus.inbox({ limit: INBOX_LIMIT });
      if (!msgs) return 0;
      const fresh = msgs.filter((m) => m.to_agent).sort((a, b) => a.id - b.id);
      const newest = msgs.reduce((n, m) => Math.max(n, m.id), lastId ?? 0);
      if (lastId === null) {
        lastId = newest;
        save();
        return 0;
      }
      const oldest = msgs.reduce((n, m) => Math.min(n, m.id), Infinity);
      if (msgs.length >= INBOX_LIMIT && oldest > lastId + 1) {
        log.warn?.(`[dispatch] inbox batch of ${msgs.length} starts at id ${oldest}, after last handled ${lastId}: older messages may have been skipped`);
      }
      const now = clock.now();
      let handled = 0;
      for (const m of fresh) {
        if (m.id <= lastId) continue;
        const at = busTime(m.created_at);
        try {
          if (Number.isFinite(at) && now - at > maxReplayMs) continue; // too old to act on
          await onMessage(m);
          handled++;
        } finally {
          lastId = Math.max(lastId, m.id); // a throwing message is never replayed, nor the ones before it
          save();
        }
      }
      lastId = Math.max(lastId, newest);
      save();
      return handled;
    },
  };
}

/** Wires both loops into the running orchestrator. Returns { listener, pass } for tests and doctor. */
export function startDispatcher({ store, heartbeats, bus, departments, readManagerTokens, log = console, listenMs = DISPATCH.listenMs, dispatchMs = DISPATCH.dispatchMs, clock = Date, alertCooldownMs = DISPATCH.alertCooldownMs, guard = null }) {
  const emit = (a) => {
    const text = oneLine(`${a.severity.toUpperCase()} ${a.type} ${a.subject}: ${a.detail}`);
    log.log(`[dispatch] ${text}`);
    if (a.severity !== 'info') bus?.send(SWARM_CHANNEL, text);
  };
  const executor = createDispatchExecutor({ bus, emit });
  const names = new Map(); // bus agent id -> name
  let lastPresence = '';

  async function runPass() {
    if (guard?.isPaused()) return []; // kill switch: no nudges, no alerts
    const agents = (await bus?.agents()) ?? [];
    for (const a of agents) names.set(a.id, a.name);
    const busOnline = new Set(agents.filter((a) => a.status !== 'offline').map((a) => a.name));
    // Paused departments and managers get no nudge and raise no no_manager alert.
    const pauses = readPauses(store);
    const managers = managersFrom(readManagerTokens(), heartbeats).filter((m) => !pauses.managers[m.name]);
    const queued = queuedByDepartment(store, Object.keys(departments.departments).filter((d) => !pauses.departments[d]));
    const now = clock.now();
    const { presence, actions } = planDispatch({ now, managers, busOnline, queued });
    const summary = presence.map((p) => `${p.name}=${p.state}`).join(' ');
    if (summary !== lastPresence) log.log(`[dispatch] managers: ${summary || 'none'}`);
    lastPresence = summary;
    await executor.apply(actions, now);
    return actions;
  }

  // At most one pass running and one pending: a burst of requests costs two passes.
  let running = null;
  let pending = false;
  function pass() {
    if (running) {
      pending = true;
      return running;
    }
    running = (async () => {
      try {
        let actions;
        do {
          pending = false;
          actions = await runPass();
        } while (pending);
        return actions;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  let readyQueued = false;
  const lastAlert = new Map();
  const known = () => new Set(Object.keys(readManagerTokens().managers ?? {}));
  const listener = createBusListener({
    bus, store, clock, log,
    async onMessage(m) {
      const from = names.get(m.from_agent) ?? m.from_agent;
      const msg = parseManagerMessage(m.content);
      if (!msg) return;
      if (!known().has(from)) return void log.warn?.(`[dispatch] ignored ${msg.kind} from non-manager ${oneLine(from, 60)}`);
      if (msg.kind === 'ready') {
        // Not awaited, and deferred one macrotask: every ready of a burst lands in the same request.
        if (readyQueued) return;
        readyQueued = true;
        setImmediate(() => {
          readyQueued = false;
          pass().catch((err) => log.error?.(`[dispatch] pass failed: ${err.message}`));
        });
        return;
      }
      const key = `${from}|${msg.kind}`;
      const now = clock.now();
      if (now - (lastAlert.get(key) ?? -Infinity) < alertCooldownMs) return void log.warn?.(`[dispatch] ${msg.kind} from ${oneLine(from, 60)} muted (cooldown)`);
      lastAlert.set(key, now);
      const detail = oneLine(msg.kind === 'blocked' ? `${msg.taskId}: ${msg.reason}` : msg.text);
      emit({ type: `manager.${msg.kind}`, severity: 'warn', subject: `manager:${from}`, detail });
    },
  });

  const guarded = (name, fn) => () => fn().catch((err) => log.error?.(`[dispatch] ${name} failed: ${err.message}`));
  if (bus) setInterval(guarded('listen', () => listener.tick()), listenMs).unref();
  setInterval(guarded('pass', pass), dispatchMs).unref();
  guarded('pass', pass)();
  return { listener, pass };
}
