import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.mjs';

function fakeClock(start = '2026-11-01T18:00:00.000Z') {
  let t = Date.parse(start);
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function setup(opts = {}) {
  const clock = fakeClock();
  const store = openStore({ clock, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3, ...opts });
  store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'body' });
  return { store, clock };
}

const SHA = 'a'.repeat(40);

function task(id, extra = {}) {
  return {
    id,
    epicId: 'E-0001',
    repo: 'o/r',
    title: `task ${id}`,
    department: 'core',
    priority: 'p1',
    size: 'S',
    paths: [`swarm/x/${id}.mjs`],
    dependsOn: [],
    acceptance: ['works'],
    budget: { tokens: 500000, minutes: 30 },
    ...extra,
  };
}

const evidence = [{ criterion: 'works', met: true, detail: 'tested' }];

describe('store: create', () => {
  it('creates a queued task when it has no dependencies', () => {
    const { store } = setup();
    const t = store.createTask(task('T-0001'));
    assert.equal(t.status, 'queued');
    assert.equal(t.history[0].reason, 'created');
  });

  it('creates a blocked task while a dependency is not merged', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    const t = store.createTask(task('T-0002', { dependsOn: ['T-0001'] }));
    assert.equal(t.status, 'blocked');
  });

  it('rejects an unknown dependency and an unknown epic', () => {
    const { store } = setup();
    assert.throws(() => store.createTask(task('T-0002', { dependsOn: ['T-9999'] })), /unknown task T-9999/);
    assert.throws(() => store.createTask(task('T-0003', { epicId: 'E-9999' })), /unknown epic E-9999/);
  });

  it('rejects an invalid record and writes nothing', () => {
    const { store } = setup();
    assert.throws(() => store.createTask(task('T-0004', { priority: 'urgent' })), /\/priority/);
    assert.equal(store.listTasks().length, 0);
  });
});

describe('store: lease, progress, submit', () => {
  it('leases by priority, then epic age, then task age', () => {
    const { store } = setup();
    store.createTask(task('T-0001', { priority: 'p2' }));
    store.createTask(task('T-0002', { priority: 'p0' }));
    store.createTask(task('T-0003', { priority: 'p0' }));
    const got = store.lease({ department: 'core', slots: 2, manager: 'm1' }).map((t) => t.id);
    assert.deepEqual(got, ['T-0002', 'T-0003']);
  });

  it('does not lease more than the slots, nor other departments', () => {
    const { store } = setup();
    store.createTask(task('T-0001', { department: 'docs' }));
    store.createTask(task('T-0002'));
    assert.deepEqual(store.lease({ department: 'core', slots: 5, manager: 'm1' }).map((t) => t.id), ['T-0002']);
  });

  it('rejects slots outside 1 to 10', () => {
    const { store } = setup();
    assert.throws(() => store.lease({ department: 'core', slots: 0, manager: 'm' }), /slots/);
    assert.throws(() => store.lease({ department: 'core', slots: 11, manager: 'm' }), /slots/);
  });

  it('first progress moves leased to in_progress and renews the lease', () => {
    const { store, clock } = setup();
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    clock.advance(9 * 60_000);
    const t = store.progress({ id: 'T-0001', manager: 'm1', phase: 'subagents', note: 'exploring', tokens: 1200 });
    assert.equal(t.status, 'in_progress');
    assert.equal(t.usedTokens, 1200);
    assert.equal(t.lastPhase, 'subagents');
    assert.equal(Date.parse(t.lease.expiresAt), clock.now() + 10 * 60_000);
  });

  it('refuses progress from a manager that does not hold the lease', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    assert.throws(() => store.progress({ id: 'T-0001', manager: 'other', phase: 'planning', note: '', tokens: 0 }), /not leased by other/);
  });

  it('submit needs evidence for every acceptance criterion', () => {
    const { store } = setup();
    store.createTask(task('T-0001', { acceptance: ['works', 'tested'] }));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    store.progress({ id: 'T-0001', manager: 'm1', phase: 'checks', note: '', tokens: 0 });
    assert.throws(() => store.submit({ id: 'T-0001', manager: 'm1', pr: 7, headSha: SHA, evidence }), /every acceptance criterion/);
    assert.equal(store.getTask('T-0001').status, 'in_progress');
  });

  it('submit records the PR, clears the lease and moves to submitted', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    store.progress({ id: 'T-0001', manager: 'm1', phase: 'pr', note: '', tokens: 0 });
    const t = store.submit({ id: 'T-0001', manager: 'm1', pr: 7, headSha: SHA, evidence });
    assert.equal(t.status, 'submitted');
    assert.equal(t.pr, 7);
    assert.equal(t.lease, null);
  });
});

