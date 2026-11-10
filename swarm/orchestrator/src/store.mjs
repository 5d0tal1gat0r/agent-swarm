// SQLite task store: the only source of truth for epics and tasks.
// Every public mutation runs in one BEGIN IMMEDIATE transaction, validates the
// record against protocol/task.schema.json, and moves state only along
// transitions.mjs. Events are published after commit; a failing listener
// never changes store behaviour.
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { assertValid } from '../../protocol/validate.mjs';
import { assertTransition } from './transitions.mjs';
import { compareQueued } from './order.mjs';

const MAX_SLOTS = 10;
export const AGENT_RETENTION = Object.freeze({
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxTotal: 100_000,
  maxPerSession: 10_000,
});
const OPERATOR_ACTION_KINDS = new Set([
  'create_epic', 'plan_epic', 'request_status', 'replan_task', 'prompt_manager', 'prompt_subagent',
]);

const MIGRATIONS = [
  (db) => {
    db.exec(`
      CREATE TABLE epics (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        epic_id TEXT NOT NULL REFERENCES epics(id),
        department TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        version INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX tasks_queue ON tasks (department, status);
      CREATE TABLE idempotency (
        key TEXT PRIMARY KEY,
        result TEXT NOT NULL
      );
    `);
  },
  (db) => {
    db.exec(`
      CREATE TABLE manager_heartbeats (
        name TEXT PRIMARY KEY,
        member TEXT NOT NULL,
        at INTEGER NOT NULL,
        agent TEXT NOT NULL,
        version TEXT NOT NULL,
        free_slots INTEGER NOT NULL,
        running TEXT NOT NULL
      );
    `);
  },
  (db) => {
    // Source issue of an epic, as columns so the database enforces one epic per issue.
    // Backfill keeps the oldest epic per (repo, issue); a later duplicate keeps NULL.
    db.exec(`
      ALTER TABLE epics ADD COLUMN issue_repo TEXT;
      ALTER TABLE epics ADD COLUMN issue INTEGER;
      UPDATE epics SET issue_repo = json_extract(data, '$.repo'), issue = json_extract(data, '$.issue')
      WHERE json_extract(data, '$.issue') IS NOT NULL
        AND id = (SELECT MIN(e2.id) FROM epics e2
                  WHERE json_extract(e2.data, '$.repo') = json_extract(epics.data, '$.repo')
                    AND json_extract(e2.data, '$.issue') = json_extract(epics.data, '$.issue'));
      CREATE UNIQUE INDEX epics_issue ON epics (issue_repo, issue) WHERE issue IS NOT NULL;
    `);
  },
  (db) => {
    // Small key/value table (migration 4). First user: the dispatcher's last handled bus message id.
    db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  },
  (db) => {
    db.exec(`
      CREATE TABLE agent_assignments (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        parent_id TEXT,
        manager TEXT,
        task_id TEXT,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX agent_assignments_task ON agent_assignments (task_id, status);
      CREATE INDEX agent_assignments_manager ON agent_assignments (manager, status);

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL REFERENCES agent_assignments(id),
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX agent_sessions_assignment ON agent_sessions (assignment_id, started_at DESC);

      CREATE TABLE agent_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES agent_sessions(id),
        manager_seq INTEGER NOT NULL,
        assignment_id TEXT NOT NULL REFERENCES agent_assignments(id),
        task_id TEXT,
        at INTEGER NOT NULL,
        data TEXT NOT NULL,
        UNIQUE(session_id, manager_seq)
      );
      CREATE INDEX agent_events_assignment ON agent_events (assignment_id, id DESC);
      CREATE INDEX agent_events_retention ON agent_events (at, id);

      CREATE TABLE agent_directives (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        target TEXT NOT NULL,
        manager TEXT,
        task_id TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX agent_directives_manager ON agent_directives (manager, status, created_at);
      CREATE INDEX agent_directives_task ON agent_directives (task_id, status);

      CREATE TABLE agent_conversations (
        target TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target TEXT NOT NULL REFERENCES agent_conversations(target),
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX agent_messages_target ON agent_messages (target, id DESC);

      CREATE TABLE operator_turns (
        id TEXT PRIMARY KEY,
        target TEXT NOT NULL,
        message_id INTEGER NOT NULL REFERENCES agent_messages(id),
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX operator_turns_queue ON operator_turns (status, created_at, message_id);

      CREATE TABLE operator_actions (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES operator_turns(id),
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX operator_actions_turn ON operator_actions (turn_id, created_at);

      CREATE TABLE agent_feed (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        task_id TEXT,
        assignment_id TEXT,
        at INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX agent_feed_task ON agent_feed (task_id, seq);
      CREATE INDEX agent_feed_assignment ON agent_feed (assignment_id, seq);
    `);
  },
];

const systemClock = () => ({ now: () => Date.now() });

const SENSITIVE_EVENT_KEY = /(^|_)(env|environment|auth|authorization|token|secret|password|prompt|stderr|content)($|_)/i;
const SECRET_VALUE = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/g;

function redactEventValue(value, key = '') {
  if (SENSITIVE_EVENT_KEY.test(key)) return '[redacted]';
  if (typeof value === 'string') return value.replace(SECRET_VALUE, '[redacted]');
  if (Array.isArray(value)) return value.map((item) => redactEventValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactEventValue(child, childKey)]));
  }
  return value;
}

function parseData(row) {
  return row ? JSON.parse(row.data) : null;
}

