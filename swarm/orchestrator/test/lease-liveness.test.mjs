import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore } from '../src/store.mjs';

const MIN = 60_000;
function setup() {
  const clock = { t: Date.parse('2026-11-01T10:00:00Z'), now() { return this.t; } };
  const store = openStore({ clock, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
  store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
  store.createTask({
    id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'Long', department: 'core', priority: 'p1', size: 'S',
    paths: ['swarm/x/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 },
  });
  store.lease({ department: 'core', slots: 1, manager: 'me-core' });
  store.progress({ id: 'T-0001', manager: 'me-core', phase: 'subagents', note: '', tokens: 0 });
  return { clock, store };
}

describe('lease liveness', () => {
  it('a task held past leaseMinutes survives while its manager heartbeats it', () => {
    const { clock, store } = setup();
    for (let i = 0; i < 3; i += 1) {
      clock.t += 6 * MIN;
      assert.equal(store.renewLeases({ manager: 'me-core', ids: ['T-0001'] }), 1);
      assert.deepEqual(store.expireLeases(), []);
    }
    assert.equal(store.getTask('T-0001').status, 'in_progress', '18 minutes in, still held');
    assert.equal(store.getTask('T-0001').attempts, 0, 'no attempt spent');
  });

  it('a silent task expires at leaseMinutes, spends an attempt and goes back to queued', () => {
    const { clock, store } = setup();
    clock.t += 11 * MIN;
    assert.deepEqual(store.expireLeases(), ['T-0001']);
    const t = store.getTask('T-0001');
    assert.equal(t.status, 'queued');
    assert.equal(t.attempts, 1);
  });

  it('another manager cannot renew a lease it does not hold', () => {
    const { clock, store } = setup();
    clock.t += 9 * MIN;
    assert.equal(store.renewLeases({ manager: 'other-core', ids: ['T-0001'] }), 0);
    clock.t += 2 * MIN;
    assert.deepEqual(store.expireLeases(), ['T-0001']);
  });

  it('unknown ids are skipped, not an error, and not-leased tasks are left alone', () => {
    const { store } = setup();
    assert.equal(store.renewLeases({ manager: 'me-core', ids: ['T-9999', 'T-0001'] }), 1);
    store.cancel('T-0001', 'done in test');
    assert.equal(store.renewLeases({ manager: 'me-core', ids: ['T-0001'] }), 0);
  });
});
