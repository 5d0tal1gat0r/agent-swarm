import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, pickReviewers } from '../src/decide.mjs';

const ME = 'alice';
const NOW = new Date('2026-11-01T12:00:00Z');
const POLICY = { owner: 'olga', approvalsRequired: 2, maxOpenPrsPerMember: 1, maxOpenPrsTotal: 3, reviewTimeoutHours: 2, maxChangeRounds: 3 };

function snap(over = {}) {
  return { members: ['olga', 'alice', 'bob', 'carol', 'dave'], policy: POLICY, protectedMain: true, online: [], paused: false, issues: [], prs: [], ...over };
}

function pr(over = {}) {
  return {
    number: 10,
    title: 'feat',
    author: 'bob',
    headSha: 'h2',
    headCommittedAt: '2026-11-01T11:30:00Z',
    baseRef: 'main',
    draft: false,
    labels: [],
    linkedIssue: null,
    checks: 'success',
    mergeable: true,
    autoMerge: true,
    requested: [],
    updatedAt: '2026-11-01T11:30:00Z',
    reviews: [],
    ...over,
  };
}

const review = (author, state, commitId = 'h2') => ({ author, state, commitId, submittedAt: '2026-11-01T11:45:00Z' });
const issue = (over = {}) => ({ number: 1, title: 't', author: 'bob', labels: ['task'], assignees: [], createdAt: '2026-11-01T09:00:00Z', ...over });
const run = (s, me = ME, opts = {}) => decide(s, me, { now: NOW, ...opts });

describe('pause and idle', () => {
  it('does nothing when paused', () => {
    assert.equal(run(snap({ paused: true, issues: [issue()] })), null);
  });

  it('does nothing when there is no work (idle, no loop)', () => {
    assert.equal(run(snap()), null);
  });
});

describe('own pull requests: finish before anything else', () => {
  it('fixes own PR with changes requested on the head commit', () => {
    const s = snap({ prs: [pr({ author: ME, reviews: [review('bob', 'CHANGES_REQUESTED')] })] });
    assert.deepEqual(run(s), { kind: 'fix', pr: 10, sha: 'h2' });
  });

  it('fixes own PR with failing checks or conflicts', () => {
    assert.equal(run(snap({ prs: [pr({ author: ME, checks: 'failure' })] })).kind, 'fix');
    assert.equal(run(snap({ prs: [pr({ author: ME, mergeable: false })] })).kind, 'fix');
  });

  it('does not fix again when the change request is on an older commit', () => {
    const s = snap({ prs: [pr({ author: ME, requested: ['bob', 'carol'], reviews: [review('bob', 'CHANGES_REQUESTED', 'h1')] })] });
    assert.equal(run(s), null);
  });

  it('escalates after three rounds of changes requested, once', () => {
    const rounds = ['h1', 'h2', 'h3'].map((sha) => review('bob', 'CHANGES_REQUESTED', sha));
    assert.deepEqual(run(snap({ prs: [pr({ author: ME, headSha: 'h3', reviews: rounds })] })), { kind: 'escalate', pr: 10, sha: 'h3' });
    assert.equal(run(snap({ prs: [pr({ author: ME, headSha: 'h3', reviews: rounds, labels: ['needs-human'] })] })), null);
  });

  it('merges own PR when GitHub cannot (no protection rule) and it has 2 member approvals + green checks', () => {
    const approvals = [review('bob', 'APPROVED'), review('carol', 'APPROVED')];
    const s = snap({ protectedMain: false, prs: [pr({ author: ME, autoMerge: false, reviews: approvals })] });
    assert.deepEqual(run(s), { kind: 'merge', pr: 10, sha: 'h2' });
    assert.equal(run(snap({ protectedMain: false, prs: [pr({ author: ME, autoMerge: false, reviews: approvals, checks: 'pending' })] })), null);
  });

  it('stale and non-member approvals do not count', () => {
    const s = snap({ protectedMain: false, prs: [pr({ author: ME, autoMerge: false, requested: ['bob', 'carol'], reviews: [review('bob', 'APPROVED', 'h1'), review('mallory', 'APPROVED')] })] });
    assert.equal(run(s), null);
  });
});

