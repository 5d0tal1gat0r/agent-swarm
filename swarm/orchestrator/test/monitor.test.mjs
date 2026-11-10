import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore } from '../src/store.mjs';
import { THRESHOLDS, createExecutor, evaluate, snapshotFrom } from '../src/monitor.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-01T12:00:00Z');
const task = (patch = {}) => ({
  id: 'T-0001', department: 'core', status: 'in_progress', attempts: 0, usedTokens: 0,
  budget: { tokens: 1000, minutes: 30 }, lastProgressAt: new Date(NOW - 1 * MIN).toISOString(),
  updatedAt: new Date(NOW - 1 * MIN).toISOString(), ...patch,
});
const snap = (patch = {}) => ({ now: NOW, maxAttempts: 3, tasks: [], managers: [], unownedPaths: [], main: null, departments: {}, ...patch });
const ofType = (actions, type) => actions.filter((a) => a.type === type);

describe('monitor rules', () => {
  it('a healthy snapshot raises nothing', () => {
    assert.deepEqual(evaluate(snap({ tasks: [task()], managers: [{ name: 'me-core', at: NOW - MIN }] })), []);
  });

  it('manager_down after two minutes without a heartbeat', () => {
    const a = evaluate(snap({ managers: [{ name: 'me-core', at: NOW - (THRESHOLDS.managerDownMs + MIN) }] }));
    assert.equal(a.length, 1);
    assert.equal(a[0].type, 'alert.manager_down');
    assert.equal(a[0].severity, 'critical');
    assert.equal(evaluate(snap({ managers: [{ name: 'me-core', at: NOW - MIN }] })).length, 0, 'one minute silent is fine');
  });

  it('stalled: warn after 15 min of no progress, critical after 25', () => {
    const warn = ofType(evaluate(snap({ tasks: [task({ lastProgressAt: new Date(NOW - 16 * MIN).toISOString() })] })), 'alert.stalled');
    assert.deepEqual(warn.map((a) => a.severity), ['warn']);
    const crit = ofType(evaluate(snap({ tasks: [task({ lastProgressAt: new Date(NOW - 26 * MIN).toISOString() })] })), 'alert.stalled');
    assert.deepEqual(crit.map((a) => a.severity), ['critical']);
    assert.equal(ofType(evaluate(snap({ tasks: [task({ status: 'queued', lastProgressAt: new Date(NOW - 60 * MIN).toISOString() })] })), 'alert.stalled').length, 0, 'only in_progress stalls');
  });

  it('budget: warn at 80%, stop action at 100%', () => {
    const warn = ofType(evaluate(snap({ tasks: [task({ usedTokens: 800 })] })), 'alert.budget');
    assert.equal(warn.length, 1);
    assert.equal(warn[0].severity, 'warn');
    const stop = ofType(evaluate(snap({ tasks: [task({ usedTokens: 1000 })] })), 'stop.budget');
    assert.equal(stop.length, 1);
    assert.equal(stop[0].taskId, 'T-0001');
  });

  describe('minutes budget', () => {
    const leased = (minAgo, extra = []) => ({ history: [
      { from: null, to: 'queued', at: new Date(NOW - 100 * MIN).toISOString(), reason: 'created' },
      { from: 'queued', to: 'leased', at: new Date(NOW - minAgo * MIN).toISOString(), reason: 'leased by m' },
      ...extra,
    ] });
    it('warn at 25 of 30 min', () => {
      const a = evaluate(snap({ tasks: [task(leased(25))] }));
      assert.equal(ofType(a, 'alert.budget_minutes').length, 1);
      assert.equal(ofType(a, 'alert.budget_minutes')[0].severity, 'warn');
      assert.equal(ofType(a, 'stop.budget_minutes').length, 0);
    });
    it('stop at 31 of 30 min', () => {
      const a = evaluate(snap({ tasks: [task(leased(31))] }));
      assert.equal(ofType(a, 'stop.budget_minutes').length, 1);
      assert.equal(ofType(a, 'stop.budget_minutes')[0].taskId, 'T-0001');
      assert.equal(ofType(a, 'alert.budget_minutes').length, 0);
    });
    it('nothing under 80%', () => {
      assert.equal(evaluate(snap({ tasks: [task(leased(10))] })).filter((a) => a.type.endsWith('budget_minutes')).length, 0);
    });
    it('queued task never triggers', () => {
      const a = evaluate(snap({ tasks: [task({ ...leased(90), status: 'queued' })] }));
      assert.equal(a.filter((x) => x.type.endsWith('budget_minutes')).length, 0);
    });
    it('measures from the latest lease after a requeue', () => {
      const t = task(leased(90, [
        { from: 'leased', to: 'queued', at: new Date(NOW - 50 * MIN).toISOString(), reason: 'retry' },
        { from: 'queued', to: 'leased', at: new Date(NOW - 5 * MIN).toISOString(), reason: 'leased by m' },
      ]));
      assert.equal(evaluate(snap({ tasks: [t] })).filter((x) => x.type.endsWith('budget_minutes')).length, 0);
    });
    it('time asleep does not count: 10 awake minutes plus a 90 minute sleep is not over 30 (ARCHITECTURE 70)', () => {
      const sleeps = [{ from: NOW - 95 * MIN, to: NOW - 5 * MIN }];
      const t = task({ ...leased(100), lastProgressAt: new Date(NOW - 96 * MIN).toISOString() });
      const a = evaluate(snap({ tasks: [t], sleeps, managers: [{ name: 'me-core', at: NOW - 95 * MIN }] }));
      assert.equal(a.filter((x) => x.type.endsWith('budget_minutes')).length, 0);
      assert.equal(ofType(a, 'alert.stalled').length, 0, 'no stall for the sleep either');
      assert.equal(ofType(a, 'alert.manager_down').length, 1, 'six awake minutes without a heartbeat is still down');
      const later = evaluate(snap({ now: NOW + 21 * MIN, tasks: [t], sleeps }));
      assert.equal(ofType(later, 'stop.budget_minutes').length, 1, '31 awake minutes stop it');
    });
    it('no history: no action', () => {
      assert.equal(evaluate(snap({ tasks: [task()] })).filter((x) => x.type.endsWith('budget_minutes')).length, 0);
    });
    it('executor cancels on stop.budget_minutes and dedupes the warn', () => {
      const store = openStore({ clock: { now: () => NOW }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
      store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'E', body: 'b' });
      store.createTask({
        id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'T', department: 'core', priority: 'p1', size: 'S',
        paths: ['swarm/x/**'], dependsOn: [], acceptance: ['a'], budget: { tokens: 1000, minutes: 30 },
      });
      store.lease({ department: 'core', slots: 1, manager: 'me-core' });
      const out = [];
      const ex = createExecutor({ store, emit: (a) => out.push(a), log: { error() {} } });
      const warn = { type: 'alert.budget_minutes', severity: 'warn', subject: 'task:T-0001', taskId: 'T-0001', detail: 'x' };
      ex.apply([warn], NOW); ex.apply([warn], NOW + MIN);
      assert.equal(out.length, 1);
      ex.apply([{ type: 'stop.budget_minutes', severity: 'critical', subject: 'task:T-0001', taskId: 'T-0001', detail: 'x' }], NOW);
      assert.equal(store.getTask('T-0001').status, 'cancelled');
      assert.equal(out.length, 2);
    });
  });

  it('attempts: warn when one attempt is left', () => {
    const a = ofType(evaluate(snap({ tasks: [task({ attempts: 2 })] })), 'alert.attempts');
    assert.equal(a.length, 1);
    assert.equal(ofType(evaluate(snap({ tasks: [task({ attempts: 1 })] })), 'alert.attempts').length, 0);
  });

  it('a terminal task raises nothing', () => {
    const a = evaluate(snap({ tasks: [task({ status: 'merged', lastProgressAt: new Date(NOW - 60 * MIN).toISOString(), usedTokens: 2000 })] }));
    assert.deepEqual(a, []);
  });

  it('unowned path raises one alert per path', () => {
    const a = ofType(evaluate(snap({ unownedPaths: ['tools/x.sh', 'misc.txt'] })), 'alert.unowned_path');
    assert.deepEqual(a.map((x) => x.subject), ['path:tools/x.sh', 'path:misc.txt']);
  });

  it('main_red raises a critical alert with the sha', () => {
    const a = ofType(evaluate(snap({ main: { sha: 'abcdef1234', status: 'red' } })), 'alert.main_red');
    assert.equal(a.length, 1);
    assert.match(a[0].detail, /abcdef1/);
    assert.equal(ofType(evaluate(snap({ main: { sha: 'x', status: 'green' } })), 'alert.main_red').length, 0);
  });

  it('queue depth above the threshold raises one alert per department', () => {
    const many = Array.from({ length: THRESHOLDS.queueDepth + 1 }, (_, i) => task({ id: `T-${String(i + 1).padStart(4, '0')}`, status: 'queued' }));
    const a = ofType(evaluate(snap({ tasks: many })), 'alert.queue_depth');
    assert.equal(a.length, 1);
    assert.equal(a[0].subject, 'dept:core');
  });
});

