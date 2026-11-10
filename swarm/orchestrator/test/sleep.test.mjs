import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSleepLog, sleptMs } from '../src/sleep.mjs';

const MIN = 60_000;

describe('sleep log (ARCHITECTURE 70)', () => {
  it('records a gap longer than gapMs as a sleep and calls onSleep once', () => {
    const seen = [];
    const log = createSleepLog({ gapMs: 3 * MIN, onSleep: (ms) => seen.push(ms) });
    assert.equal(log.observe(0), 0, 'the first observation only records');
    assert.equal(log.observe(MIN), 0);
    assert.equal(log.observe(2 * MIN), 0);
    assert.equal(log.observe(92 * MIN), 90 * MIN);
    assert.equal(log.observe(92 * MIN + 1000), 0, 'a second loop after the wake sees no gap');
    assert.deepEqual(seen, [90 * MIN]);
    assert.deepEqual(log.intervals(), [{ from: 2 * MIN, to: 92 * MIN }]);
  });

  it('drops sleeps older than keepMs', () => {
    const log = createSleepLog({ gapMs: MIN, keepMs: 10 * MIN });
    log.observe(0);
    log.observe(5 * MIN);
    log.observe(30 * MIN);
    assert.deepEqual(log.intervals(), [{ from: 5 * MIN, to: 30 * MIN }]);
  });

  it('sleptMs counts only the part of each sleep inside the window', () => {
    const sleeps = [{ from: 10, to: 20 }, { from: 30, to: 50 }];
    assert.equal(sleptMs(sleeps, 0, 100), 30);
    assert.equal(sleptMs(sleeps, 15, 40), 15);
    assert.equal(sleptMs(sleeps, 60, 70), 0);
    assert.equal(sleptMs(undefined, 0, 100), 0);
  });
});