describe('triage: reviewers and auto-merge', () => {
  it('requests two reviewers and enables auto-merge on a new PR', () => {
    const s = snap({ prs: [pr({ autoMerge: false })] });
    const job = run(s);
    assert.equal(job.kind, 'triage');
    assert.equal(job.pr, 10);
    assert.equal(job.autoMerge, true);
    assert.equal(job.reviewers.length, 2);
    assert.ok(!job.reviewers.includes('bob'), 'never the author');
  });

  it('does not enable auto-merge without the protection rule', () => {
    const job = run(snap({ protectedMain: false, prs: [pr({ autoMerge: false })] }));
    assert.equal(job.autoMerge, false);
  });

  it('never enables auto-merge on a PR stacked on another branch (it would merge unreviewed)', () => {
    const job = run(snap({ prs: [pr({ autoMerge: false, baseRef: 'bob/feature-a' })] }));
    assert.equal(job.kind, 'triage');
    assert.equal(job.autoMerge, false);
    assert.equal(run(snap({ prs: [pr({ autoMerge: false, baseRef: 'bob/feature-a', requested: ['carol', 'dave'] })] })), null);
  });

  it('with approvalsRequired 1, requests one reviewer and one approval completes the PR', () => {
    const one = { ...POLICY, approvalsRequired: 1 };
    const job = run(snap({ policy: one, prs: [pr({ requested: [], reviews: [] })] }));
    assert.equal(job.kind, 'triage');
    assert.equal(job.reviewers.length, 1);
    const approved = snap({ policy: one, protectedMain: false, prs: [pr({ author: ME, autoMerge: false, reviews: [review('bob', 'APPROVED')] })] });
    assert.deepEqual(run(approved), { kind: 'merge', pr: 10, sha: 'h2' });
  });

  it('only requests the missing number of reviewers', () => {
    const s = snap({ prs: [pr({ requested: ['carol'], reviews: [] })] });
    assert.equal(run(s).reviewers.length, 1);
    const full = snap({ prs: [pr({ requested: ['carol'], reviews: [review('dave', 'APPROVED')] })] });
    assert.notEqual(run(full)?.kind, 'triage');
  });

  it('re-requests the same reviewers after a fix push', () => {
    const s = snap({ prs: [pr({ reviews: [review('carol', 'CHANGES_REQUESTED', 'h1'), review('dave', 'APPROVED', 'h1')] })] });
    assert.deepEqual(run(s).reviewers.sort(), ['carol', 'dave']);
  });
});

describe('pickReviewers', () => {
  it('prefers online members, then the least loaded, never the author', () => {
    const s = snap({
      online: ['dave'],
      prs: [pr({ number: 1, requested: ['carol'] }), pr({ number: 2, requested: ['carol', 'olga'] }), pr({ number: 3, author: 'bob' })],
    });
    const picked = pickReviewers(s, s.prs[2], 2);
    assert.equal(picked[0], 'dave');
    assert.ok(!picked.includes('bob'));
    assert.ok(!picked.includes('carol'), 'carol already has 2 pending reviews');
  });

  it('is deterministic', () => {
    const s = snap({ prs: [pr()] });
    assert.deepEqual(pickReviewers(s, s.prs[0], 2), pickReviewers(s, s.prs[0], 2));
  });
});