describe('store: leases, retries and escalation', () => {
  it('an expired lease returns the task to queued with attempts + 1', () => {
    const { store, clock } = setup();
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    clock.advance(10 * 60_000 + 1);
    assert.deepEqual(store.expireLeases(), ['T-0001']);
    const t = store.getTask('T-0001');
    assert.equal(t.status, 'queued');
    assert.equal(t.attempts, 1);
    assert.ok(t.history.some((h) => h.reason === 'lease expired'));
  });

  it('a sleep of the orchestrator machine extends open leases by the slept time (ARCHITECTURE 70)', () => {
    const { store, clock } = setup();
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    clock.advance(5 * 60_000);
    clock.advance(90 * 60_000); // asleep
    assert.deepEqual(store.extendLeases(90 * 60_000), ['T-0001']);
    assert.deepEqual(store.expireLeases(), [], '5 awake minutes of a 10 minute lease');
    clock.advance(5 * 60_000 + 1);
    assert.deepEqual(store.expireLeases(), ['T-0001'], 'awake time still expires it');
  });

  it('a renewed lease does not expire', () => {
    const { store, clock } = setup();
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    clock.advance(9 * 60_000);
    store.progress({ id: 'T-0001', manager: 'm1', phase: 'planning', note: '', tokens: 0 });
    clock.advance(9 * 60_000);
    assert.deepEqual(store.expireLeases(), []);
  });

  it('release gives the task back without spending an attempt', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    const t = store.release({ id: 'T-0001', manager: 'm1', reason: 'host reboot' });
    assert.equal(t.status, 'queued');
    assert.equal(t.attempts, 0);
  });

  it('escalates on the last failed attempt', () => {
    const { store } = setup({ maxAttempts: 3 });
    store.createTask(task('T-0001'));
    for (let i = 1; i <= 2; i += 1) {
      store.lease({ department: 'core', slots: 1, manager: 'm1' });
      const t = store.fail({ id: 'T-0001', manager: 'm1', reason: `boom ${i}` });
      assert.equal(t.status, 'queued', `after attempt ${i}`);
    }
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    const last = store.fail({ id: 'T-0001', manager: 'm1', reason: 'boom 3' });
    assert.equal(last.status, 'escalated');
    assert.equal(last.attempts, 3);
  });
});

describe('store: review, merge, dependencies', () => {
  function toInReview(store, id) {
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    store.progress({ id, manager: 'm1', phase: 'pr', note: '', tokens: 0 });
    store.submit({ id, manager: 'm1', pr: 9, headSha: SHA, evidence });
    return store.startReview(id);
  }

  it('merging a dependency unblocks the waiting task', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.createTask(task('T-0002', { dependsOn: ['T-0001'] }));
    toInReview(store, 'T-0001');
    store.markMerged('T-0001');
    assert.equal(store.getTask('T-0002').status, 'queued');
  });

  it('changes requested loop back and hit needs-human at maxReviewRounds', () => {
    const { store } = setup({ maxReviewRounds: 2 });
    store.createTask(task('T-0001'));
    toInReview(store, 'T-0001');
    assert.equal(store.requestChanges('T-0001', ['fix naming']).status, 'changes_requested');
    store.resumeFix({ id: 'T-0001', manager: 'm1' });
    store.submit({ id: 'T-0001', manager: 'm1', pr: 9, headSha: SHA, evidence });
    store.startReview('T-0001');
    assert.equal(store.requestChanges('T-0001', ['still wrong']).status, 'needs-human');
  });

  it('cannot merge a task that is not in review', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    assert.throws(() => store.markMerged('T-0001'), /forbidden transition: queued -> merged/);
  });

  it('cancel is terminal', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.cancel('T-0001', 'no longer needed');
    assert.throws(() => store.replan('T-0001', 'x'), /forbidden transition: cancelled -> queued/);
  });
});