describe('executor', () => {
  it('emits an alert once, then stays quiet until the cooldown passes', () => {
    const emitted = [];
    const ex = createExecutor({ store: null, emit: (a) => emitted.push(a), cooldownMs: 10 * MIN });
    const stalled = { type: 'alert.stalled', severity: 'warn', subject: 'task:T-1', detail: 'x' };
    ex.apply([stalled], NOW);
    ex.apply([stalled], NOW + MIN);
    assert.equal(emitted.length, 1);
    ex.apply([stalled], NOW + 11 * MIN);
    assert.equal(emitted.length, 2, 're-emitted after the cooldown');
  });

  it('a change of severity emits again; clearing the condition re-arms it', () => {
    const emitted = [];
    const ex = createExecutor({ store: null, emit: (a) => emitted.push(a) });
    const warn = { type: 'alert.stalled', severity: 'warn', subject: 'task:T-1', detail: 'x' };
    const crit = { ...warn, severity: 'critical' };
    ex.apply([warn], NOW);
    ex.apply([crit], NOW + MIN);
    assert.equal(emitted.length, 2);
    ex.apply([], NOW + 2 * MIN);
    ex.apply([warn], NOW + 3 * MIN);
    assert.equal(emitted.length, 3, 'cleared, then back: emitted again');
  });

  it('stop.budget cancels the open task in the store and emits the alert', () => {
    const store = openStore({ clock: { now: () => NOW }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'E', body: 'b' });
    store.createTask({
      id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'T', department: 'core', priority: 'p1', size: 'S',
      paths: ['swarm/x/**'], dependsOn: [], acceptance: ['a'], budget: { tokens: 1000, minutes: 30 },
    });
    store.lease({ department: 'core', slots: 1, manager: 'me-core' });
    const emitted = [];
    const ex = createExecutor({ store, emit: (a) => emitted.push(a) });
    ex.apply([{ type: 'stop.budget', severity: 'critical', subject: 'task:T-0001', taskId: 'T-0001', detail: 'token budget spent: 1000 of 1000' }], NOW);
    assert.equal(store.getTask('T-0001').status, 'cancelled');
    assert.equal(emitted.length, 1);
    store.close();
  });

  it('stop.budget on an already terminal task does nothing but does not throw', () => {
    const store = openStore({ clock: { now: () => NOW }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'E', body: 'b' });
    store.createTask({
      id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'T', department: 'core', priority: 'p1', size: 'S',
      paths: ['swarm/x/**'], dependsOn: [], acceptance: ['a'], budget: { tokens: 1000, minutes: 30 },
    });
    store.cancel('T-0001', 'earlier');
    const ex = createExecutor({ store, emit: () => {} });
    assert.doesNotThrow(() => ex.apply([{ type: 'stop.budget', severity: 'critical', subject: 'task:T-0001', taskId: 'T-0001', detail: 'x' }], NOW));
    store.close();
  });
});