describe('reviewing', () => {
  it('reviews a PR it was requested on', () => {
    assert.deepEqual(run(snap({ prs: [pr({ requested: [ME, 'carol'] })] })), { kind: 'review', pr: 10, sha: 'h2' });
  });

  it('does not review a PR it was not requested on, before the timeout', () => {
    assert.equal(run(snap({ prs: [pr({ requested: ['carol', 'dave'] })] })), null);
  });

  it('anyone may review after the timeout without 2 approvals', () => {
    const s = snap({ prs: [pr({ requested: ['carol', 'dave'], headCommittedAt: '2026-11-01T09:00:00Z' })] });
    assert.deepEqual(run(s), { kind: 'review', pr: 10, sha: 'h2' });
  });

  it('never reviews own PR and never the same commit twice', () => {
    assert.equal(run(snap({ prs: [pr({ author: ME, requested: ['bob', 'carol'] })] })), null);
    assert.equal(run(snap({ prs: [pr({ requested: [ME, 'carol'], reviews: [review(ME, 'COMMENTED')] })] })), null);
  });

  it('reviews again after a new commit', () => {
    assert.equal(run(snap({ prs: [pr({ requested: [ME, 'carol'], reviews: [review(ME, 'CHANGES_REQUESTED', 'h1')] })] })).kind, 'review');
  });

  it('skips drafts, red checks, needs-human and non-members', () => {
    for (const p of [pr({ draft: true }), pr({ checks: 'failure' }), pr({ labels: ['needs-human'] }), pr({ author: 'mallory' })]) {
      assert.equal(run(snap({ prs: [{ ...p, requested: [ME, 'carol'] }] })), null);
    }
  });

  it('review order: owner first, then security, then PRs on main, then oldest', () => {
    const prs = [
      pr({ number: 1, requested: [ME, 'dave'], baseRef: 'feature-x' }),
      pr({ number: 2, requested: [ME, 'dave'] }),
      pr({ number: 3, requested: [ME, 'dave'], labels: ['security'] }),
      pr({ number: 4, requested: [ME, 'dave'], author: 'olga' }),
    ];
    const order = [];
    const s = snap({ prs });
    for (let i = 0; i < 4; i++) {
      const job = run(s, ME, { skip: new Set(order.map((n) => `review:${n}:h2`)) });
      order.push(job.pr);
    }
    assert.deepEqual(order, [4, 3, 2, 1]);
  });
});

describe('building: only when nothing is waiting', () => {
  it('builds the next task when idle', () => {
    assert.deepEqual(run(snap({ issues: [issue()] })), { kind: 'build', issue: 1 });
  });

  it('no new task while a PR waits for my review', () => {
    assert.equal(run(snap({ prs: [pr({ requested: [ME, 'carol'] })], issues: [issue()] })).kind, 'review');
  });

  it('no new task while I have an open PR (1 per member)', () => {
    assert.equal(run(snap({ prs: [pr({ author: ME, requested: ['bob', 'carol'] })], issues: [issue()] })), null);
  });

  it('no new task when the team already has 3 open PRs', () => {
    const prs = [1, 2, 3].map((n) => pr({ number: n, author: ['bob', 'carol', 'dave'][n - 1], requested: [['olga', 'carol'], ['olga', 'dave'], ['olga', 'bob']][n - 1] }));
    assert.equal(run(snap({ prs, issues: [issue()] })), null);
  });

  it('task order: p1, then owner tasks, then oldest; only open member tasks without blockers', () => {
    const s = snap({
      issues: [
        issue({ number: 1, createdAt: '2026-11-01T01:00:00Z' }),
        issue({ number: 2, author: 'olga', createdAt: '2026-11-01T05:00:00Z' }),
        issue({ number: 3, labels: ['task', 'p1'], createdAt: '2026-11-01T08:00:00Z' }),
      ],
    });
    assert.equal(run(s).issue, 3);
    assert.equal(run(s, ME, { skip: new Set(['build:3:']) }).issue, 2);
    for (const i of [issue({ author: 'mallory' }), issue({ assignees: ['bob'] }), issue({ labels: ['task', 'blocked'] }), issue({ labels: ['bug'] })]) {
      assert.equal(run(snap({ issues: [i] })), null);
    }
  });
});

it('compares logins case-insensitively', () => {
  const s = snap({ members: ['Olga', 'Alice', 'BOB', 'carol'], prs: [pr({ author: 'Bob', requested: ['ALICE', 'carol'] })] });
  assert.deepEqual(decide(s, 'alice', { now: NOW }), { kind: 'review', pr: 10, sha: 'h2' });
});