describe('store: idempotency, events, rollback, persistence', () => {
  it('a repeated idempotency key returns the stored result and leases nothing new', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.createTask(task('T-0002'));
    const first = store.lease({ department: 'core', slots: 1, manager: 'm1', idempotencyKey: 'k1' }).map((t) => t.id);
    const again = store.lease({ department: 'core', slots: 1, manager: 'm1', idempotencyKey: 'k1' }).map((t) => t.id);
    assert.deepEqual(again, first);
    assert.equal(store.getTask('T-0002').status, 'queued');
  });

  it('publishes a change event per transition, after commit', () => {
    const { store } = setup();
    const seen = [];
    store.on('change', (ev) => seen.push(`${ev.taskId}:${ev.from}->${ev.to}`));
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    assert.deepEqual(seen, ['T-0001:queued->leased']);
  });

  it('a throwing listener does not change store behaviour', () => {
    const { store } = setup();
    store.on('change', () => { throw new Error('bus is down'); });
    store.createTask(task('T-0001'));
    assert.equal(store.lease({ department: 'core', slots: 1, manager: 'm1' })[0].status, 'leased');
  });

  it('a failed mutation rolls back completely', () => {
    const { store } = setup();
    store.createTask(task('T-0001', { acceptance: ['works', 'tested'] }));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    store.progress({ id: 'T-0001', manager: 'm1', phase: 'checks', note: '', tokens: 0 });
    const before = store.getTask('T-0001');
    assert.throws(() => store.submit({ id: 'T-0001', manager: 'm1', pr: 1, headSha: SHA, evidence }));
    assert.deepEqual(store.getTask('T-0001'), before);
  });

  it('persists across reopen, migrates to version 1, and backs up with VACUUM INTO', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-store-'));
    const file = path.join(dir, 'swarm.db');
    const clock = fakeClock();
    const a = openStore({ path: file, clock });
    a.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    a.createTask(task('T-0001'));
    a.close();

    const b = openStore({ path: file, clock });
    assert.equal(b.getTask('T-0001').status, 'queued');
    const copy = path.join(dir, 'backup.db');
    b.backup(copy);
    b.close();

    const check = new DatabaseSync(copy);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 5);
    assert.equal(check.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 1);
    check.close();
  });

  it('refuses a database written by a newer schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-store-'));
    const file = path.join(dir, 'swarm.db');
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    assert.throws(() => openStore({ path: file, clock: fakeClock() }), /newer than this code/);
  });

  it('upserts and lists manager heartbeats', () => {
    const { store } = setup();
    const beat = { name: 'a-core', member: 'a', at: 1000, agent: 'claude', version: '1', freeSlots: 2, running: ['T-0001'] };
    store.recordHeartbeat(beat);
    store.recordHeartbeat({ ...beat, name: 'b-core', member: 'b' });
    store.recordHeartbeat({ ...beat, at: 5000, freeSlots: 0, running: [] });
    const list = store.listHeartbeats();
    assert.deepEqual([...list.keys()], ['a-core', 'b-core']);
    assert.deepEqual(list.get('a-core'), { member: 'a', at: 5000, agent: 'claude', version: '1', freeSlots: 0, running: [] });
    assert.deepEqual(list.get('b-core').running, ['T-0001']);
    store.close();
  });

  it('keeps heartbeats, with their original time, across close and reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-store-'));
    const file = path.join(dir, 'swarm.db');
    const clock = fakeClock();
    const a = openStore({ path: file, clock });
    a.recordHeartbeat({ name: 'a-core', member: 'a', at: clock.now(), agent: 'codex', version: '2', freeSlots: 1, running: ['T-0002'] });
    a.close();
    clock.advance(3_600_000);
    const b = openStore({ path: file, clock });
    assert.deepEqual(b.listHeartbeats().get('a-core'), { member: 'a', at: Date.parse('2026-11-01T18:00:00.000Z'), agent: 'codex', version: '2', freeSlots: 1, running: ['T-0002'] });
    b.close();
  });

  it('upgrades a database created by schema version 1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-store-'));
    const file = path.join(dir, 'swarm.db');
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE epics (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL REFERENCES epics(id), department TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX tasks_queue ON tasks (department, status);
      CREATE TABLE idempotency (key TEXT PRIMARY KEY, result TEXT NOT NULL);
      PRAGMA user_version = 1;
    `);
    raw.close();
    const store = openStore({ path: file, clock: fakeClock() });
    assert.equal(store.listHeartbeats().size, 0);
    store.recordHeartbeat({ name: 'a-core', member: 'a', at: 1, agent: 'claude', version: '1', freeSlots: 0, running: [] });
    assert.equal(store.listHeartbeats().size, 1);
    store.close();
    const check = new DatabaseSync(file);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 5);
    check.close();
  });

  it('migrates v2 to v3: backfills the source issue and keeps one epic per issue', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-store-'));
    const file = path.join(dir, 'swarm.db');
    const raw = new DatabaseSync(file);
    const epic = (id, issue) => JSON.stringify({ id, repo: 'o/r', title: 't', body: '', status: 'open', source: 'human', issue, createdAt: '2026-11-01T18:00:00.000Z', updatedAt: '2026-11-01T18:00:00.000Z' });
    raw.exec(`
      CREATE TABLE epics (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL REFERENCES epics(id), department TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX tasks_queue ON tasks (department, status);
      CREATE TABLE idempotency (key TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE manager_heartbeats (name TEXT PRIMARY KEY, member TEXT NOT NULL, at INTEGER NOT NULL, agent TEXT NOT NULL, version TEXT NOT NULL, free_slots INTEGER NOT NULL, running TEXT NOT NULL);
      PRAGMA user_version = 2;
    `);
    const ins = raw.prepare('INSERT INTO epics (id, created_at, data) VALUES (?, ?, ?)');
    ins.run('E-0001', '2026-11-01T18:00:00.000Z', epic('E-0001', 7));
    ins.run('E-0002', '2026-11-01T18:00:00.000Z', epic('E-0002', 7));
    ins.run('E-0003', '2026-11-01T18:00:00.000Z', epic('E-0003', null));
    raw.close();
    const store = openStore({ path: file, clock: fakeClock() });
    assert.equal(store.findEpicByIssue('o/r', 7).id, 'E-0001');
    assert.equal(store.findEpicByIssue('o/r', 8), null);
    assert.throws(() => store.createEpic({ id: 'E-0004', repo: 'o/r', title: 't', body: '', issue: 7 }), /already exists/);
    store.createEpic({ id: 'E-0004', repo: 'o/r', title: 't', body: '', issue: 8 });
    store.createEpic({ id: 'E-0005', repo: 'other/r', title: 't', body: '', issue: 8 });
    store.close();
    const check = new DatabaseSync(file);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 5);
    check.close();
  });
});

function agentAssignment(extra = {}) {
  return {
    id: 'agent-T-0001-implementer-a1b2c3d4',
    kind: 'subagent',
    parentId: 'manager-core',
    manager: 'm1',
    taskId: 'T-0001',
    role: 'implementer',
    status: 'running',
    ...extra,
  };
}

function agentSession(extra = {}) {
  return {
    id: 'run-T-0001-1-a1b2c3d4',
    assignmentId: 'agent-T-0001-implementer-a1b2c3d4',
    agentKind: 'codex',
    model: 'gpt-5.6-luna',
    status: 'running',
    phase: 'implement',
    inputTokens: 0,
    outputTokens: 0,
    lastEventSeq: 0,
    ...extra,
  };
}

function agentEvent(managerSeq, extra = {}) {
  return {
    managerSeq,
    sessionId: 'run-T-0001-1-a1b2c3d4',
    assignmentId: 'agent-T-0001-implementer-a1b2c3d4',
    parentId: 'manager-core',
    manager: 'm1',
    taskId: 'T-0001',
    at: new Date(Date.parse('2026-11-01T18:00:00.000Z') + managerSeq).toISOString(),
    type: 'status',
    phase: 'implement',
    summary: `event ${managerSeq}`,
    data: {},
    ...extra,
  };
}

describe('store: durable agent cockpit state', () => {
  it('persists assignments, sessions and one ordered feed across reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-agents-'));
    const file = path.join(dir, 'swarm.db');
    const clock = fakeClock();
    const a = openStore({ path: file, clock });
    a.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    a.createTask(task('T-0001'));
    a.upsertAgentAssignment(agentAssignment());
    a.startAgentSession(agentSession());
    assert.deepEqual(a.appendAgentEvents('run-T-0001-1-a1b2c3d4', [agentEvent(1)]).accepted, [1]);
    const directive = a.createAgentDirective({
      idempotencyKey: 'browser-a1b2c3d4', target: 'agent-T-0001-implementer-a1b2c3d4',
      taskId: 'T-0001', kind: 'prompt', payload: { text: 'Check retries.' }, actor: 'owner', reason: 'Clarify work',
    });
    const message = a.appendAgentMessage({ target: 'orchestrator', actor: 'owner', role: 'user', text: 'Status?' });
    a.createOperatorTurn({ target: 'orchestrator', messageId: message.id });
    const firstFeed = a.agentFeed({ after: 0, limit: 50 });
    assert.deepEqual(firstFeed.items.map((item) => item.seq), firstFeed.items.map((_, index) => index + 1));
    assert.deepEqual(firstFeed.items.map((item) => item.kind), ['assignment', 'session', 'agent-event', 'directive', 'message', 'operator-turn']);
    assert.equal(directive.status, 'queued');
    a.close();

    const b = openStore({ path: file, clock });
    assert.equal(b.getAgentAssignment('agent-T-0001-implementer-a1b2c3d4').status, 'running');
    assert.equal(b.getAgentSession('run-T-0001-1-a1b2c3d4').assignmentId, 'agent-T-0001-implementer-a1b2c3d4');
    assert.equal(b.agentEvents('agent-T-0001-implementer-a1b2c3d4').length, 1);
    assert.equal(b.agentFeed({ after: firstFeed.lastSeq - 1 }).items[0].seq, firstFeed.lastSeq);
    b.close();

    const raw = new DatabaseSync(file);
    assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 5);
    raw.close();
  });

  it('deduplicates manager events and enforces one feed row per accepted event', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.upsertAgentAssignment(agentAssignment());
    store.startAgentSession(agentSession());
    const first = store.appendAgentEvents('run-T-0001-1-a1b2c3d4', [agentEvent(1), agentEvent(2)]);
    const again = store.appendAgentEvents('run-T-0001-1-a1b2c3d4', [agentEvent(2), agentEvent(3)]);
    assert.deepEqual(first.accepted, [1, 2]);
    assert.deepEqual(again.accepted, [3]);
    assert.deepEqual(store.agentEvents(agentAssignment().id).map((event) => event.managerSeq), [1, 2, 3]);
    assert.equal(store.agentFeed({ after: 0 }).items.filter((item) => item.kind === 'agent-event').length, 3);
  });

  it('redelivers delivered directives and applies each directive once', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.upsertAgentAssignment(agentAssignment());
    store.startAgentSession(agentSession());
    const input = {
      idempotencyKey: 'browser-a1b2c3d4', target: agentAssignment().id, taskId: 'T-0001',
      kind: 'prompt', payload: { text: 'Check retries.' }, actor: 'owner', reason: 'Clarify work',
    };
    const first = store.createAgentDirective(input);
    assert.equal(store.createAgentDirective(input).id, first.id);
    assert.deepEqual(store.managerDirectives('m1').map((item) => item.status), ['queued']);
    assert.equal(store.ackAgentDirective(first.id, { manager: 'm1', status: 'delivered' }).status, 'delivered');
    assert.deepEqual(store.managerDirectives('m1').map((item) => item.status), ['delivered']);
    const applied = store.ackAgentDirective(first.id, {
      manager: 'm1', status: 'applied', result: 'continued', replacementSessionId: 'run-T-0001-2-b1c2d3e4',
    });
    assert.equal(applied.status, 'applied');
    assert.equal(store.ackAgentDirective(first.id, {
      manager: 'm1', status: 'applied', result: 'continued', replacementSessionId: 'run-T-0001-2-b1c2d3e4',
    }).status, 'applied');
    assert.deepEqual(store.managerDirectives('m1'), []);
    assert.throws(() => store.ackAgentDirective(first.id, { manager: 'm1', status: 'failed', result: 'late' }), /already applied/);
  });

  it('cancels queued directives when their task becomes terminal', () => {
    const { store } = setup();
    store.createTask(task('T-0001'));
    store.upsertAgentAssignment(agentAssignment());
    const directive = store.createAgentDirective({
      idempotencyKey: 'browser-a1b2c3d4', target: agentAssignment().id, taskId: 'T-0001',
      kind: 'prompt', payload: { text: 'Check retries.' }, actor: 'owner', reason: 'Clarify work',
    });
    store.cancel('T-0001', 'owner cancelled');
    assert.equal(store.getAgentDirective(directive.id).status, 'cancelled');
    assert.match(store.getAgentDirective(directive.id).result, /terminal/);
  });

  it('requeues one running operator turn after restart and keeps conversation order', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-turns-'));
    const file = path.join(dir, 'swarm.db');
    const clock = fakeClock();
    const a = openStore({ path: file, clock });
    const m1 = a.appendAgentMessage({ target: 'orchestrator', actor: 'owner', role: 'user', text: 'First' });
    const m2 = a.appendAgentMessage({ target: 'orchestrator', actor: 'owner', role: 'user', text: 'Second' });
    a.createOperatorTurn({ target: 'orchestrator', messageId: m1.id });
    a.createOperatorTurn({ target: 'orchestrator', messageId: m2.id });
    const claimed = a.claimNextOperatorTurn();
    assert.equal(claimed.messageId, m1.id);
    assert.equal(claimed.status, 'running');
    a.close();

    const b = openStore({ path: file, clock });
    const retried = b.claimNextOperatorTurn();
    assert.equal(retried.id, claimed.id);
    assert.equal(retried.attempts, 2);
    b.finishOperatorTurn(retried.id, { status: 'failed', error: 'second process failure' });
    assert.equal(b.claimNextOperatorTurn().messageId, m2.id);
    b.close();
  });

  it('persists only allow-listed operator actions and resolves them idempotently', () => {
    const { store } = setup();
    const message = store.appendAgentMessage({ target: 'orchestrator', actor: 'owner', role: 'user', text: 'Create an epic' });
    const turn = store.createOperatorTurn({ target: 'orchestrator', messageId: message.id });
    assert.throws(
      () => store.createOperatorActions(turn.id, [{ kind: 'call_arbitrary_url', payload: { url: 'https://example.com' } }]),
      /unknown operator action/,
    );
    const [action] = store.createOperatorActions(turn.id, [{ kind: 'create_epic', payload: { title: 'Safe', body: 'Bounded' } }]);
    assert.equal(action.status, 'pending');
    const confirmed = store.resolveOperatorAction(action.id, {
      status: 'confirmed', actor: 'owner', reason: 'Approved', idempotencyKey: 'confirm-a1b2c3d4',
    });
    assert.equal(confirmed.status, 'confirmed');
    assert.deepEqual(store.resolveOperatorAction(action.id, {
      status: 'confirmed', actor: 'owner', reason: 'Approved', idempotencyKey: 'confirm-a1b2c3d4',
    }), confirmed);
  });

  it('prunes agent events oldest-first by age, session and total limits', () => {
    const { store, clock } = setup({ agentRetention: { maxAgeMs: 1000, maxTotal: 3, maxPerSession: 2 } });
    store.createTask(task('T-0001'));
    store.upsertAgentAssignment(agentAssignment());
    store.startAgentSession(agentSession());
    store.appendAgentEvents(agentSession().id, [agentEvent(1), agentEvent(2), agentEvent(3)]);
    assert.deepEqual(store.agentEvents(agentAssignment().id).map((event) => event.managerSeq), [2, 3]);

    const otherAssignment = agentAssignment({ id: 'agent-T-0001-checker-b1c2d3e4', role: 'checker' });
    const otherSession = agentSession({ id: 'run-T-0001-2-b1c2d3e4', assignmentId: otherAssignment.id });
    store.upsertAgentAssignment(otherAssignment);
    store.startAgentSession(otherSession);
    store.appendAgentEvents(otherSession.id, [
      agentEvent(1, { sessionId: otherSession.id, assignmentId: otherAssignment.id }),
      agentEvent(2, { sessionId: otherSession.id, assignmentId: otherAssignment.id }),
    ]);
    assert.equal(store.agentEvents(agentAssignment().id).length + store.agentEvents(otherAssignment.id).length, 3);
    clock.advance(1004);
    store.pruneAgentData();
    assert.equal(store.agentEvents(agentAssignment().id).length + store.agentEvents(otherAssignment.id).length, 0);
  });
});