describe('snapshot', () => {
  it('reads tasks from the store and managers from the heartbeat map, and drops nothing', () => {
    const store = openStore({ clock: { now: () => NOW }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'E', body: 'b' });
    store.createTask({
      id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'T', department: 'core', priority: 'p1', size: 'S',
      paths: ['swarm/x/**'], dependsOn: [], acceptance: ['a'], budget: { tokens: 1000, minutes: 30 },
    });
    const s = snapshotFrom({ store, heartbeats: new Map([['me-core', { at: NOW - MIN, member: 'me' }]]), now: NOW, maxAttempts: 3, departments: { departments: {} }, repoFiles: ['x.txt'] });
    assert.equal(s.tasks.length, 1);
    assert.deepEqual(s.managers, [{ name: 'me-core', at: NOW - MIN }]);
    assert.deepEqual(s.unownedPaths, ['x.txt']);
    store.close();
  });

  it('snapshotFrom sees persisted managers after a restart, so manager_down can fire', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-monitor-'));
    const file = path.join(dir, 'swarm.db');
    const a = openStore({ path: file });
    a.recordHeartbeat({ name: 'me-core', member: 'me', at: NOW - 60 * MIN, agent: 'claude', version: '1', freeSlots: 1, running: [] });
    a.close();
    const b = openStore({ path: file });
    const s = snapshotFrom({ store: b, heartbeats: b.listHeartbeats(), now: NOW, maxAttempts: 3, departments: { departments: {} } });
    assert.deepEqual(s.managers, [{ name: 'me-core', at: NOW - 60 * MIN }]);
    assert.equal(ofType(evaluate(s), 'alert.manager_down').length, 1);
    b.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
