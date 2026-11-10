import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { withRepoLock } from '../src/repo-lock.mjs';
import { attachWorktree, branchName, createWorktree, git, removeWorktree } from '../src/worktree.mjs';

const ID = { name: 'swarm-me-core', email: 'swarm-me-core@users.noreply.github.com' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('repo lock', () => {
  it('runs operations on one key one at a time, in order', async () => {
    const log = [];
    const op = (name, ms) => withRepoLock('k', async () => { log.push(`start ${name}`); await sleep(ms); log.push(`end ${name}`); });
    await Promise.all([op('a', 30), op('b', 5), op('c', 1)]);
    assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('a failing operation does not block the next one', async () => {
    const first = withRepoLock('f', async () => { throw new Error('boom'); });
    const second = withRepoLock('f', async () => 'ok');
    await assert.rejects(first, /boom/);
    assert.equal(await second, 'ok');
  });

  it('different keys do not wait for each other', async () => {
    const order = [];
    const slow = withRepoLock('x', async () => { await sleep(40); order.push('x'); });
    const fast = withRepoLock('y', async () => { order.push('y'); });
    await Promise.all([slow, fast]);
    assert.deepEqual(order, ['y', 'x']);
  });
});

describe('worktree operations on one clone', () => {
  let root, origin, repo, stateDir;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-lock-'));
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    stateDir = path.join(root, 'state');
    await git(root, ['init', '--quiet', '--bare', origin]);
    await git(root, ['clone', '--quiet', origin, repo]);
    fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--quiet', '-m', 'init'], { identity: ID });
    await git(repo, ['push', '--quiet', 'origin', 'HEAD:main']);
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('three tasks create worktrees in parallel on one clone without a git lock error', async () => {
    const ids = ['T-0701', 'T-0702', 'T-0703'];
    const made = await Promise.all(ids.map((taskId) => createWorktree({ repoDir: repo, stateDir, taskId, department: 'core', title: `Task ${taskId}` })));
    assert.equal(made.length, 3);
    for (const { dir } of made) assert.equal(fs.existsSync(path.join(dir, 'README.md')), true);
  }, { timeout: 30_000 });

  it('attach over an existing worktree dir finishes (no self-deadlock)', async () => {
    // T-0701's worktree exists from the test above. Push its branch so attach can fetch it;
    // attach then removes the existing dir (the path that used to deadlock) and re-adds it.
    const branch = branchName('core', 'T-0701', 'Task T-0701');
    const dir = path.join(stateDir, 'wt', 'T-0701');
    await git(dir, ['push', '--quiet', 'origin', `HEAD:${branch}`]);
    const again = await attachWorktree({ repoDir: repo, stateDir, taskId: 'T-0701', branch });
    assert.equal(fs.existsSync(again.dir), true);
    await removeWorktree(repo, again.dir, branch);
  }, { timeout: 30_000 });
});
