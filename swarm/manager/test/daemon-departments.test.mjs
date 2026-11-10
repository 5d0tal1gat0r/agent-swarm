import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createDaemon } from '../src/daemon.mjs';
import { readConfig, writeConfig } from '../src/config.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

// One queue per department; lease reads the department it is asked for.
function fakeClient(queues) {
  const calls = { lease: [], release: [], heartbeat: [], queue: [] };
  return {
    calls,
    async heartbeat(body) { calls.heartbeat.push(body); },
    async lease({ department, slots }) {
      calls.lease.push(department);
      return (queues[department] ?? []).splice(0, slots);
    },
    async release(id, { reason }) { calls.release.push({ id, reason }); },
    async queue(department) { calls.queue.push(department); return queues[department] ?? []; },
  };
}

const task = (id, department, paths) => ({ id, title: id, paths, department });
const tempSlots = () => fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-slots-'));

describe('multi-department manager daemon', () => {
  it('leases from the second department when the first is empty', async () => {
    const client = fakeClient({ core: [], runtime: [task('R-1', 'runtime', ['swarm/manager/**'])] });
    const ran = [];
    const daemon = createDaemon({
      client, manager: 'm', agentKind: 'claude', departments: ['core', 'runtime'], concurrency: 2, slotDir: tempSlots(),
      runTask: async (t) => { ran.push(t.id); return { status: 'submitted' }; },
    });
    const { results } = await daemon.runOnce();
    assert.deepEqual(ran, ['R-1']);
    assert.equal(results.length, 1);
    assert.deepEqual(client.calls.lease, ['core', 'runtime', 'runtime'], 'core first, then runtime until it is empty');
  });

  it('fills slots department by department, in order', async () => {
    const gates = Object.fromEntries(['C-1', 'R-1', 'R-2'].map((id) => [id, deferred()]));
    const client = fakeClient({
      core: [task('C-1', 'core', ['swarm/orchestrator/**'])],
      runtime: [task('R-1', 'runtime', ['swarm/manager/**']), task('R-2', 'runtime', ['swarm/shared/**'])],
    });
    const daemon = createDaemon({
      client, manager: 'm', agentKind: 'claude', departments: ['core', 'runtime'], concurrency: 2, slotDir: tempSlots(),
      runTask: (t) => gates[t.id].promise,
    });
    const { started, pending } = await daemon.tick();
    assert.deepEqual(started, ['C-1', 'R-1'], 'the manager-wide cap (2) stops leasing; R-2 stays queued');
    for (const id of started) gates[id].resolve({ status: 'submitted' });
    await Promise.all(pending);
  });

  it('respects each department concurrency cap', async () => {
    const gates = Object.fromEntries(['C-1', 'C-2', 'R-1', 'R-2'].map((id) => [id, deferred()]));
    const client = fakeClient({
      core: [task('C-1', 'core', ['a/**']), task('C-2', 'core', ['b/**'])],
      runtime: [task('R-1', 'runtime', ['c/**']), task('R-2', 'runtime', ['d/**'])],
    });
    const daemon = createDaemon({
      client, manager: 'm', agentKind: 'claude', departments: ['core', 'runtime'], concurrency: 3,
      departmentConcurrency: { core: 1, runtime: 2 }, slotDir: tempSlots(),
      runTask: (t) => gates[t.id].promise,
    });
    const { started, pending } = await daemon.tick();
    assert.deepEqual(started, ['C-1', 'R-1', 'R-2'], 'core is capped at 1, so the third slot goes to runtime');
    assert.equal(client.calls.lease.filter((d) => d === 'core').length, 1, 'core is not leased again once at its cap');

    // A second tick while all run: core is still at its cap, runtime too, and the manager is full.
    const again = await daemon.tick();
    assert.deepEqual(again.started, []);
    for (const id of started) gates[id].resolve({ status: 'submitted' });
    await Promise.all(pending);
  });

  it('a department at its cap does not block the next one', async () => {
    const hold = deferred();
    const client = fakeClient({
      core: [task('C-1', 'core', ['a/**']), task('C-2', 'core', ['b/**'])],
      runtime: [task('R-1', 'runtime', ['c/**'])],
    });
    const daemon = createDaemon({
      client, manager: 'm', agentKind: 'claude', departments: ['core', 'runtime'], concurrency: 3,
      departmentConcurrency: { core: 1, runtime: 1 }, slotDir: tempSlots(),
      runTask: () => hold.promise,
    });
    const { started, pending } = await daemon.tick();
    assert.deepEqual(started, ['C-1', 'R-1']);
    assert.equal(client.calls.queue.length, 0);
    hold.resolve({ status: 'submitted' });
    await Promise.all(pending);
  });

  it('dry run shows the first queued task across departments, in order', async () => {
    const client = fakeClient({ core: [], runtime: [task('R-1', 'runtime', ['x/**'])] });
    const daemon = createDaemon({ client, manager: 'm', agentKind: 'claude', departments: ['core', 'runtime'], slotDir: tempSlots() });
    const next = await daemon.dryRun();
    assert.deepEqual(next.map((t) => t.id), ['R-1']);
    assert.deepEqual(client.calls.queue, ['core', 'runtime']);
  });

  it('the single department option still works', async () => {
    const client = fakeClient({ core: [task('C-1', 'core', ['a/**'])] });
    const daemon = createDaemon({ client, manager: 'm', agentKind: 'claude', department: 'core', slotDir: tempSlots(), runTask: async () => ({ status: 'submitted' }) });
    assert.deepEqual(daemon.departments, ['core']);
    const { leased } = await daemon.runOnce();
    assert.equal(leased, 'C-1');
  });
});

describe('manager config departments', () => {
  const base = {
    url: 'http://o', token: 't', name: 'ana-claude', member: 'ana', repoDir: '/r', stateDir: '/s',
    identity: { name: 'swarm-ana', email: 'a@b' }, checks: ['npm', 'test'],
  };
  const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-cfg-')), 'manager.json');

  it('a config with the old single department key still loads, as departments', () => {
    const file = tempFile();
    writeConfig({ ...base, department: 'core' }, file);
    const cfg = readConfig(file);
    assert.deepEqual(cfg.departments, ['core']);
  });

  it('loads a departments list', () => {
    const file = tempFile();
    writeConfig({ ...base, departments: ['core', 'runtime'] }, file);
    assert.deepEqual(readConfig(file).departments, ['core', 'runtime']);
  });

  it('refuses a config with neither key, or an empty list', () => {
    const file = tempFile();
    writeConfig(base, file);
    assert.throws(() => readConfig(file), /departments/);
    writeConfig({ ...base, departments: [] }, file);
    assert.throws(() => readConfig(file), /departments/);
  });
});
