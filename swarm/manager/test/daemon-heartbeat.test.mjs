import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDaemon } from '../src/daemon.mjs';

describe('daemon heartbeat while tasks run', () => {
  it('beats with the running task ids on a timer until the task finishes, then stops', async () => {
    const beats = [];
    let release;
    const client = {
      async heartbeat(body) { beats.push(body); },
      async lease() { return beats.length === 1 ? [{ id: 'T-0001', paths: ['a/**'], department: 'core' }] : []; },
      async release() {},
    };
    const daemon = createDaemon({
      client, manager: 'm', agentKind: 'claude', department: 'core', concurrency: 1, heartbeatMs: 5,
      slotDir: new URL(`../.slots-${process.pid}-${Date.now()}/`, import.meta.url).pathname,
      runTask: () => new Promise((r) => { release = r; }),
    });
    const { started } = await daemon.tick();
    assert.deepEqual(started, ['T-0001']);
    await new Promise((r) => setTimeout(r, 40));
    const during = beats.filter((b) => b.running.includes('T-0001'));
    assert.ok(during.length >= 3, `expected several beats while running, got ${during.length}`);
    release({ status: 'submitted' });
    await new Promise((r) => setTimeout(r, 10));
    const count = beats.length;
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(beats.length, count, 'no beats after the task finished');
  });
});
