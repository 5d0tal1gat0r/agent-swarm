import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createDaemon } from '../src/daemon.mjs';
import { cleanupFinishedWorktrees, createWorktree, git } from '../src/worktree.mjs';

const ID = { name: 'swarm-test', email: 'swarm-test@users.noreply.github.com' };
const quiet = { warn() {}, log() {} };

async function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wtc-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  await git(root, ['init', '--quiet', '--bare', origin]);
  await git(root, ['clone', '--quiet', origin, repo]);
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '--quiet', '-m', 'init'], { identity: ID });
  await git(repo, ['push', '--quiet', 'origin', 'HEAD:main']);
  return { root, repo, state };
}

async function addTask(f, taskId, title) {
  return createWorktree({ repoDir: f.repo, stateDir: f.state, taskId, department: 'core', title });
}

async function hasBranch(repo, branch) {
  return (await git(repo, ['branch', '--list', branch])) !== '';
}

function statusClient(statuses) {
  return {
    asked: [],
    async getTask(id) {
      this.asked.push(id);
      if (statuses[id] instanceof Error) throw statuses[id];
      return { id, status: statuses[id] };
    },
  };
}

describe('cleanupFinishedWorktrees', () => {
  it('removes merged and cancelled task worktrees and their local branches, keeps running and in_progress ones', async () => {
    const f = await setup();
    const merged = await addTask(f, 'T-0001', 'Merged task');
    const running = await addTask(f, 'T-0002', 'Running here');
    const progress = await addTask(f, 'T-0003', 'Elsewhere in progress');
    const cancelled = await addTask(f, 'T-0004', 'Cancelled task');
    const client = statusClient({ 'T-0001': 'merged', 'T-0002': 'merged', 'T-0003': 'in_progress', 'T-0004': 'cancelled' });

    const removed = await cleanupFinishedWorktrees({ repoDir: f.repo, stateDir: f.state, client, skip: new Set(['T-0002']), log: quiet });

    assert.deepEqual(removed, ['T-0001', 'T-0004']);
    assert.ok(!client.asked.includes('T-0002'), 'a task running in this process is not even looked up');
    for (const wt of [merged, cancelled]) {
      assert.equal(fs.existsSync(wt.dir), false);
      assert.equal(await hasBranch(f.repo, wt.branch), false);
    }
    for (const wt of [running, progress]) {
      assert.equal(fs.existsSync(wt.dir), true);
      assert.equal(await hasBranch(f.repo, wt.branch), true);
    }
    assert.doesNotMatch(await git(f.repo, ['worktree', 'list']), /T-0001|T-0004/);
  });

  it('leaves everything as is when the client fails', async () => {
    const f = await setup();
    const a = await addTask(f, 'T-0001', 'One');
    const b = await addTask(f, 'T-0002', 'Two');
    const warnings = [];
    const client = statusClient({ 'T-0001': new Error('GET /tasks/T-0001 -> 500: boom'), 'T-0002': new Error('fetch failed') });

    const removed = await cleanupFinishedWorktrees({ repoDir: f.repo, stateDir: f.state, client, log: { warn: (m) => warnings.push(m) } });

    assert.deepEqual(removed, []);
    for (const wt of [a, b]) {
      assert.equal(fs.existsSync(wt.dir), true);
      assert.equal(await hasBranch(f.repo, wt.branch), true);
    }
    assert.equal(warnings.length, 2);
  });

  it('does nothing when the state dir has no worktrees yet', async () => {
    const f = await setup();
    assert.deepEqual(await cleanupFinishedWorktrees({ repoDir: f.repo, stateDir: f.state, client: statusClient({}), log: quiet }), []);
  });
});

describe('daemon worktree cleanup', () => {
  const slotDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-slots-'));

  it('after the next tick a merged task worktree is gone and a running task worktree is untouched', async () => {
    const f = await setup();
    const merged = await addTask(f, 'T-0001', 'Done already');
    let release;
    let started;
    const ready = new Promise((r) => { started = r; });
    let running;
    const client = {
      ...statusClient({ 'T-0001': 'merged', 'T-0002': 'merged' }),
      leased: false,
      async heartbeat() {},
      async lease() {
        if (this.leased) return [];
        this.leased = true;
        return [{ id: 'T-0002', paths: ['a/**'], department: 'core', title: 'Busy' }];
      },
      async release() {},
    };
    const daemon = createDaemon({
      client, manager: 'm', agentKind: 'claude', department: 'core', concurrency: 1, slotDir: slotDir(), log: quiet,
      runTask: async (task) => {
        running = await addTask(f, task.id, task.title);
        started();
        return new Promise((r) => { release = r; });
      },
      cleanup: ({ skip }) => cleanupFinishedWorktrees({ repoDir: f.repo, stateDir: f.state, client, skip, log: quiet }),
    });

    await daemon.tick(); // cleanup removes T-0001, then T-0002 starts
    await ready;
    assert.equal(fs.existsSync(merged.dir), false);
    assert.equal(await hasBranch(f.repo, merged.branch), false);

    await daemon.tick(); // T-0002 runs here: skipped even though the fake says merged
    assert.equal(fs.existsSync(running.dir), true);
    assert.equal(await hasBranch(f.repo, running.branch), true);
    release({ status: 'submitted' });
  });

  it('a failing cleanup is logged and does not fail the tick', async () => {
    const warnings = [];
    let calls = 0;
    const daemon = createDaemon({
      client: { async heartbeat() {}, async lease() { return []; }, async release() {} },
      manager: 'm', agentKind: 'claude', department: 'core', slotDir: slotDir(), log: { warn: (m) => warnings.push(m) },
      runTask: async () => ({}),
      cleanup: async () => { calls += 1; throw new Error('disk on fire'); },
      cleanupEveryTicks: 2,
    });
    await daemon.tick();
    await daemon.tick();
    await daemon.tick();
    assert.equal(calls, 2, 'runs on the first tick, then every 2 ticks');
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /disk on fire/);
  });
});
