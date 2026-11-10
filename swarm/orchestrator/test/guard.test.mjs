import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore } from '../src/store.mjs';
import { clearPause, createGuard, isRevertTask, mergesInWindow, openPrsOf, parsePause, setPause } from '../src/guard.mjs';
import { createReviewLoop } from '../src/review-loop.mjs';
import { evaluate, createExecutor } from '../src/monitor.mjs';
import { startDispatcher } from '../src/dispatcher.mjs';
import { Bus } from '../../shared/bus.mjs';

const quiet = { log() {}, warn() {}, error() {}, info() {} };
const SHA = 'a'.repeat(40);
// A bus stub holding comm_state: states Map key -> value; fail makes reads fail.
function stubBus() {
  const bus = { states: new Map(), fail: false, sets: 0,
    async readState(ns, key) { return bus.fail ? { ok: false } : { ok: true, value: bus.states.get(`${ns}/${key}`) ?? null }; },
    async setState(ns, key, value) { bus.sets += 1; bus.states.set(`${ns}/${key}`, value); return 'ok'; } };
  return bus;
}

describe('pause state', () => {
  it('parses: any value pauses, only a paused:false record resumes', () => {
    assert.equal(parsePause(null), null);
    assert.equal(parsePause(JSON.stringify({ paused: false })), null);
    assert.equal(parsePause('stop everything').reason, 'stop everything');
    assert.equal(parsePause(JSON.stringify({ paused: true, reason: 'x', by: 'me' })).by, 'me');
  });

  it('pause and resume write and clear the state (stub bus)', async () => {
    const bus = stubBus();
    const guard = createGuard({ bus, log: quiet });
    await setPause(bus, { reason: 'incident' });
    await guard.refresh();
    assert.equal(guard.isPaused(), true);
    assert.equal(guard.status().reason, 'incident');
    await clearPause(bus);
    await guard.refresh();
    assert.equal(guard.isPaused(), false);
    await assert.rejects(setPause({ setState: async () => null }), /pause not set/);
  });

  it('a failed bus read keeps the last value, in both directions', async () => {
    const bus = stubBus();
    const guard = createGuard({ bus, log: quiet });
    await setPause(bus, { reason: 'r' });
    await guard.refresh();
    bus.fail = true;
    await guard.refresh();
    assert.equal(guard.isPaused(), true, 'blip does not unpause');
    bus.fail = false;
    await clearPause(bus);
    await guard.refresh();
    bus.fail = true;
    await guard.refresh();
    assert.equal(guard.isPaused(), false);
  });

  it('Bus.readState tells a failed read from a missing key', async () => {
    const b = new Bus('http://x', 'n', quiet);
    b.safe = async () => null;
    assert.deepEqual(await b.readState('swarm', 'paused'), { ok: false });
    b.safe = async () => 'not json';
    assert.deepEqual(await b.readState('swarm', 'paused'), { ok: false });
    b.safe = async () => JSON.stringify({ value: null });
    assert.deepEqual(await b.readState('swarm', 'paused'), { ok: true, value: null });
  });
});

