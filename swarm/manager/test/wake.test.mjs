import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createWaker } from '../src/wake.mjs';

function fakeClock() {
  const c = { t: 0, now: () => c.t, sleepMs: async (ms) => { c.t += ms; } };
  return c;
}

describe('manager waker', () => {
  it('sends ready to the orchestrator', async () => {
    const sent = [];
    const waker = createWaker({ bus: { direct: async (...a) => sent.push(a), inbox: async () => [] }, sleepMs: async () => {} });
    await waker.ready(2);
    assert.deepEqual(sent, [['swarm-orchestrator', 'ready free 2']]);
  });

  it('wakes early on a new dispatch direct message, not on old mail or channel posts', async () => {
    const clock = fakeClock();
    let inbox = [{ id: 3, to_agent: 'me', content: 'dispatch: old' }];
    let reads = 0;
    const bus = {
      inbox: async () => {
        reads += 1;
        if (reads === 2) inbox = [{ id: 4, to_agent: null, content: 'dispatch: on a channel' }, ...inbox];
        if (reads === 3) inbox = [{ id: 5, to_agent: 'me', content: 'dispatch: 1 task(s) queued in core, next T-2. Lease now.' }, ...inbox];
        return inbox;
      },
    };
    const waker = createWaker({ bus, checkMs: 5000, sleepMs: clock.sleepMs, now: clock.now });
    assert.equal(await waker.wait(30), true);
    assert.equal(clock.t, 10_000, 'woke on the second check, not after 30 s');
  });

  it('wait resolves false after the full time when inbox throws', async () => {
    const clock = fakeClock();
    const waker = createWaker({ bus: { inbox: async () => { throw new Error('boom'); } }, checkMs: 5000, sleepMs: clock.sleepMs, now: clock.now });
    assert.equal(await waker.wait(30), false);
    assert.equal(clock.t, 30_000);
  });

  it('sleeps the full time when nothing arrives, and survives a failed read', async () => {
    const clock = fakeClock();
    const waker = createWaker({ bus: { inbox: async () => null }, checkMs: 5000, sleepMs: clock.sleepMs, now: clock.now });
    assert.equal(await waker.wait(30), false);
    assert.equal(clock.t, 30_000);
  });
});