function migrate(db) {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema version ${current} is newer than this code (${MIGRATIONS.length})`);
  }
  for (let v = current; v < MIGRATIONS.length; v += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

export function openStore({
  path = ':memory:',
  clock = systemClock(),
  leaseMinutes = 10,
  maxAttempts = 3,
  maxReviewRounds = 3,
  agentRetention = AGENT_RETENTION,
} = {}) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  const store = new Store(db, { clock, leaseMinutes, maxAttempts, maxReviewRounds, agentRetention });
  store.recoverAgentState();
  return store;
}

/** States a person may amend from the dashboard: stuck work, and blocked work waiting on it. */
export const AMENDABLE = new Set(['escalated', 'needs-human', 'failed', 'blocked']);

class Store {
  #db;
  #clock;
  #opts;
  #listeners = new Set();
  #pending = [];

  constructor(db, { clock, leaseMinutes, maxAttempts, maxReviewRounds, agentRetention }) {
    this.#db = db;
    this.#clock = clock;
    this.#opts = { leaseMinutes, maxAttempts, maxReviewRounds, agentRetention: { ...AGENT_RETENTION, ...agentRetention } };
  }

  // ---- infrastructure ----------------------------------------------------

  /** Subscribe to state changes: fn({taskId, department, from, to, reason, at}). */
  on(event, fn) {
    if (event !== 'change') throw new Error(`unknown event: ${event}`);
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  close() {
    this.#db.close();
  }

  /** Hot copy of the database with VACUUM INTO. The target must not exist. */
  backup(target) {
    this.#db.exec(`VACUUM INTO '${String(target).replaceAll("'", "''")}'`);
  }

  /** Value stored under `key` in the meta table, or null. */
  getMeta(key) {
    return this.#db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  }

  /** Upserts a meta value (stored as text). */
  setMeta(key, value) {
    this.#db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }

  /** A crashed running operator turn is retried once, then becomes visibly failed. */
  recoverAgentState() {
    return this.#tx(() => {
      const rows = this.#db.prepare("SELECT id, data FROM operator_turns WHERE status = 'running'").all();
      for (const row of rows) {
        const turn = JSON.parse(row.data);
        if (turn.attempts >= 2) {
          turn.status = 'failed';
          turn.finishedAt = this.#iso();
          turn.error = 'operator process ended twice before completion';
        } else {
          turn.status = 'queued';
          turn.startedAt = null;
        }
        this.#db.prepare('UPDATE operator_turns SET status = ?, data = ? WHERE id = ?')
          .run(turn.status, JSON.stringify(turn), turn.id);
        this.#feed('operator-turn', turn.id, { data: this.#turnSummary(turn) });
      }
      return rows.length;
    });
  }

  /** Upserts a manager's last heartbeat. `at` (ms) is kept as given, never refreshed on load. */
  recordHeartbeat({ name, member, at, agent, version, freeSlots, running }) {
    this.#db.prepare(`
      INSERT INTO manager_heartbeats (name, member, at, agent, version, free_slots, running)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET member = excluded.member, at = excluded.at, agent = excluded.agent,
        version = excluded.version, free_slots = excluded.free_slots, running = excluded.running
    `).run(name, member, at, agent, version, freeSlots, JSON.stringify(running ?? []));
  }

  /** Persisted heartbeats as Map entries: name -> { member, at, agent, version, freeSlots, running }. */
  listHeartbeats() {
    return new Map(this.#db.prepare('SELECT * FROM manager_heartbeats ORDER BY name').all().map((r) => [
      r.name,
      { member: r.member, at: r.at, agent: r.agent, version: r.version, freeSlots: r.free_slots, running: JSON.parse(r.running) },
    ]));
  }

  #iso(ms = this.#clock.now()) {
    return new Date(ms).toISOString();
  }

  #tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = fn();
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      this.#pending = [];
      throw err;
    }
    const events = this.#pending;
    this.#pending = [];
    for (const ev of events) {
      for (const listener of this.#listeners) {
        try {
          listener(ev);
        } catch {
          // Listeners (bus, dashboard) must never change store behaviour.
        }
      }
    }
    return result;
  }

  /** Runs fn once per (op, task, key). A repeated key returns the stored result. */
  #idem(op, taskId, key, fn) {
    if (!key) return fn();
    const full = `${op}:${taskId ?? ''}:${key}`;
    const hit = this.#db.prepare('SELECT result FROM idempotency WHERE key = ?').get(full);
    if (hit) return JSON.parse(hit.result);
    const result = fn();
    this.#db.prepare('INSERT INTO idempotency (key, result) VALUES (?, ?)').run(full, JSON.stringify(result));
    return result;
  }

  #feed(kind, refId, { taskId = null, assignmentId = null, data = {} } = {}) {
    const at = this.#clock.now();
    const result = this.#db.prepare(`
      INSERT INTO agent_feed (kind, ref_id, task_id, assignment_id, at, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(kind, String(refId), taskId, assignmentId, at, JSON.stringify(data));
    return Number(result.lastInsertRowid);
  }

  #assignmentSummary(assignment) {
    const { id, kind, parentId, manager, taskId, role, status, createdAt, updatedAt, endedAt = null } = assignment;
    return { id, kind, parentId, manager, taskId, role, status, createdAt, updatedAt, endedAt };
  }

  #sessionSummary(session) {
    const { id, assignmentId, agentKind, model, status, phase, startedAt, updatedAt, endedAt = null, inputTokens, outputTokens, lastEventSeq } = session;
    return { id, assignmentId, agentKind, model, status, phase, startedAt, updatedAt, endedAt, inputTokens, outputTokens, lastEventSeq };
  }

  #directiveSummary(directive) {
    const { id, target, taskId, kind, status, createdAt, deliveredAt = null, appliedAt = null, replacementSessionId = null } = directive;
    return { id, target, taskId, kind, status, createdAt, deliveredAt, appliedAt, replacementSessionId };
  }

  #turnSummary(turn) {
    const { id, conversationTarget, messageId, status, createdAt, startedAt = null, finishedAt = null, attempts } = turn;
    return { id, conversationTarget, messageId, status, createdAt, startedAt, finishedAt, attempts };
  }

  #load(id) {
    const row = this.#db.prepare('SELECT data, version FROM tasks WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown task ${id}`);
    return { task: JSON.parse(row.data), version: row.version };
  }

  #save(task, version) {
    task.updatedAt = this.#iso();
    assertValid('task', task);
    const res = this.#db
      .prepare('UPDATE tasks SET status = ?, version = version + 1, data = ? WHERE id = ? AND version = ?')
      .run(task.status, JSON.stringify(task), task.id, version);
    if (res.changes !== 1) throw new Error(`conflict on ${task.id}: version changed`);
  }

  #move(task, to, reason) {
    const from = task.status;
    assertTransition(from, to);
    const at = this.#iso();
    task.history.push({ from, to, at, reason });
    task.status = to;
    this.#pending.push({ taskId: task.id, department: task.department, from, to, reason, at });
  }

  #assertHolder(task, manager) {
    if (!task.lease || task.lease.manager !== manager) {
      throw new Error(`${task.id} is not leased by ${manager}`);
    }
  }

  #leaseFor(manager) {
    return { manager, expiresAt: this.#iso(this.#clock.now() + this.#opts.leaseMinutes * 60_000) };
  }

  /** Attempt spent. Retry goes to queued; the last attempt escalates. */
  #failCore(task, reason) {
    task.attempts += 1;
    this.#move(task, 'failed', reason);
    if (task.attempts >= this.#opts.maxAttempts) {
      this.#move(task, 'escalated', `attempt ${task.attempts} of ${this.#opts.maxAttempts} failed: ${reason}`);
    } else {
      this.#move(task, 'queued', `retry after attempt ${task.attempts}: ${reason}`);
    }
  }

  #unblock(mergedId) {
    const blocked = this.#db.prepare("SELECT id FROM tasks WHERE status = 'blocked'").all();
    for (const { id } of blocked) {
      const { task, version } = this.#load(id);
      if (!task.dependsOn.includes(mergedId)) continue;
      const ready = task.dependsOn.every((d) => this.#load(d).task.status === 'merged');
      if (ready) {
        this.#move(task, 'queued', `dependencies merged: ${task.dependsOn.join(', ')}`);
        this.#save(task, version);
      }
    }
  }

  // ---- agent cockpit ----------------------------------------------------

  upsertAgentAssignment(input) {
    return this.#tx(() => {
      const existing = parseData(this.#db.prepare('SELECT data FROM agent_assignments WHERE id = ?').get(input.id));
      const at = this.#iso();
      const assignment = {
        ...(existing ?? {}),
        ...input,
        createdAt: existing?.createdAt ?? input.createdAt ?? at,
        updatedAt: at,
      };
      if (['completed', 'failed', 'cancelled'].includes(assignment.status)) assignment.endedAt ??= at;
      assertValid('agent-assignment', assignment);
      this.#db.prepare(`
        INSERT INTO agent_assignments (id, kind, parent_id, manager, task_id, status, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, parent_id = excluded.parent_id,
          manager = excluded.manager, task_id = excluded.task_id, status = excluded.status,
          updated_at = excluded.updated_at, data = excluded.data
      `).run(
        assignment.id, assignment.kind, assignment.parentId, assignment.manager, assignment.taskId,
        assignment.status, this.#clock.now(), JSON.stringify(assignment),
      );
      this.#feed('assignment', assignment.id, {
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        data: this.#assignmentSummary(assignment),
      });
      return assignment;
    });
  }

  getAgentAssignment(id) {
    const assignment = parseData(this.#db.prepare('SELECT data FROM agent_assignments WHERE id = ?').get(id));
    if (!assignment) throw new Error(`unknown agent assignment ${id}`);
    return assignment;
  }

  listAgentAssignments({ taskId, manager, status } = {}) {
    return this.#db.prepare('SELECT data FROM agent_assignments ORDER BY updated_at DESC, id').all()
      .map(parseData)
      .filter((item) => (taskId === undefined || item.taskId === taskId)
        && (manager === undefined || item.manager === manager)
        && (status === undefined || item.status === status));
  }

  startAgentSession(input) {
    return this.#tx(() => {
      const assignment = this.getAgentAssignment(input.assignmentId);
      const existing = parseData(this.#db.prepare('SELECT data FROM agent_sessions WHERE id = ?').get(input.id));
      if (existing) {
        if (existing.assignmentId !== input.assignmentId) throw new Error(`${input.id} belongs to ${existing.assignmentId}`);
        return existing;
      }
      const at = this.#iso();
      const session = {
        ...input,
        startedAt: input.startedAt ?? at,
        updatedAt: input.updatedAt ?? at,
      };
      assertValid('agent-session', session);
      this.#db.prepare(`
        INSERT INTO agent_sessions (id, assignment_id, status, started_at, updated_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(session.id, session.assignmentId, session.status, Date.parse(session.startedAt), this.#clock.now(), JSON.stringify(session));
      this.#feed('session', session.id, {
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        data: this.#sessionSummary(session),
      });
      return session;
    });
  }

  getAgentSession(id) {
    const session = parseData(this.#db.prepare('SELECT data FROM agent_sessions WHERE id = ?').get(id));
    if (!session) throw new Error(`unknown agent session ${id}`);
    return session;
  }

  listAgentSessions({ assignmentId, status } = {}) {
    return this.#db.prepare('SELECT data FROM agent_sessions ORDER BY started_at DESC, id').all()
      .map(parseData)
      .filter((item) => (assignmentId === undefined || item.assignmentId === assignmentId)
        && (status === undefined || item.status === status));
  }

  latestAgentSession(assignmentId) {
    return parseData(this.#db.prepare('SELECT data FROM agent_sessions WHERE assignment_id = ? ORDER BY started_at DESC, id DESC LIMIT 1').get(assignmentId));
  }

  finishAgentSession(id, patch) {
    return this.#tx(() => {
      const session = this.getAgentSession(id);
      const assignment = this.getAgentAssignment(session.assignmentId);
      if (session.status !== 'running') {
        if (session.status === patch.status) return session;
        throw new Error(`${id} is already ${session.status}`);
      }
      const at = this.#iso();
      Object.assign(session, patch, { updatedAt: at, endedAt: patch.endedAt ?? at });
      assertValid('agent-session', session);
      this.#db.prepare('UPDATE agent_sessions SET status = ?, updated_at = ?, data = ? WHERE id = ?')
        .run(session.status, this.#clock.now(), JSON.stringify(session), id);
      this.#feed('session', session.id, {
        taskId: assignment.taskId,
        assignmentId: assignment.id,
        data: this.#sessionSummary(session),
      });
      return session;
    });
  }

  appendAgentEvents(sessionId, managerEvents) {
    return this.#tx(() => {
      const session = this.getAgentSession(sessionId);
      const assignment = this.getAgentAssignment(session.assignmentId);
      const accepted = [];
      let lastFeedSeq = this.#db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM agent_feed').get().seq;
      for (const original of managerEvents) {
        if (original.sessionId !== sessionId) throw new Error(`event session ${original.sessionId} does not match ${sessionId}`);
        if (original.assignmentId !== session.assignmentId) throw new Error(`event assignment ${original.assignmentId} does not match ${session.assignmentId}`);
        if (original.manager !== assignment.manager) throw new Error(`event manager ${original.manager} does not match ${assignment.manager}`);
        const event = { ...original, data: redactEventValue(original.data) };
        if (Buffer.byteLength(JSON.stringify(event.data), 'utf8') > 4096) throw new Error('agent event data exceeds 4 KiB');
        assertValid('agent-event', event);
        const inserted = this.#db.prepare(`
          INSERT OR IGNORE INTO agent_events (session_id, manager_seq, assignment_id, task_id, at, data)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(sessionId, event.managerSeq, event.assignmentId, event.taskId, Date.parse(event.at), JSON.stringify(event));
        if (inserted.changes !== 1) continue;
        accepted.push(event.managerSeq);
        lastFeedSeq = this.#feed('agent-event', inserted.lastInsertRowid, {
          taskId: event.taskId,
          assignmentId: event.assignmentId,
          data: {
            managerSeq: event.managerSeq, sessionId: event.sessionId, assignmentId: event.assignmentId,
            parentId: event.parentId, manager: event.manager, taskId: event.taskId, at: event.at,
            type: event.type, phase: event.phase, summary: event.summary,
          },
        });
        session.lastEventSeq = Math.max(session.lastEventSeq, event.managerSeq);
        if (event.type === 'tokens') {
          session.inputTokens += Number(event.data.inputTokens ?? 0);
          session.outputTokens += Number(event.data.outputTokens ?? 0);
        }
      }
      if (accepted.length) {
        session.updatedAt = this.#iso();
        assertValid('agent-session', session);
        this.#db.prepare('UPDATE agent_sessions SET updated_at = ?, data = ? WHERE id = ?')
          .run(this.#clock.now(), JSON.stringify(session), sessionId);
      }
      this.#pruneAgentData();
      return { accepted, lastFeedSeq };
    });
  }

  agentEvents(assignmentId, { before, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('event limit must be 1 to 500');
    const rows = before === undefined
      ? this.#db.prepare('SELECT id, data FROM agent_events WHERE assignment_id = ? ORDER BY id DESC LIMIT ?').all(assignmentId, limit)
      : this.#db.prepare('SELECT id, data FROM agent_events WHERE assignment_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(assignmentId, before, limit);
    return rows.reverse().map(parseData);
  }

  #pruneAgentData() {
    const { maxAgeMs, maxTotal, maxPerSession } = this.#opts.agentRetention;
    const deleteIds = (ids) => {
      const delEvent = this.#db.prepare('DELETE FROM agent_events WHERE id = ?');
      const delFeed = this.#db.prepare("DELETE FROM agent_feed WHERE kind = 'agent-event' AND ref_id = ?");
      for (const id of ids) {
        delEvent.run(id);
        delFeed.run(String(id));
      }
    };
    deleteIds(this.#db.prepare('SELECT id FROM agent_events WHERE at < ? ORDER BY at, id').all(this.#clock.now() - maxAgeMs).map((row) => row.id));
    const sessions = this.#db.prepare('SELECT session_id, COUNT(*) AS n FROM agent_events GROUP BY session_id HAVING n > ?').all(maxPerSession);
    for (const row of sessions) {
      const extra = row.n - maxPerSession;
      deleteIds(this.#db.prepare('SELECT id FROM agent_events WHERE session_id = ? ORDER BY id LIMIT ?').all(row.session_id, extra).map((item) => item.id));
    }
    const total = this.#db.prepare('SELECT COUNT(*) AS n FROM agent_events').get().n;
    if (total > maxTotal) {
      deleteIds(this.#db.prepare('SELECT id FROM agent_events ORDER BY at, id LIMIT ?').all(total - maxTotal).map((row) => row.id));
    }
  }

  pruneAgentData() {
    return this.#tx(() => this.#pruneAgentData());
  }

  createAgentDirective(input) {
    return this.#tx(() => {
      const hit = parseData(this.#db.prepare('SELECT data FROM agent_directives WHERE idempotency_key = ?').get(input.idempotencyKey));
      if (hit) return hit;
      const assignment = this.getAgentAssignment(input.target);
      if (input.taskId !== assignment.taskId) throw new Error(`directive task ${input.taskId} does not match ${assignment.taskId}`);
      if (input.taskId) {
        const task = this.getTask(input.taskId);
        if (['merged', 'cancelled'].includes(task.status)) throw new Error(`${input.taskId} is terminal (${task.status})`);
      }
      const directive = {
        id: input.id ?? `directive-${randomUUID()}`,
        idempotencyKey: input.idempotencyKey,
        target: input.target,
        taskId: input.taskId ?? null,
        kind: input.kind,
        payload: input.payload ?? {},
        actor: input.actor,
        reason: input.reason ?? null,
        status: 'queued',
        createdAt: this.#iso(),
        deliveredAt: null,
        appliedAt: null,
        result: null,
        replacementSessionId: null,
      };
      assertValid('agent-directive', directive);
      this.#db.prepare(`
        INSERT INTO agent_directives (id, idempotency_key, target, manager, task_id, status, created_at, data)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        directive.id, directive.idempotencyKey, directive.target, assignment.manager,
        directive.taskId, directive.status, this.#clock.now(), JSON.stringify(directive),
      );
      this.#feed('directive', directive.id, {
        taskId: directive.taskId,
        assignmentId: assignment.id,
        data: this.#directiveSummary(directive),
      });
      return directive;
    });
  }

  getAgentDirective(id) {
    const directive = parseData(this.#db.prepare('SELECT data FROM agent_directives WHERE id = ?').get(id));
    if (!directive) throw new Error(`unknown agent directive ${id}`);
    return directive;
  }

  managerDirectives(manager, { after } = {}) {
    const rows = this.#db.prepare(`
      SELECT data FROM agent_directives
      WHERE manager = ? AND status IN ('queued', 'delivered')
      ORDER BY created_at, id
    `).all(manager).map(parseData);
    if (!after) return rows;
    const index = rows.findIndex((item) => item.id === after);
    return index < 0 ? rows : rows.slice(index + 1);
  }

  ackAgentDirective(id, { manager, status, result = null, replacementSessionId = null }) {
    return this.#tx(() => {
      const row = this.#db.prepare('SELECT manager, data FROM agent_directives WHERE id = ?').get(id);
      if (!row) throw new Error(`unknown agent directive ${id}`);
      if (row.manager !== manager) throw new Error(`${id} is not assigned to ${manager}`);
      const directive = JSON.parse(row.data);
      if (['applied', 'failed', 'cancelled'].includes(directive.status)) {
        if (directive.status === status && directive.result === result && directive.replacementSessionId === replacementSessionId) return directive;
        throw new Error(`${id} is already ${directive.status}`);
      }
      const allowed = directive.status === 'queued'
        ? new Set(['delivered', 'applied', 'failed', 'cancelled'])
        : new Set(['delivered', 'applied', 'failed', 'cancelled']);
      if (!allowed.has(status)) throw new Error(`cannot acknowledge ${directive.status} as ${status}`);
      const at = this.#iso();
      directive.status = status;
      if (status === 'delivered') directive.deliveredAt ??= at;
      else directive.appliedAt = at;
      directive.result = result;
      directive.replacementSessionId = replacementSessionId;
      assertValid('agent-directive', directive);
      this.#db.prepare('UPDATE agent_directives SET status = ?, data = ? WHERE id = ?')
        .run(status, JSON.stringify(directive), id);
      this.#feed('directive', id, {
        taskId: directive.taskId,
        assignmentId: directive.target,
        data: this.#directiveSummary(directive),
      });
      return directive;
    });
  }

  #cancelTaskDirectives(taskId, reason) {
    const rows = this.#db.prepare(`
      SELECT id, data FROM agent_directives
      WHERE task_id = ? AND status IN ('queued', 'delivered')
      ORDER BY created_at, id
    `).all(taskId);
    for (const row of rows) {
      const directive = JSON.parse(row.data);
      directive.status = 'cancelled';
      directive.appliedAt = this.#iso();
      directive.result = `target task terminal: ${reason}`.slice(0, 2000);
      this.#db.prepare('UPDATE agent_directives SET status = ?, data = ? WHERE id = ?')
        .run(directive.status, JSON.stringify(directive), directive.id);
      this.#feed('directive', directive.id, {
        taskId,
        assignmentId: directive.target,
        data: this.#directiveSummary(directive),
      });
    }
  }

  appendAgentMessage({ target, actor, role, text, directiveId = null, actionId = null }) {
    if (!['user', 'assistant', 'system', 'action'].includes(role)) throw new Error(`unknown message role ${role}`);
    if (typeof text !== 'string' || text.length < 1 || Buffer.byteLength(text, 'utf8') > 8192) {
      throw new Error('agent message text must be 1 to 8192 bytes');
    }
    return this.#tx(() => {
      const at = this.#iso();
      this.#db.prepare('INSERT OR IGNORE INTO agent_conversations (target, created_at) VALUES (?, ?)')
        .run(target, this.#clock.now());
      const message = { target, actor, role, text, directiveId, actionId, createdAt: at };
      const inserted = this.#db.prepare('INSERT INTO agent_messages (target, created_at, data) VALUES (?, ?, ?)')
        .run(target, this.#clock.now(), JSON.stringify(message));
      message.id = Number(inserted.lastInsertRowid);
      this.#db.prepare('UPDATE agent_messages SET data = ? WHERE id = ?').run(JSON.stringify(message), message.id);
      this.#feed('message', message.id, {
        assignmentId: target === 'orchestrator' ? null : target,
        data: { id: message.id, target, role, createdAt: at, directiveId, actionId },
      });
      return message;
    });
  }

  agentMessages(target, { before, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('message limit must be 1 to 100');
    const rows = before === undefined
      ? this.#db.prepare('SELECT data FROM agent_messages WHERE target = ? ORDER BY id DESC LIMIT ?').all(target, limit)
      : this.#db.prepare('SELECT data FROM agent_messages WHERE target = ? AND id < ? ORDER BY id DESC LIMIT ?').all(target, before, limit);
    return rows.reverse().map(parseData);
  }

  createOperatorTurn({ target, messageId }) {
    return this.#tx(() => {
      const message = parseData(this.#db.prepare('SELECT data FROM agent_messages WHERE id = ?').get(messageId));
      if (!message || message.target !== target || message.role !== 'user') throw new Error(`message ${messageId} is not a user message for ${target}`);
      const existing = parseData(this.#db.prepare('SELECT data FROM operator_turns WHERE message_id = ?').get(messageId));
      if (existing) return existing;
      const turn = {
        id: `turn-${randomUUID()}`,
        conversationTarget: target,
        messageId,
        status: 'queued',
        createdAt: this.#iso(),
        startedAt: null,
        finishedAt: null,
        attempts: 0,
        error: null,
      };
      assertValid('operator-turn', turn);
      this.#db.prepare(`
        INSERT INTO operator_turns (id, target, message_id, status, created_at, data)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(turn.id, target, messageId, turn.status, this.#clock.now(), JSON.stringify(turn));
      this.#feed('operator-turn', turn.id, { assignmentId: target === 'orchestrator' ? null : target, data: this.#turnSummary(turn) });
      return turn;
    });
  }

  getOperatorTurn(id) {
    const turn = parseData(this.#db.prepare('SELECT data FROM operator_turns WHERE id = ?').get(id));
    if (!turn) throw new Error(`unknown operator turn ${id}`);
    return turn;
  }

  claimNextOperatorTurn() {
    return this.#tx(() => {
      const row = this.#db.prepare("SELECT id, data FROM operator_turns WHERE status = 'queued' ORDER BY created_at, message_id LIMIT 1").get();
      if (!row) return null;
      const turn = JSON.parse(row.data);
      turn.status = 'running';
      turn.startedAt = this.#iso();
      turn.finishedAt = null;
      turn.error = null;
      turn.attempts += 1;
      assertValid('operator-turn', turn);
      this.#db.prepare('UPDATE operator_turns SET status = ?, data = ? WHERE id = ?').run(turn.status, JSON.stringify(turn), turn.id);
      this.#feed('operator-turn', turn.id, {
        assignmentId: turn.conversationTarget === 'orchestrator' ? null : turn.conversationTarget,
        data: this.#turnSummary(turn),
      });
      return turn;
    });
  }

  finishOperatorTurn(id, { status, error = null }) {
    if (!['succeeded', 'failed'].includes(status)) throw new Error(`operator turn cannot finish as ${status}`);
    return this.#tx(() => {
      const turn = this.getOperatorTurn(id);
      if (turn.status !== 'running') {
        if (turn.status === status) return turn;
        throw new Error(`${id} is ${turn.status}, not running`);
      }
      turn.status = status;
      turn.finishedAt = this.#iso();
      turn.error = error;
      assertValid('operator-turn', turn);
      this.#db.prepare('UPDATE operator_turns SET status = ?, data = ? WHERE id = ?').run(status, JSON.stringify(turn), id);
      this.#feed('operator-turn', turn.id, {
        assignmentId: turn.conversationTarget === 'orchestrator' ? null : turn.conversationTarget,
        data: this.#turnSummary(turn),
      });
      return turn;
    });
  }

  createOperatorActions(turnId, actions) {
    return this.#tx(() => {
      const turn = this.getOperatorTurn(turnId);
      return actions.map((input, index) => {
        const action = {
          id: input.id ?? `action-${randomUUID()}`,
          turnId,
          kind: input.kind,
          payload: input.payload ?? {},
          status: input.status ?? 'pending',
          createdAt: this.#iso(this.#clock.now() + index),
          resolvedAt: null,
          actor: null,
          reason: null,
          result: null,
        };
        if (!OPERATOR_ACTION_KINDS.has(action.kind)) throw new Error(`unknown operator action ${action.kind}`);
        this.#db.prepare(`
          INSERT INTO operator_actions (id, turn_id, status, created_at, data) VALUES (?, ?, ?, ?, ?)
        `).run(action.id, turn.id, action.status, this.#clock.now() + index, JSON.stringify(action));
        this.#feed('operator-action', action.id, {
          assignmentId: turn.conversationTarget === 'orchestrator' ? null : turn.conversationTarget,
          data: { id: action.id, turnId, kind: action.kind, status: action.status, createdAt: action.createdAt },
        });
        return action;
      });
    });
  }

  operatorActions(turnId) {
    return this.#db.prepare('SELECT data FROM operator_actions WHERE turn_id = ? ORDER BY created_at, id').all(turnId).map(parseData);
  }

  agentAudit({ assignmentId, taskId, limit = 200 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('audit limit must be 1 to 500');
    const assignments = new Map(this.listAgentAssignments().map((item) => [item.id, item]));
    const matches = (candidateAssignment, candidateTask) => (
      (assignmentId === undefined || candidateAssignment === assignmentId)
      && (taskId === undefined || candidateTask === taskId)
    );
    const items = [];
    for (const row of this.#db.prepare('SELECT data FROM agent_directives ORDER BY created_at DESC, id DESC LIMIT 500').all()) {
      const directive = JSON.parse(row.data);
      if (!matches(directive.target, directive.taskId)) continue;
      items.push({
        id: directive.id, kind: 'directive', action: directive.kind, assignmentId: directive.target, taskId: directive.taskId,
        status: directive.status, actor: directive.actor ?? null, reason: directive.reason ?? null,
        result: directive.result ?? null, at: directive.appliedAt ?? directive.deliveredAt ?? directive.createdAt, createdAt: directive.createdAt,
      });
    }
    for (const row of this.#db.prepare('SELECT data FROM operator_turns ORDER BY created_at DESC, id DESC LIMIT 500').all()) {
      const turn = JSON.parse(row.data);
      const targetAssignment = turn.conversationTarget === 'orchestrator' ? null : turn.conversationTarget;
      const targetTask = assignments.get(targetAssignment)?.taskId ?? null;
      if (!matches(targetAssignment, targetTask)) continue;
      const message = parseData(this.#db.prepare('SELECT data FROM agent_messages WHERE id = ?').get(turn.messageId));
      items.push({
        id: turn.id, kind: 'operator-turn', action: 'prompt', assignmentId: targetAssignment, taskId: targetTask,
        status: turn.status, actor: message?.actor ?? null, reason: null, result: turn.error ?? null,
        at: turn.finishedAt ?? turn.startedAt ?? turn.createdAt, createdAt: turn.createdAt,
      });
    }
    for (const row of this.#db.prepare('SELECT data FROM operator_actions ORDER BY created_at DESC, id DESC LIMIT 500').all()) {
      const action = JSON.parse(row.data);
      const turn = this.getOperatorTurn(action.turnId);
      const targetAssignment = turn.conversationTarget === 'orchestrator' ? null : turn.conversationTarget;
      const targetTask = assignments.get(targetAssignment)?.taskId ?? null;
      if (!matches(targetAssignment, targetTask)) continue;
      items.push({
        id: action.id, kind: 'operator-action', action: action.kind, assignmentId: targetAssignment, taskId: targetTask,
        status: action.status, actor: action.actor ?? null, reason: action.reason ?? null, result: action.result ?? null,
        at: action.resolvedAt ?? action.createdAt, createdAt: action.createdAt,
      });
    }
    return items.sort((a, b) => Date.parse(b.at ?? b.createdAt) - Date.parse(a.at ?? a.createdAt)).slice(0, limit);
  }

  getOperatorAction(id) {
    const action = parseData(this.#db.prepare('SELECT data FROM operator_actions WHERE id = ?').get(id));
    if (!action) throw new Error(`unknown operator action ${id}`);
    return action;
  }

  resolveOperatorAction(id, { status, actor, reason, result = null, idempotencyKey }) {
    if (!['confirmed', 'cancelled', 'applied', 'failed'].includes(status)) throw new Error(`bad operator action status ${status}`);
    return this.#tx(() => this.#idem('operator-action', id, idempotencyKey, () => {
      const action = this.getOperatorAction(id);
      if (action.status !== 'pending' && action.status !== 'confirmed') {
        if (action.status === status) return action;
        throw new Error(`${id} is already ${action.status}`);
      }
      action.status = status;
      action.actor = actor;
      action.reason = reason;
      action.result = result;
      action.resolvedAt = this.#iso();
      this.#db.prepare('UPDATE operator_actions SET status = ?, data = ? WHERE id = ?')
        .run(status, JSON.stringify(action), id);
      const turn = this.getOperatorTurn(action.turnId);
      this.#feed('operator-action', action.id, {
        assignmentId: turn.conversationTarget === 'orchestrator' ? null : turn.conversationTarget,
        data: { id: action.id, turnId: action.turnId, kind: action.kind, status, resolvedAt: action.resolvedAt },
      });
      return action;
    }));
  }

  agentFeed({ after = 0, taskId, assignmentId, limit = 500 } = {}) {
    if (!Number.isInteger(after) || after < 0) throw new Error('feed cursor must be a non-negative integer');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('feed limit must be 1 to 500');
    const clauses = ['seq > ?'];
    const args = [after];
    if (taskId !== undefined) { clauses.push('task_id = ?'); args.push(taskId); }
    if (assignmentId !== undefined) { clauses.push('assignment_id = ?'); args.push(assignmentId); }
    args.push(limit);
    const rows = this.#db.prepare(`
      SELECT seq, kind, ref_id, task_id, assignment_id, at, data
      FROM agent_feed WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT ?
    `).all(...args);
    const items = rows.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      refId: row.ref_id,
      taskId: row.task_id,
      assignmentId: row.assignment_id,
      at: new Date(row.at).toISOString(),
      data: JSON.parse(row.data),
    }));
    return { items, lastSeq: items.at(-1)?.seq ?? after };
  }

  // ---- epics and tasks ---------------------------------------------------

  createEpic(input) {
    return this.#tx(() => {
      const at = this.#iso();
      const epic = { status: 'open', source: 'human', issue: null, createdAt: at, updatedAt: at, ...input };
      assertValid('epic', epic);
      if (this.#db.prepare('SELECT 1 FROM epics WHERE id = ?').get(epic.id)) {
        throw new Error(`epic ${epic.id} already exists`);
      }
      if (epic.issue != null && this.#db.prepare('SELECT 1 FROM epics WHERE issue_repo = ? AND issue = ?').get(epic.repo.toLowerCase(), epic.issue)) {
        throw new Error(`epic for ${epic.repo}#${epic.issue} already exists`);
      }
      this.#db
        .prepare('INSERT INTO epics (id, created_at, data, issue_repo, issue) VALUES (?, ?, ?, ?, ?)')
        .run(epic.id, epic.createdAt, JSON.stringify(epic), epic.issue == null ? null : epic.repo.toLowerCase(), epic.issue ?? null);
      return epic;
    });
  }

  /** The epic made from an issue, or null. Survives restarts (persisted columns). */
  findEpicByIssue(repo, issue) {
    const row = this.#db.prepare('SELECT data FROM epics WHERE issue_repo = ? AND issue = ?').get(String(repo).toLowerCase(), issue);
    return row ? JSON.parse(row.data) : null;
  }

  /** All epics, oldest first. */
  listEpics() {
    return this.#db.prepare('SELECT data FROM epics ORDER BY created_at, id').all().map((r) => JSON.parse(r.data));
  }

  getEpic(id) {
    const row = this.#db.prepare('SELECT data FROM epics WHERE id = ?').get(id);
    if (!row) throw new Error(`unknown epic ${id}`);
    return JSON.parse(row.data);
  }

  createTask(input) {
    return this.#tx(() => {
      const at = this.#iso();
      const dependsOn = input.dependsOn ?? [];
      if (!this.#db.prepare('SELECT 1 FROM epics WHERE id = ?').get(input.epicId)) {
        throw new Error(`unknown epic ${input.epicId}`);
      }
      if (this.#db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(input.id)) {
        throw new Error(`task ${input.id} already exists`);
      }
      const ready = dependsOn.every((d) => this.#load(d).task.status === 'merged');
      const status = dependsOn.length > 0 && !ready ? 'blocked' : 'queued';
      const task = {
        ...input,
        dependsOn,
        status,
        attempts: 0,
        usedTokens: 0,
        lease: null,
        holder: null,
        branch: input.branch ?? null,
        pr: null,
        lastProgressAt: null,
        lastPhase: null,
        lastNote: null,
        review: null,
        history: [{ from: null, to: status, at, reason: 'created' }],
        createdAt: at,
        updatedAt: at,
      };
      assertValid('task', task);
      this.#db
        .prepare('INSERT INTO tasks (id, epic_id, department, status, created_at, version, data) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .run(task.id, task.epicId, task.department, task.status, task.createdAt, JSON.stringify(task));
      return task;
    });
  }

  getTask(id) {
    return this.#load(id).task;
  }

  listTasks({ department, status } = {}) {
    const rows = this.#db.prepare('SELECT data FROM tasks ORDER BY id').all();
    return rows
      .map((r) => JSON.parse(r.data))
      .filter((t) => (department === undefined || t.department === department) && (status === undefined || t.status === status));
  }

  history(id) {
    return this.#load(id).task.history;
  }

  /** Epic id -> createdAt, for queue ordering outside the store. */
  epicAges() {
    return new Map(this.#db.prepare('SELECT id, created_at FROM epics').all().map((r) => [r.id, r.created_at]));
  }

  /** Queued tasks of a department in lease order. */
  queueOf(department) {
    const cmp = compareQueued(this.epicAges());
    return this.listTasks({ department, status: 'queued' }).sort(cmp);
  }

  // ---- manager calls -----------------------------------------------------

  /** queued -> leased for the best tasks of a department (priority, epic age, task age, id). */
  lease({ department, slots, manager, idempotencyKey }) {
    if (!Number.isInteger(slots) || slots < 1 || slots > MAX_SLOTS) {
      throw new Error(`slots must be an integer from 1 to ${MAX_SLOTS}`);
    }
    if (!manager) throw new Error('manager is required');
    return this.#tx(() => this.#idem('lease', department, idempotencyKey, () => {
      const epicAge = new Map(this.#db.prepare('SELECT id, created_at FROM epics').all().map((r) => [r.id, r.created_at]));
      const queued = this.#db
        .prepare("SELECT id, data, version FROM tasks WHERE department = ? AND status = 'queued'")
        .all(department)
        .map((r) => ({ task: JSON.parse(r.data), version: r.version }));
      const cmp = compareQueued(epicAge);
      queued.sort((a, b) => cmp(a.task, b.task));
      const out = [];
      for (const { task, version } of queued.slice(0, slots)) {
        this.#move(task, 'leased', `leased by ${manager}`);
        task.lease = this.#leaseFor(manager);
        task.holder = manager;
        this.#save(task, version);
        out.push(task);
      }
      return out;
    }));
  }

  /** Fix work first: changes_requested tasks of this manager go back to it, in_progress, with a fresh lease. */
  leaseFixes({ department, manager }) {
    if (!manager) throw new Error('manager is required');
    const ids = this.listTasks({ department, status: 'changes_requested' })
      .filter((t) => t.holder === manager)
      .map((t) => t.id);
    return ids.map((id) => this.resumeFix({ id, manager }));
  }

  /** Reports progress, renews the lease, and counts tokens. leased -> in_progress on first call. */
  progress({ id, manager, phase, note = '', tokens = 0, idempotencyKey }) {
    if (!Number.isInteger(tokens) || tokens < 0) throw new Error('tokens must be a non-negative integer');
    return this.#tx(() => this.#idem('progress', id, idempotencyKey, () => {
      const { task, version } = this.#load(id);
      this.#assertHolder(task, manager);
      if (task.status === 'leased') this.#move(task, 'in_progress', 'first progress report');
      else if (task.status !== 'in_progress') throw new Error(`cannot report progress in ${task.status}`);
      const now = this.#clock.now();
      task.lease.expiresAt = this.#iso(now + this.#opts.leaseMinutes * 60_000);
      task.lastProgressAt = this.#iso(now);
      task.lastPhase = phase;
      task.lastNote = note;
      task.usedTokens += tokens;
      this.#save(task, version);
      return task;
    }));
  }

  /** in_progress -> submitted with a PR and evidence for every acceptance criterion. */
  submit({ id, manager, pr, headSha, evidence, idempotencyKey }) {
    return this.#tx(() => this.#idem('submit', id, idempotencyKey, () => {
      const { task, version } = this.#load(id);
      this.#assertHolder(task, manager);
      const covered = task.acceptance.every((c) => evidence.some((e) => e.criterion === c));
      if (!covered) throw new Error(`evidence must cover every acceptance criterion of ${id}`);
      this.#move(task, 'submitted', `PR #${pr} at ${headSha.slice(0, 7)}`);
      task.pr = pr;
      task.lease = null;
      task.review = { headSha, evidence, rounds: task.review?.rounds ?? 0, findings: [] };
      this.#save(task, version);
      return task;
    }));
  }

  /**
   * Heartbeat renewal: a manager's running tasks keep their leases. Only leases
   * the manager holds, in leased or in_progress, are renewed. Unknown or foreign ids are skipped.
   */
  renewLeases({ manager, ids }) {
    return this.#tx(() => {
      const now = this.#clock.now();
      let renewed = 0;
      for (const id of ids) {
        const row = this.#db.prepare('SELECT data, version FROM tasks WHERE id = ?').get(id);
        if (!row) continue;
        const task = JSON.parse(row.data);
        if (!task.lease || task.lease.manager !== manager) continue;
        if (!['leased', 'in_progress'].includes(task.status)) continue;
        task.lease.expiresAt = this.#iso(now + this.#opts.leaseMinutes * 60_000);
        this.#save(task, row.version);
        renewed += 1;
      }
      return renewed;
    });
  }

  /** Manager gives the task back without spending an attempt. */
  release({ id, manager, reason }) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      this.#assertHolder(task, manager);
      task.lease = null;
      this.#move(task, 'queued', `released: ${reason}`);
      this.#save(task, version);
      return task;
    });
  }

  /** Manager reports a failure; spends an attempt. */
  fail({ id, manager, reason }) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      this.#assertHolder(task, manager);
      task.lease = null;
      this.#failCore(task, reason);
      this.#save(task, version);
      return task;
    });
  }

  // ---- orchestrator calls ------------------------------------------------

  /**
   * The orchestrator's machine slept for ms (ARCHITECTURE 70): every open lease gets that time back, so a
   * suspend does not expire it. Returns the ids extended.
   */
  extendLeases(ms) {
    return this.#tx(() => {
      const active = this.#db.prepare("SELECT id FROM tasks WHERE status IN ('leased', 'in_progress')").all();
      const extended = [];
      for (const { id } of active) {
        const { task, version } = this.#load(id);
        if (!task.lease) continue;
        task.lease.expiresAt = this.#iso(Date.parse(task.lease.expiresAt) + ms);
        this.#save(task, version);
        extended.push(id);
      }
      return extended;
    });
  }

  /** Expired leases count as failures (attempts + 1). Returns the affected task ids. */
  expireLeases() {
    return this.#tx(() => {
      const now = this.#clock.now();
      const active = this.#db.prepare("SELECT id FROM tasks WHERE status IN ('leased', 'in_progress')").all();
      const expired = [];
      for (const { id } of active) {
        const { task, version } = this.#load(id);
        if (!task.lease || Date.parse(task.lease.expiresAt) > now) continue;
        task.lease = null;
        this.#failCore(task, 'lease expired');
        this.#save(task, version);
        expired.push(id);
      }
      return expired;
    });
  }

  startReview(id) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      this.#move(task, 'in_review', 'gates started');
      this.#save(task, version);
      return task;
    });
  }

  /**
   * The orchestrator asked GitHub to bring the PR branch up to date with main (ARCHITECTURE 68). The task
   * waits as submitted for the new head (in_review goes back to submitted); no review round is spent.
   */
  branchUpdateRequested(id, behind) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      if (task.status === 'in_review') this.#move(task, 'submitted', `branch ${behind} commits behind main after review: updated from main`);
      else if (task.status !== 'submitted') throw new Error(`${id} is ${task.status}, not submitted or in_review`);
      task.review.update = { from: task.review.headSha, behind, at: this.#iso() };
      this.#save(task, version);
      return task;
    });
  }

  /** The branch update landed: its head becomes the submitted head. Still submitted, no round spent. */
  adoptUpdatedHead(id, headSha) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      if (task.status !== 'submitted' || !task.review?.update) throw new Error(`${id} has no branch update pending`);
      task.review.headSha = headSha;
      task.review.update = null;
      task.review.updatedAt = this.#iso();
      this.#save(task, version);
      return task;
    });
  }

  /** Review findings: changes_requested, or needs-human once maxReviewRounds is reached. */
  requestChanges(id, findings) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      task.review.rounds += 1;
      task.review.findings = findings;
      task.review.update = null;
      const reason = `changes requested (round ${task.review.rounds} of ${this.#opts.maxReviewRounds})`;
      if (task.review.rounds >= this.#opts.maxReviewRounds) this.#move(task, 'needs-human', reason);
      else this.#move(task, 'changes_requested', reason);
      this.#save(task, version);
      return task;
    });
  }

  /** changes_requested -> in_progress, for the same manager, with a fresh lease. */
  resumeFix({ id, manager }) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      this.#move(task, 'in_progress', `fix started by ${manager}`);
      task.lease = this.#leaseFor(manager);
      this.#save(task, version);
      return task;
    });
  }

  /** in_review -> needs-human: a person must decide (human review path, closed PR, unclear state). */
  needsHuman(id, reason) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      this.#move(task, 'needs-human', reason);
      this.#save(task, version);
      return task;
    });
  }

  markMerged(id, reason = 'merged') {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      this.#move(task, 'merged', reason);
      this.#cancelTaskDirectives(id, `task merged: ${reason}`);
      this.#save(task, version);
      this.#unblock(id);
      return task;
    });
  }

  /** escalated -> queued after the orchestrator replans. Attempts reset. */
  replan(id, reason) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      task.attempts = 0;
      this.#move(task, 'queued', `replanned: ${reason}`);
      this.#save(task, version);
      return task;
    });
  }

  /** needs-human -> queued after a person resolves it. Attempts reset. */
  resolve(id, reason) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      task.attempts = 0;
      this.#move(task, 'queued', `resolved: ${reason}`);
      this.#save(task, version);
      return task;
    });
  }

  /**
   * A person fixes a stuck or blocked task (ARCHITECTURE 63): new paths, new acceptance, dropped
   * dependencies, then it goes back to the queue with attempts reset. A blocked task is queued only
   * when every remaining dependency has merged. The caller checks who may do it and which paths.
   */
  amend(id, { paths, acceptance, dropDependsOn = [] }, reason) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      if (!AMENDABLE.has(task.status)) throw new Error(`${id} is ${task.status}; only ${[...AMENDABLE].join(', ')} tasks can be amended`);
      const changed = [];
      if (paths) { task.paths = paths; changed.push(`paths ${paths.join(' ')}`); }
      if (acceptance) { task.acceptance = acceptance; changed.push(`acceptance (${acceptance.length})`); }
      for (const d of dropDependsOn) if (!task.dependsOn.includes(d)) throw new Error(`${id} does not depend on ${d}`);
      if (dropDependsOn.length) { task.dependsOn = task.dependsOn.filter((d) => !dropDependsOn.includes(d)); changed.push(`dropped ${dropDependsOn.join(' ')}`); }
      if (!changed.length) throw new Error('nothing to amend: give paths, acceptance or dependencies to drop');
      const text = `amended: ${changed.join('; ')}: ${reason}`.slice(0, 600);
      task.attempts = 0;
      if (task.status !== 'blocked') this.#move(task, 'queued', text);
      else if (task.dependsOn.every((d) => this.#load(d).task.status === 'merged')) this.#move(task, 'queued', text);
      else task.history.push({ from: 'blocked', to: 'blocked', at: this.#iso(), reason: text });
      this.#save(task, version);
      return task;
    });
  }

  cancel(id, reason) {
    return this.#tx(() => {
      const { task, version } = this.#load(id);
      task.lease = null;
      this.#move(task, 'cancelled', reason);
      this.#cancelTaskDirectives(id, `task cancelled: ${reason}`);
      this.#save(task, version);
      return task;
    });
  }
}
