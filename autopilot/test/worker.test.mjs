import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Ledger } from '../src/ledger.mjs';
import { Worker } from '../src/worker.mjs';

const quiet = { info() {}, warn() {}, error() {} };
const tmpLedger = () => new Ledger(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ap-w-')), 'ledger.jsonl'));
const bus = () => ({ said: [], say(m) { this.said.push(m); }, status() {}, close() {} });

function snap(over = {}) {
  return { members: ['alice', 'bob', 'carol'], policy: {}, protectedMain: false, paused: false, issues: [], prs: [], ...over };
}

function fakeGh(snapshot, over = {}) {
  const calls = [];
  return {
    calls,
    snapshot: async () => snapshot,
    issue: async (n) => ({ number: n, title: 'Add dark mode!', body: 'please' }),
    releaseIssue: async (n) => calls.push(['release', n]),
    comment: async (k, n) => calls.push(['comment', k, n]),
    mergePr: async (n, sha) => calls.push(['merge', n, sha]),
    addLabel: async (k, n, l) => calls.push(['label', n, l]),
    requestReviewers: async (n, r) => calls.push(['reviewers', n, r]),
    enableAutoMerge: async (n) => calls.push(['automerge', n]),
    ...over,
  };
}

const config = { member: 'alice', agent: 'claude', repo: 'o/r', maxJobsPerDay: 2, maxMinutesPerJob: 1, pollSeconds: 60 };
const task = { number: 7, title: 'Add dark mode!', author: 'bob', labels: ['task'], assignees: [], createdAt: '2026-11-01T00:00:00Z' };

describe('Worker.cycle', () => {
  it('dry run decides without side effects', async () => {
    const gh = fakeGh(snap({ issues: [task] }));
    const w = new Worker(config, { gh, bus: bus(), ledger: tmpLedger(), log: quiet, onlineFn: async () => [], runJobFn: async () => assert.fail('ran') });
    assert.deepEqual(await w.cycle({ dryRun: true }), { kind: 'build', issue: 7 });
    assert.deepEqual(gh.calls, []);
  });

  it('build: runs the agent on a named branch, releases on failure', async () => {
    const gh = fakeGh(snap({ issues: [task] }));
    const runs = [];
    const w = new Worker(config, { gh, bus: bus(), ledger: tmpLedger(), log: quiet, onlineFn: async () => [], runJobFn: async (job, cfg, vars) => (runs.push(vars), { ok: false, code: 1 }) });
    await w.cycle();
    assert.equal(runs[0].branch, 'alice/issue-7-add-dark-mode');
    assert.ok(gh.calls.some((c) => c[0] === 'release' && c[1] === 7));
  });

  it('a failed job is not retried within the backoff window', async () => {
    const pr = { number: 3, title: 'x', author: 'bob', headSha: 's', baseRef: 'main', requested: ['alice', 'carol'], autoMerge: false, draft: false, labels: [], linkedIssue: null, checks: 'success', mergeable: true, updatedAt: '2026-11-01T00:00:00Z', reviews: [] };
    let runs = 0;
    const w = new Worker(config, { gh: fakeGh(snap({ prs: [pr] })), bus: bus(), ledger: tmpLedger(), log: quiet, onlineFn: async () => [], runJobFn: async () => (runs++, { ok: false, code: 1 }) });
    await w.cycle();
    assert.equal(await w.cycle(), null);
    assert.equal(runs, 1);
  });

  it('stops starting agent jobs at the daily limit', async () => {
    const ledger = tmpLedger();
    ledger.record({ kind: 'review', pr: 1, sha: 'a' }, true);
    ledger.record({ kind: 'review', pr: 2, sha: 'a' }, true);
    const w = new Worker(config, { gh: fakeGh(snap({ issues: [task] })), bus: bus(), ledger, log: quiet, onlineFn: async () => [], runJobFn: async () => assert.fail('ran') });
    assert.equal(await w.cycle(), null);
  });

  it('merge calls gh with the approved head sha', async () => {
    const reviews = ['bob', 'carol'].map((a) => ({ author: a, state: 'APPROVED', commitId: 'h', submittedAt: 't' }));
    const pr = { number: 4, title: 'x', author: 'alice', headSha: 'h', baseRef: 'main', requested: [], autoMerge: false, draft: false, labels: [], linkedIssue: 1, checks: 'success', mergeable: true, updatedAt: 't', reviews };
    const gh = fakeGh(snap({ prs: [pr] }));
    const w = new Worker(config, { gh, bus: bus(), ledger: tmpLedger(), log: quiet, onlineFn: async () => [] });
    await w.cycle();
    assert.deepEqual(gh.calls, [['merge', 4, 'h']]);
  });

  it('triage requests reviewers and enables auto-merge on a protected repo', async () => {
    const pr = { number: 5, title: 'x', author: 'bob', headSha: 'h', baseRef: 'main', requested: [], autoMerge: false, draft: false, labels: [], linkedIssue: null, checks: 'success', mergeable: true, updatedAt: 't', reviews: [] };
    const gh = fakeGh(snap({ protectedMain: true, prs: [pr] }));
    const w = new Worker(config, { gh, bus: bus(), ledger: tmpLedger(), log: quiet, onlineFn: async () => [] });
    await w.cycle();
    const [reviewers, automerge] = gh.calls;
    assert.equal(reviewers[0], 'reviewers');
    assert.equal(reviewers[2].length, 1, 'one reviewer (default approvalsRequired is 1)');
    assert.ok(!reviewers[2].includes('bob'), 'never the author');
    assert.deepEqual(automerge, ['automerge', 5]);
  });

});
