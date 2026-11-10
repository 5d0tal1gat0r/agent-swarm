import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertSafePush } from '../src/git-safety.mjs';
import { push, pushForce } from '../src/worktree.mjs';

const SHA = 'a'.repeat(40);
const own = 'core/t-0142-posts-api';
const ok = (args) => assertSafePush({ args, taskBranch: own, baseBranch: 'main' });
const bad = (args, re) => assert.throws(() => ok(args), re);

describe('assertSafePush', () => {
  it('allows a normal push of the own branch (all spellings)', () => {
    ok(['push', '--quiet', '-u', 'origin', `HEAD:${own}`]);
    ok(['push', 'origin', `HEAD:refs/heads/${own}`]);
    ok(['push', 'origin', own]);
  });
  it('refuses main and the base branch', () => {
    bad(['push', 'origin', 'HEAD:main'], /base branch/);
    bad(['push', 'origin', 'HEAD:refs/heads/main'], /base branch/);
    bad(['push', 'origin', 'main'], /base branch/);
    assert.throws(() => assertSafePush({ args: ['push', 'origin', 'HEAD:dev'], taskBranch: own, baseBranch: 'dev' }), /base branch/);
  });
  it('refuses another task branch', () => {
    bad(['push', 'origin', 'HEAD:core/t-0999-other'], /not the task branch/);
    bad(['push', 'origin', `HEAD:${own}`, 'HEAD:core/t-0999-other'], /not the task branch/);
  });
  it('refuses bare force, +refspec and force-with-lease without sha', () => {
    bad(['push', '--force', 'origin', `HEAD:${own}`], /force/);
    bad(['push', '-f', 'origin', `HEAD:${own}`], /force/);
    bad(['push', 'origin', `+HEAD:${own}`], /force/);
    bad(['push', '--force-with-lease', 'origin', `HEAD:${own}`], /expected sha/);
    bad(['push', `--force-with-lease=${own}`, 'origin', `HEAD:${own}`], /expected sha/);
    bad(['push', `--force-with-lease=${own}:`, 'origin', `HEAD:${own}`], /expected sha/);
  });
  it('allows force-with-lease pinned to a sha on the own branch', () => {
    ok(['push', `--force-with-lease=${own}:${SHA}`, 'origin', `HEAD:${own}`]);
    bad(['push', `--force-with-lease=main:${SHA}`, 'origin', `HEAD:${own}`], /lease/);
  });
  it('refuses deleting another branch, allows deleting the own', () => {
    bad(['push', 'origin', '--delete', 'core/t-0999-other'], /not the task branch/);
    bad(['push', 'origin', ':main'], /base branch/);
    ok(['push', 'origin', '--delete', own]);
    ok(['push', 'origin', `:${own}`]);
  });
  it('refuses wildcard pushes and implicit refspecs', () => {
    bad(['push', '--mirror', 'origin'], /not allowed/);
    bad(['push', '--all', 'origin'], /not allowed/);
    bad(['push', 'origin'], /explicit/);
  });
  it('refuses a missing task branch or non-push command', () => {
    assert.throws(() => assertSafePush({ args: ['push', 'origin', 'x'], taskBranch: '', baseBranch: 'main' }), /task branch/);
    assert.throws(() => ok(['fetch', 'origin']), /push/);
  });
});

describe('real push path', () => {
  it('push/pushForce call the guard before any git push runs', async () => {
    const calls = [];
    const run = async (_dir, args) => { calls.push(args); return args[1] === '--abbrev-ref' ? own : '/tmp/x-git'; };
    await assert.rejects(push('/x', 'main', { run }), /base branch/);
    await assert.rejects(pushForce('/x', 'main', SHA, { run }), /base branch/);
    assert.equal(calls.some((a) => a[0] === 'push'), false);
    await push('/x', own, { run });
    assert.equal(calls.filter((a) => a[0] === 'push').length, 1);
  });
});
