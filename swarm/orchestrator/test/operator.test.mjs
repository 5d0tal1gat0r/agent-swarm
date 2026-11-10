import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore } from '../src/store.mjs';
import { applyAndAnnounce, applyOperatorAction } from '../src/operator.mjs';

function store(maxAttempts = 3) {
  const s = openStore({ clock: { now: () => Date.now() }, leaseMinutes: 10, maxAttempts, maxReviewRounds: 1 });
  s.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
  s.createTask({
    id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'T', department: 'core', priority: 'p1', size: 'S',
    paths: ['swarm/x/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 },
  });
  return s;
}

describe('operator actions', () => {
  it('resolve moves needs-human to queued, resets attempts, and records the reason', () => {
    const s = store();
    s.lease({ department: 'core', slots: 1, manager: 'me-core' });
    s.progress({ id: 'T-0001', manager: 'me-core', phase: 'pr', note: '', tokens: 0 });
    s.submit({ id: 'T-0001', manager: 'me-core', pr: 1, headSha: 'a'.repeat(40), evidence: [{ criterion: 'works', met: true, detail: '' }] });
    s.startReview('T-0001');
    s.needsHuman('T-0001', 'human review required: .github/x.yml');
    const t = applyOperatorAction(s, { action: 'resolve', id: 'T-0001', reason: 'owner reviewed CI change' });
    assert.equal(t.status, 'queued');
    assert.equal(t.attempts, 0);
    assert.match(t.history.at(-1).reason, /resolved: owner reviewed CI change/);
  });

  it('replan moves escalated to queued', () => {
    const s = store(1);
    s.lease({ department: 'core', slots: 1, manager: 'me-core' });
    s.progress({ id: 'T-0001', manager: 'me-core', phase: 'checks', note: '', tokens: 0 });
    s.fail({ id: 'T-0001', manager: 'me-core', reason: 'checks failed' });
    assert.equal(s.getTask('T-0001').status, 'escalated');
    const t = applyOperatorAction(s, { action: 'replan', id: 'T-0001', reason: 'split the task' });
    assert.equal(t.status, 'queued');
  });

  it('cancel works from queued and ends the task', () => {
    const s = store();
    const t = applyOperatorAction(s, { action: 'cancel', id: 'T-0001', reason: 'superseded by T-0002' });
    assert.equal(t.status, 'cancelled');
  });

  it('a wrong move throws and leaves the task unchanged', () => {
    const s = store();
    assert.throws(() => applyOperatorAction(s, { action: 'resolve', id: 'T-0001', reason: 'nope nope' }), /forbidden transition: queued -> queued|forbidden transition/);
    assert.equal(s.getTask('T-0001').status, 'queued');
    assert.equal(s.getTask('T-0001').attempts, 0);
  });

  it('refuses a missing or too-short reason and an unknown action', () => {
    const s = store();
    assert.throws(() => applyOperatorAction(s, { action: 'cancel', id: 'T-0001', reason: '' }), /reason of at least 3/);
    assert.throws(() => applyOperatorAction(s, { action: 'cancel', id: 'T-0001', reason: 'ok' }), /reason of at least 3/);
    assert.throws(() => applyOperatorAction(s, { action: 'delete', id: 'T-0001', reason: 'reason here' }), /unknown action/);
  });
});

describe('operator announcements', () => {
  const fakeBus = () => {
    const sent = [];
    return { sent, send: async (channel, text) => { sent.push([channel, text]); } };
  };
  const quiet = () => {
    const warnings = [];
    return { warnings, warn: (m) => warnings.push(m) };
  };
  function needsHuman() {
    const s = store();
    s.lease({ department: 'core', slots: 1, manager: 'me-core' });
    s.progress({ id: 'T-0001', manager: 'me-core', phase: 'pr', note: '', tokens: 0 });
    s.submit({ id: 'T-0001', manager: 'me-core', pr: 1, headSha: 'a'.repeat(40), evidence: [{ criterion: 'works', met: true, detail: '' }] });
    s.startReview('T-0001');
    s.needsHuman('T-0001', 'human review required');
    return s;
  }

  it('resolve is announced on swarm and dept-core with the reason', async () => {
    const s = needsHuman();
    const bus = fakeBus();
    await applyAndAnnounce(s, bus, { action: 'resolve', id: 'T-0001', reason: 'owner reviewed' });
    assert.deepEqual(bus.sent, [
      ['swarm', 'operator resolve: task.queued T-0001 (core): needs-human -> queued - resolved: owner reviewed'],
      ['dept-core', 'operator resolve: task.queued T-0001 (core): needs-human -> queued - resolved: owner reviewed'],
    ]);
  });

  it('replan is announced on both channels', async () => {
    const s = store(1);
    s.lease({ department: 'core', slots: 1, manager: 'me-core' });
    s.progress({ id: 'T-0001', manager: 'me-core', phase: 'checks', note: '', tokens: 0 });
    s.fail({ id: 'T-0001', manager: 'me-core', reason: 'checks failed' });
    const bus = fakeBus();
    await applyAndAnnounce(s, bus, { action: 'replan', id: 'T-0001', reason: 'split the task' });
    assert.deepEqual(bus.sent.map(([c]) => c), ['swarm', 'dept-core']);
    assert.equal(bus.sent[0][1], 'operator replan: task.queued T-0001 (core): escalated -> queued - replanned: split the task');
  });

  it('cancel is announced as task.cancelled', async () => {
    const s = store();
    const bus = fakeBus();
    await applyAndAnnounce(s, bus, { action: 'cancel', id: 'T-0001', reason: 'not needed' });
    assert.deepEqual(bus.sent, [
      ['swarm', 'operator cancel: task.cancelled T-0001 (core): queued -> cancelled - not needed'],
      ['dept-core', 'operator cancel: task.cancelled T-0001 (core): queued -> cancelled - not needed'],
    ]);
  });

  it('a failing bus warns and still returns the changed task', async () => {
    const s = store();
    const log = quiet();
    const bus = { send: async () => { throw new Error('bus is down'); } };
    const t = await applyAndAnnounce(s, bus, { action: 'cancel', id: 'T-0001', reason: 'not needed' }, { log });
    assert.equal(t.status, 'cancelled');
    assert.equal(s.getTask('T-0001').status, 'cancelled');
    assert.equal(log.warnings.length, 2);
  });

  it('a hanging bus is abandoned after the timeout', async () => {
    const s = store();
    const log = quiet();
    const bus = { send: () => new Promise(() => {}) };
    const started = Date.now();
    const t = await applyAndAnnounce(s, bus, { action: 'cancel', id: 'T-0001', reason: 'not needed' }, { log, timeoutMs: 50 });
    assert.equal(t.status, 'cancelled');
    assert.ok(Date.now() - started < 1000);
    assert.match(log.warnings.at(-1), /did not answer within 50 ms/);
  });

  it('sends nothing without a bus', async () => {
    const s = store();
    const t = await applyAndAnnounce(s, null, { action: 'cancel', id: 'T-0001', reason: 'not needed' });
    assert.equal(t.status, 'cancelled');
  });

  it('a rejected action sends nothing and throws', async () => {
    const s = store();
    const bus = fakeBus();
    await assert.rejects(applyAndAnnounce(s, bus, { action: 'resolve', id: 'T-0001', reason: 'not stuck' }));
    assert.deepEqual(bus.sent, []);
  });
});
