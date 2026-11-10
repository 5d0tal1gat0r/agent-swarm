import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createDaemon, createMachineSlotLock, tasksOverlap } from '../src/daemon.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function fakeClient(queue) {
  const calls = { lease: 0, release: [], heartbeat: [] };
  return {
    calls,
    async heartbeat(body) { calls.heartbeat.push(body); },
    async lease({ slots }) {
      calls.lease += 1;
      return queue.splice(0, slots);
    },
    async release(id, { reason }) { calls.release.push({ id, reason }); },
    async queue() { return queue; },
  };
}

const task = (id, paths) => ({ id, title: id, paths, department: 'core' });
const tempSlots = () => fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-slots-'));

describe('concurrent manager daemon', () => {
  it('runs non-overlapping tasks side by side, up to the concurrency cap', async () => {
    const gates = { 'T-1': deferred(), 'T-2': deferred(), 'T-3': deferred() };
    const client = fakeClient([task('T-1', ['a/**']), task('T-2', ['b/**']), task('T-3', ['c/**'])]);
    const daemon = createDaemon({ client, manager: 'm', agentKind: 'claude', department: 'core', concurrency: 2, slotDir: tempSlots(), runTask: (t) => gates[t.id].promise });
    const { started } = await daemon.tick();
    assert.deepEqual(started, ['T-1', 'T-2']);
    assert.equal(daemon.running.size, 2);
    assert.equal(client.calls.lease, 2, 'stops leasing at the cap; T-3 stays queued');
    assert.equal(client.calls.heartbeat[0].freeSlots, 2, 'heartbeat before leasing reports both slots free');
    gates['T-1'].resolve({ status: 'submitted' });
    gates['T-2'].resolve({ status: 'submitted' });
    await daemon.runOnce().catch(() => {});
  });

  it('releases a task whose paths overlap a running one, without running it, and stops leasing that tick', async () => {
    const hold = deferred();
    const client = fakeClient([task('T-1', ['swarm/**']), task('T-2', ['swarm/manager/**']), task('T-3', ['docs/**'])]);
    const ran = [];
    const daemon = createDaemon({ client, manager: 'm', agentKind: 'claude', department: 'core', concurrency: 3, slotDir: tempSlots(), runTask: (t) => { ran.push(t.id); return hold.promise; } });
    const { started } = await daemon.tick();
    assert.deepEqual(started, ['T-1']);
    assert.deepEqual(ran, ['T-1']);
    assert.equal(client.calls.release.length, 1);
    assert.equal(client.calls.release[0].id, 'T-2');
    assert.match(client.calls.release[0].reason, /paths overlap running T-1/);
    hold.resolve({ status: 'submitted' });
  });

  it('one failing task does not stop the other from finishing', async () => {
    const client = fakeClient([task('T-1', ['a/**']), task('T-2', ['b/**'])]);
    const daemon = createDaemon({
      client, manager: 'm', agentKind: 'claude', department: 'core', concurrency: 2,
      slotDir: tempSlots(),
      runTask: async (t) => { if (t.id === 'T-1') throw new Error('agent crashed'); return { status: 'submitted' }; },
    });
    const { results } = await daemon.runOnce();
    assert.equal(results.length, 2);
    assert.deepEqual(results.find((r) => r.id === 'T-1'), { id: 'T-1', error: 'agent crashed' });
    assert.equal(results.find((r) => r.id === 'T-2').result.status, 'submitted');
    assert.equal(daemon.running.size, 0, 'slots freed after both finish');
  });

  it('with concurrency 1 a second task waits in the queue', async () => {
    const client = fakeClient([task('T-1', ['a/**']), task('T-2', ['b/**'])]);
    const daemon = createDaemon({ client, manager: 'm', agentKind: 'claude', department: 'core', concurrency: 1, slotDir: tempSlots(), runTask: () => new Promise(() => {}) });
    const { started } = await daemon.tick();
    assert.deepEqual(started, ['T-1']);
    assert.equal(client.calls.lease, 1);
  });

  it('tasksOverlap is true for nested or shared globs and false for disjoint ones', () => {
    assert.equal(tasksOverlap(task('a', ['swarm/**']), task('b', ['swarm/manager/**'])), true);
    assert.equal(tasksOverlap(task('a', ['swarm/manager/**']), task('b', ['swarm/orchestrator/**'])), false);
    assert.equal(tasksOverlap(task('a', ['x/**', 'y/**']), task('b', ['y/z.mjs'])), true);
  });

  it('caps total running tasks at three across independent manager daemons', async () => {
    const slotDir = tempSlots();
    const gates = Object.fromEntries(['A-1', 'A-2', 'B-1', 'B-2'].map((id) => [id, deferred()]));
    const clientA = fakeClient([task('A-1', ['a/1']), task('A-2', ['a/2'])]);
    const clientB = fakeClient([task('B-1', ['b/1']), task('B-2', ['b/2'])]);
    const daemonA = createDaemon({
      client: clientA, manager: 'a', agentKind: 'claude', department: 'core', concurrency: 2, slotDir,
      runTask: (t) => gates[t.id].promise,
    });
    const daemonB = createDaemon({
      client: clientB, manager: 'b', agentKind: 'claude', department: 'core', concurrency: 2, slotDir,
      runTask: (t) => gates[t.id].promise,
    });

    const [tickA, tickB] = await Promise.all([daemonA.tick(), daemonB.tick()]);
    const started = [...tickA.started, ...tickB.started];
    assert.equal(started.length, 3);
    assert.equal(new Set(started).size, 3);
    assert.ok(started.every((id) => ['A-1', 'A-2', 'B-1', 'B-2'].includes(id)));

    for (const id of started) gates[id].resolve({ status: 'submitted' });
    await Promise.all([...tickA.pending, ...tickB.pending]);
    fs.rmSync(slotDir, { recursive: true, force: true });
  });

  it('releases a machine slot when a task ends so another daemon can use it', async () => {
    const slotDir = tempSlots();
    const first = deferred();
    const clientA = fakeClient([task('A-1', ['a/1'])]);
    const clientB = fakeClient([task('B-1', ['b/1'])]);
    const daemonA = createDaemon({
      client: clientA, manager: 'a', agentKind: 'claude', department: 'core', concurrency: 1, slotDir, maxMachineSlots: 1,
      runTask: () => first.promise,
    });
    const daemonB = createDaemon({
      client: clientB, manager: 'b', agentKind: 'claude', department: 'core', concurrency: 1, slotDir, maxMachineSlots: 1,
      runTask: async () => ({ status: 'submitted' }),
    });

    const running = await daemonA.tick();
    assert.deepEqual(running.started, ['A-1']);
    assert.deepEqual((await daemonB.tick()).started, []);

    first.resolve({ status: 'submitted' });
    await Promise.all(running.pending);
    assert.deepEqual((await daemonB.tick()).started, ['B-1']);
    fs.rmSync(slotDir, { recursive: true, force: true });
  });

  it('cleans its slot files when the manager process exits and reclaims dead owners', () => {
    const slotDir = tempSlots();
    const modulePath = path.resolve(new URL('../src/daemon.mjs', import.meta.url).pathname);
    const child = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      `import { createMachineSlotLock } from ${JSON.stringify(modulePath)}; createMachineSlotLock({ dir: process.argv[1], maxSlots: 1 }).acquire();`,
      slotDir,
    ], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(fs.readdirSync(slotDir), []);

    fs.writeFileSync(path.join(slotDir, 'slot-0.lock'), JSON.stringify({ pid: 999_999_999 }));
    const lock = createMachineSlotLock({ dir: slotDir, maxSlots: 1 });
    assert.ok(lock.acquire(), 'a slot owned by a dead process is reclaimable');
    fs.rmSync(slotDir, { recursive: true, force: true });
  });
});
