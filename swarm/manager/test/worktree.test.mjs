import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { branchName, commitAll, createWorktree, git, push, rebase, removeWorktree, slugify, worktreePath } from '../src/worktree.mjs';

const ID = { name: 'swarm-test', email: 'swarm-test@users.noreply.github.com' };

/** A bare origin plus a clone that the manager would use. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-wt-'));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  return { root, origin, repo, state };
}

async function setup() {
  const f = fixture();
  await git(f.root, ['init', '--quiet', '--bare', f.origin]);
  await git(f.root, ['clone', '--quiet', f.origin, f.repo]);
  fs.writeFileSync(path.join(f.repo, 'README.md'), 'hello\n');
  await git(f.repo, ['add', '-A']);
  await git(f.repo, ['commit', '--quiet', '-m', 'init'], { identity: ID });
  await git(f.repo, ['push', '--quiet', 'origin', 'HEAD:main']);
  return f;
}

describe('worktree naming', () => {
  it('slugs titles safely and builds department branches', () => {
    assert.equal(slugify('Queue API: list queued tasks!'), 'queue-api-list-queued-tasks');
    assert.equal(branchName('core', 'T-0142', 'Posts API: pagination'), 'core/t-0142-posts-api-pagination');
    assert.throws(() => slugify('!!!'), /empty slug/);
  });

  it('rejects task ids that could escape the state directory', () => {
    assert.throws(() => worktreePath('/tmp/s', '../etc'), /bad task id/);
    assert.equal(worktreePath('/tmp/s', 'T-0001'), path.join('/tmp/s', 'wt', 'T-0001'));
  });
});

describe('worktree lifecycle against real git', () => {
  it('creates a worktree on a department branch from origin/main', async () => {
    const f = await setup();
    const { dir, branch } = await createWorktree({ repoDir: f.repo, stateDir: f.state, taskId: 'T-0001', department: 'core', title: 'First task' });
    assert.equal(branch, 'core/t-0001-first-task');
    assert.equal(fs.readFileSync(path.join(dir, 'README.md'), 'utf8'), 'hello\n');
    await assert.rejects(createWorktree({ repoDir: f.repo, stateDir: f.state, taskId: 'T-0001', department: 'core', title: 'First task' }), /already exists/);
  });

  it('commits changes, pushes the branch, and reports nothing to commit as null', async () => {
    const f = await setup();
    const { dir, branch } = await createWorktree({ repoDir: f.repo, stateDir: f.state, taskId: 'T-0002', department: 'core', title: 'Edit' });
    assert.equal(await commitAll(dir, 'nothing', ID), null);
    fs.writeFileSync(path.join(dir, 'x.txt'), 'data\n');
    const sha = await commitAll(dir, 'T-0002: edit', ID);
    assert.match(sha, /^[a-f0-9]{40}$/);
    await push(dir, branch);
    const remote = await git(f.root, ['--git-dir', f.origin, 'rev-parse', branch]);
    assert.equal(remote, sha);
  });

  it('rebases on a moved origin/main, and aborts cleanly on a conflict', async () => {
    const f = await setup();
    const { dir } = await createWorktree({ repoDir: f.repo, stateDir: f.state, taskId: 'T-0003', department: 'core', title: 'Rebase' });
    fs.writeFileSync(path.join(dir, 'mine.txt'), 'mine\n');
    await commitAll(dir, 'mine', ID);
    // origin/main moves with an unrelated change: rebase succeeds.
    fs.writeFileSync(path.join(f.repo, 'other.txt'), 'other\n');
    await git(f.repo, ['add', '-A']);
    await git(f.repo, ['commit', '--quiet', '-m', 'other'], { identity: ID });
    await git(f.repo, ['push', '--quiet', 'origin', 'HEAD:main']);
    await rebase(dir, ID);
    assert.equal(fs.existsSync(path.join(dir, 'other.txt')), true);
    // Now a conflicting change on the same file: rebase aborts and throws.
    fs.writeFileSync(path.join(dir, 'README.md'), 'mine\n');
    await commitAll(dir, 'mine readme', ID);
    fs.writeFileSync(path.join(f.repo, 'README.md'), 'theirs\n');
    await git(f.repo, ['commit', '--quiet', '-am', 'theirs'], { identity: ID });
    await git(f.repo, ['push', '--quiet', 'origin', 'HEAD:main']);
    await assert.rejects(rebase(dir, ID), /rebase conflict/);
    assert.equal(await git(dir, ['status', '--porcelain']), '');
  });

  it('removes the worktree directory and its branch', async () => {
    const f = await setup();
    const { dir, branch } = await createWorktree({ repoDir: f.repo, stateDir: f.state, taskId: 'T-0004', department: 'core', title: 'Gone' });
    await removeWorktree(f.repo, dir, branch);
    assert.equal(fs.existsSync(dir), false);
    const branches = await git(f.repo, ['branch', '--list', branch]);
    assert.equal(branches, '');
  });
});