describe('paused: dispatcher and monitor', () => {
  it('a dispatch pass sends no dispatch while paused, and nudges again after', async () => {
    const store = openStore({ clock: { now: () => 1 }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    store.createTask({ id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 't', department: 'core', priority: 'p1', size: 'S', paths: ['x'], dependsOn: [], acceptance: ['w'], budget: { tokens: 1, minutes: 1 } });
    const dms = [];
    const bus = { agents: async () => [{ id: 'i', name: 'me-core', status: 'online' }], direct: async (to, t) => dms.push([to, t]), send: async () => {}, inbox: async () => [] };
    const flag = { on: true };
    const d = startDispatcher({ store, heartbeats: new Map([['me-core', { at: 1, freeSlots: 1, running: [] }]]), bus, departments: { departments: { core: {} } },
      readManagerTokens: () => ({ managers: { 'me-core': { departments: ['core'], roles: ['manager'] } } }), log: quiet, listenMs: 3_600_000, dispatchMs: 3_600_000,
      clock: { now: () => 1 }, guard: { isPaused: () => flag.on } });
    await d.pass();
    assert.deepEqual(dms, []);
    flag.on = false;
    await d.pass();
    assert.equal(dms.length, 1);
  });

  it('monitor raises alert.paused while set, deduped, and nothing when not', () => {
    const snap = (paused) => ({ now: 0, maxAttempts: 3, tasks: [], managers: [], unownedPaths: [], main: null, paused, departments: {} });
    const a = evaluate(snap({ reason: 'incident', by: 'me' }));
    assert.deepEqual(a.map((x) => [x.type, x.severity]), [['alert.paused', 'warn']]);
    assert.match(a[0].detail, /incident/);
    assert.deepEqual(evaluate(snap(null)), []);
    const emitted = [];
    const ex = createExecutor({ store: null, emit: (x) => emitted.push(x), log: quiet });
    ex.apply(a, 0);
    ex.apply(a, 60_000);
    assert.equal(emitted.length, 1);
  });
});

describe('review loop merge gate', () => {
  const policy = { limits: { maxChangedLines: { S: 400, M: 1000 }, maxReviewRounds: 3 }, humanReview: [], models: { claude: ['claude-sonnet-5-5'] }, reviewModel: { default: 'claude-sonnet-5-5', large: 'claude-sonnet-5-5' } };
  const APPROVE = JSON.stringify({ verdict: 'approve', summary: 'ok', findings: [] });

  function setup(task = {}) {
    const store = openStore({ clock: { now: () => Date.now() }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    store.createTask({ id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'Thing', department: 'core', priority: 'p1', size: 'S', paths: ['swarm/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 1000, minutes: 30 }, ...task });
    store.lease({ department: task.department ?? 'core', slots: 1, manager: 'me-core' });
    store.progress({ id: 'T-0001', manager: 'me-core', phase: 'checks', note: '', tokens: 1 });
    store.submit({ id: 'T-0001', manager: 'me-core', pr: 9, headSha: SHA, evidence: store.getTask('T-0001').acceptance.map((criterion) => ({ criterion, met: true, detail: 'ok' })) });
    const gh = { armed: 0,
      async pr() { return { number: 9, baseRefName: 'main', headSha: SHA, state: 'OPEN', additions: 1, deletions: 0, autoMergeEnabled: gh.armed > 0 }; },
      async fileChanges() { return [{ filename: 'swarm/a.mjs', status: 'modified' }]; },
      async checks(sha) { return [{ name: 'check', headSha: sha, conclusion: 'success' }]; },
      async behindBy() { return 0; }, async diff() { return '+ok\n'; },
      async enableAutoMerge() { gh.armed += 1; } };
    return { store, gh };
  }
  const loop = ({ store, gh }, guard) => createReviewLoop({ store, gh, callModel: async () => APPROVE, policy, departments: { contracts: [] }, promptText: 'R', guard, log: quiet });

  it('paused: nothing is armed, the task stays submitted, and merges after resume', async () => {
    const ctx = setup();
    const bus = stubBus();
    const guard = createGuard({ bus, log: quiet });
    await setPause(bus, { reason: 'x' });
    await guard.refresh();
    const l = loop(ctx, guard);
    await l.tick();
    assert.equal(ctx.gh.armed, 0);
    assert.equal(ctx.store.getTask('T-0001').status, 'submitted');
    await clearPause(bus);
    await guard.refresh();
    await l.tick();
    assert.equal(ctx.gh.armed, 1);
    assert.equal(ctx.store.getTask('T-0001').status, 'in_review');
  });

  it('main red: a normal task waits, the p0 revert merges', async () => {
    const red = createGuard({ log: quiet });
    red.setMain({ sha: SHA, status: 'red' });
    const normal = setup();
    await loop(normal, red).tick();
    assert.equal(normal.gh.armed, 0);
    assert.equal(normal.store.getTask('T-0001').status, 'submitted');

    const revert = setup({ department: 'platform', priority: 'p0', size: 'M', acceptance: [`revert ${SHA}`] });
    await loop(revert, red).tick();
    assert.equal(revert.gh.armed, 1);
    red.setMain({ sha: SHA, status: 'green' });
    await loop(normal, red).tick();
    assert.equal(normal.gh.armed, 1, 'merges once main is green');
  });

  it('only a monitor-shaped p0 platform revert counts as a revert', () => {
    assert.equal(isRevertTask({ priority: 'p0', department: 'platform', acceptance: [`revert ${SHA}`] }), true);
    assert.equal(isRevertTask({ priority: 'p1', department: 'platform', acceptance: [`revert ${SHA}`] }), false);
    assert.equal(isRevertTask({ priority: 'p0', department: 'core', acceptance: [`revert ${SHA}`] }), false);
    assert.equal(isRevertTask({ priority: 'p0', department: 'platform', acceptance: ['fix it'] }), false);
  });

  it('rate limit: the 7th merge in an hour waits as submitted, and proceeds after the window', async () => {
    const t0 = Date.parse('2026-11-02T10:00:00.000Z');
    const ck = { t: t0, now: () => ck.t };
    const store = openStore({ clock: ck, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    const ids = [];
    for (let i = 1; i <= 7; i += 1) {
      const id = `T-000${i}`;
      ids.push(id);
      store.createTask({ id, epicId: 'E-0001', repo: 'o/r', title: 'Thing', department: 'core', priority: 'p1', size: 'S', paths: ['swarm/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 1000, minutes: 30 } });
      store.lease({ department: 'core', slots: 1, manager: 'me-core' });
      store.progress({ id, manager: 'me-core', phase: 'checks', note: '', tokens: 1 });
      store.submit({ id, manager: 'me-core', pr: i, headSha: SHA, evidence: [{ criterion: 'works', met: true, detail: 'ok' }] });
    }
    const gh = { armed: [],
      async pr(n) { return { number: n, baseRefName: 'main', headSha: SHA, state: 'OPEN', additions: 1, deletions: 0, autoMergeEnabled: true }; },
      async fileChanges() { return [{ filename: 'swarm/a.mjs', status: 'modified' }]; },
      async checks(sha) { return [{ name: 'check', headSha: sha, conclusion: 'success' }]; },
      async behindBy() { return 0; }, async diff() { return '+ok\n'; },
      async enableAutoMerge(n) { gh.armed.push(n); } };
    const guard = createGuard({ store, policy: { limits: { maxMergesPerHour: 6 } }, clock: ck, log: quiet });
    const l = createReviewLoop({ store, gh, callModel: async () => APPROVE, policy, departments: { contracts: [] }, promptText: 'R', guard, log: quiet });
    await l.tick();
    assert.equal(gh.armed.length, 6);
    assert.equal(store.getTask('T-0007').status, 'submitted', 'waits, not dropped');
    assert.equal(guard.mergeBlock(store.getTask('T-0007')), 'rate_limit');
    ck.t = t0 + 59 * 60_000;
    await l.tick();
    assert.equal(gh.armed.length, 6, 'still inside the hour');
    ck.t = t0 + 61 * 60_000;
    await l.tick();
    assert.deepEqual(gh.armed.slice(6), [7]);
    assert.equal(store.getTask('T-0007').status, 'in_review');
  });

  it('rate limit: counts armed and merged tasks inside the window, once each; the revert is exempt', () => {
    const at = (m) => new Date(Date.parse('2026-11-02T10:00:00.000Z') + m * 60_000).toISOString();
    const now = Date.parse(at(70));
    const t = (status, history) => ({ status, history });
    const tasks = [
      t('in_review', [{ to: 'in_review', at: at(20) }]),
      t('merged', [{ to: 'in_review', at: at(5) }, { to: 'merged', at: at(30) }]), // armed 65 min ago: outside
      t('merged', [{ to: 'in_review', at: at(15) }, { to: 'changes_requested', at: at(16) }, { to: 'in_review', at: at(40) }, { to: 'merged', at: at(50) }]),
      t('changes_requested', [{ to: 'in_review', at: at(60) }]), // failed review: not a merge
      t('merged', [{ to: 'merged', at: at(65) }]),
    ];
    assert.equal(mergesInWindow(tasks, now), 3);
    const store = { listTasks: () => tasks };
    const guard = createGuard({ store, policy: { limits: { maxMergesPerHour: 3 } }, clock: { now: () => now }, log: quiet });
    assert.equal(guard.mergeBlock({ priority: 'p1' }), 'rate_limit');
    assert.equal(guard.mergeBlock({ priority: 'p0', department: 'platform', acceptance: [`revert ${SHA}`] }), null);
  });

  it('openPrsOf counts only this manager\'s tasks that hold a PR', () => {
    const tasks = [
      { holder: 'a', pr: 1, status: 'submitted' }, { holder: 'a', pr: 2, status: 'changes_requested' },
      { holder: 'a', pr: 3, status: 'merged' }, { holder: 'a', pr: null, status: 'in_progress' }, { holder: 'b', pr: 4, status: 'in_review' },
    ];
    assert.equal(openPrsOf(tasks, 'a'), 2);
    assert.equal(openPrsOf(tasks, 'b'), 1);
  });
});
