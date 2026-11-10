import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checksState, GitHub, mapPr } from '../src/github.mjs';

describe('checksState', () => {
  it('summarizes check runs and status contexts', () => {
    const run = (status, conclusion) => ({ __typename: 'CheckRun', status, conclusion });
    assert.equal(checksState([]), 'none');
    assert.equal(checksState([run('COMPLETED', 'SUCCESS'), run('COMPLETED', 'SKIPPED')]), 'success');
    assert.equal(checksState([run('COMPLETED', 'SUCCESS'), run('IN_PROGRESS', null)]), 'pending');
    assert.equal(checksState([run('COMPLETED', 'FAILURE'), run('IN_PROGRESS', null)]), 'failure');
    assert.equal(checksState([{ __typename: 'StatusContext', state: 'ERROR' }]), 'failure');
  });
});

describe('mapPr', () => {
  it('maps gh JSON to the scheduler shape', () => {
    const pr = mapPr({
      number: 8,
      title: 'T6',
      author: { login: '<member-f>' },
      headRefOid: 'abc',
      headRefName: '<member-f>/t6',
      baseRefName: 'main',
      reviewRequests: [{ __typename: 'User', login: 'carol' }],
      autoMergeRequest: { mergeMethod: 'SQUASH' },
      commits: [{ committedDate: 'c1' }, { committedDate: 'c2' }],
      isDraft: false,
      labels: [{ name: 'p1' }],
      closingIssuesReferences: [{ number: 12 }],
      statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      mergeable: 'CONFLICTING',
      updatedAt: '2026-10-31T18:48:33Z',
      reviews: [{ author: { login: 'bob' }, state: 'APPROVED', commit: { oid: 'abc' }, submittedAt: 't' }],
    });
    assert.deepEqual(pr, {
      number: 8,
      title: 'T6',
      author: '<member-f>',
      headSha: 'abc',
      headRef: '<member-f>/t6',
      baseRef: 'main',
      headCommittedAt: 'c2',
      requested: ['carol'],
      autoMerge: true,
      draft: false,
      labels: ['p1'],
      linkedIssue: 12,
      checks: 'success',
      mergeable: false,
      updatedAt: '2026-10-31T18:48:33Z',
      reviews: [{ author: 'bob', state: 'APPROVED', commitId: 'abc', submittedAt: 't' }],
    });
  });
});

/** Fake gh: records calls, answers from a script of handlers. */
function fakeGh(handler) {
  const calls = [];
  const exec = async (args, opts) => {
    calls.push({ args, input: opts?.input });
    return handler(args) ?? '';
  };
  return { calls, exec };
}

describe('GitHub', () => {
  it('snapshot ignores pause issues from non-members', async () => {
    const members = Buffer.from(JSON.stringify(['alice', 'bob'])).toString('base64');
    const { exec } = fakeGh((args) => {
      if (args[0] === 'api' && args[1].endsWith('members.json')) return JSON.stringify({ content: members });
      if (args[0] === 'api' && args[1].endsWith('policy.json')) throw new Error('404');
      if (args[0] === 'api' && args[1].endsWith('branches/main')) return 'true\n';
      if (args.includes('autopilot-pause')) return JSON.stringify([{ author: { login: 'mallory' } }]);
      return '[]';
    });
    const snap = await new GitHub('o/r', exec).snapshot();
    assert.equal(snap.paused, false);
    assert.equal(snap.protectedMain, true);
    assert.deepEqual(snap.policy, {});
    assert.deepEqual(snap.members, ['alice', 'bob']);
  });

  it('merge pins the reviewed head commit', async () => {
    const { calls, exec } = fakeGh(() => '');
    await new GitHub('o/r', exec).mergePr(7, 'sha1');
    const args = calls[0].args;
    assert.deepEqual(args.slice(0, 3), ['pr', 'merge', '7']);
    assert.ok(args.includes('--squash'));
    assert.equal(args[args.indexOf('--match-head-commit') + 1], 'sha1');
  });

  it('comments are sent on stdin, never as arguments', async () => {
    const { calls, exec } = fakeGh(() => '');
    await new GitHub('o/r', exec).comment('issue', 4, '$(rm -rf ~) `x`');
    assert.equal(calls[0].input, '$(rm -rf ~) `x`');
    assert.ok(!calls[0].args.some((a) => a.includes('rm -rf')));
  });
});
