// Escalation with a fake agent: attempt 0 runs on the cheapest model, fails
// its checks, and the retry runs one step up and passes. No model, no container.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { commandChecks } from '../src/agents.mjs';
import { markStopping, runTask } from '../src/task-runner.mjs';
import { DEFAULT_LADDER } from '../src/ladder.mjs';
import { git, removeWorktree } from '../src/worktree.mjs';

const ID = { name: 'swarm-me-core', email: 'swarm-me-core@users.noreply.github.com' };

describe('escalation ladder in the task runner', () => {
  let root, origin, repo, stateDir;
  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-escalate-'));
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

  it('the retry runs on the next model up and the task is submitted', async () => {
    const models = [];
    const notes = [];
    const client = {
      progress: async (_id, b) => { notes.push(b.note); },
      submit: async (_id, b) => ({ submitted: b.headSha }),
      fail: async () => ({}),
    };
    // Checks pass only when the agent wrote good.txt: haiku does not, sonnet does.
    const agent = async ({ task, worktree, model }) => {
      models.push(model);
      if (model !== 'claude-haiku-5-5') fs.writeFileSync(path.join(worktree, 'good.txt'), 'ok\n');
      else fs.writeFileSync(path.join(worktree, 'scratch.txt'), 'nope\n');
      return { tokens: 0, evidence: task.acceptance.map((criterion) => ({ criterion, met: true, detail: 'fake' })) };
    };
    const checks = commandChecks(['node', '-e', "process.exit(require('fs').existsSync('good.txt') ? 0 : 1)"]);
    const base = { id: 'T-0601', title: 'Escalate', department: 'core', size: 'S', paths: ['swarm/x/**'], acceptance: ['works'], pr: null, review: null, holder: null };
    const run = (task) => runTask({
      task, client, manager: 'me-core', identity: ID, stateDir, repoDir: repo, agent, checks,
      openPr: async () => 42, ladder: DEFAULT_LADDER, log: { warn() {} },
    });

    const first = await run({ ...base, attempts: 0 });
    assert.equal(first.status, 'failed', 'cheapest model fails the checks');

    const second = await run({ ...base, attempts: 1 });
    assert.equal(second.status, 'submitted');
    assert.deepEqual(models, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
    assert.ok(notes.some((n) => n.includes('model claude-sonnet-5-5')), 'progress note names the model');
  });

  it('a run killed by a signal or cut short by shutdown is released, not failed (no attempt spent)', async () => {
    const calls = [];
    const client = { progress: async () => ({}), submit: async () => ({}), fail: async (id) => { calls.push(['fail', id]); }, release: async (id, b) => { calls.push(['release', id, b.reason]); } };
    const task = (id) => ({ id, title: 'Interrupted', department: 'core', size: 'S', paths: ['swarm/x/**'], acceptance: ['a'], pr: null, review: null, holder: null, attempts: 2 });
    const run = (id, agent) => runTask({ task: task(id), client, manager: 'me-core', identity: ID, stateDir, repoDir: repo, agent, checks: commandChecks(['node', '-e', '']), openPr: async () => 1, log: { warn() {} } });
    const killed = await run('T-0610', async () => { throw new Error('claude subagent exit 143: '); });
    assert.equal(killed.status, 'released');
    markStopping();
    try {
      const stopped = await run('T-0611', async () => { throw new Error('checks failed'); });
      assert.equal(stopped.status, 'released', 'any failure while stopping is an interruption');
    } finally { markStopping(false); }
    const real = await run('T-0612', async () => { throw new Error('checks failed'); });
    assert.equal(real.status, 'failed');
    assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['release', 'T-0610'], ['release', 'T-0611'], ['fail', 'T-0612']]);
    assert.match(calls[1][2], /^interrupted \(manager stopping\): checks failed/);
  });

  it('a retry overwrites the task branch an earlier attempt pushed without a PR', async () => {
    const client = { progress: async () => ({}), submit: async (_id, b) => ({ submitted: b.headSha }), fail: async (_id, b) => { throw new Error(`unexpected fail: ${b.reason}`); }, release: async () => ({}) };
    const task = { id: 'T-0620', title: 'Retry push', department: 'core', size: 'S', paths: ['swarm/x/**'], acceptance: ['a'], pr: null, review: null, holder: null, attempts: 1 };
    const agent = (text) => async ({ task: t, worktree }) => {
      fs.writeFileSync(path.join(worktree, 'r.txt'), text);
      return { tokens: 0, evidence: t.acceptance.map((criterion) => ({ criterion, met: true, detail: '' })) };
    };
    const run = (text) => runTask({ task, client, manager: 'me-core', identity: ID, stateDir, repoDir: repo, agent: agent(text), checks: commandChecks(['node', '-e', '']), openPr: async () => 7, log: { warn() {} } });
    const first = await run('first attempt\n');
    assert.equal(first.status, 'submitted');
    await removeWorktree(repo, first.worktree, first.branch); // as after a failed attempt: the branch stays on origin only
    const second = await run('second attempt\n');
    assert.equal(second.status, 'submitted', `a plain push would be rejected as non-fast-forward: ${second.reason}`);
    const remote = (await git(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${second.branch}`])).split(/\s+/)[0];
    assert.equal(remote, second.headSha);
  });

  it('fix work with no findings and no changes resubmits the PR head; with findings it still fails', async () => {
    const submits = [];
    const fails = [];
    const client = { progress: async () => ({}), submit: async (_id, b) => { submits.push(b); return {}; }, fail: async (_id, b) => { fails.push(b.reason); }, release: async () => ({}) };
    const base = { id: 'T-0630', title: 'Resubmit', department: 'core', size: 'S', paths: ['swarm/x/**'], acceptance: ['a'], review: null, holder: null, attempts: 0 };
    const evidence = (t) => t.acceptance.map((criterion) => ({ criterion, met: true, detail: '' }));
    const writes = async ({ task, worktree }) => { fs.writeFileSync(path.join(worktree, 'v.txt'), 'v\n'); return { tokens: 0, evidence: evidence(task) }; };
    const noop = async ({ task }) => ({ tokens: 0, evidence: evidence(task) });
    const run = (task, agent) => runTask({ task, client, manager: 'me-core', identity: ID, stateDir, repoDir: repo, agent, checks: commandChecks(['node', '-e', '']), openPr: async () => 9, log: { warn() {} } });
    const first = await run({ ...base, pr: null }, writes);
    await removeWorktree(repo, first.worktree, first.branch);
    const again = await run({ ...base, pr: 9, review: { findings: [] } }, noop);
    assert.deepEqual([again.status, again.resubmitted, again.headSha], ['submitted', true, first.headSha]);
    assert.equal(submits.at(-1).pr, 9);
    await removeWorktree(repo, again.worktree, again.branch);
    const withFindings = await run({ ...base, pr: 9, review: { findings: [{ n: 1, severity: 'major', file: 'v.txt', problem: 'p', fix: 'f' }] } }, noop);
    assert.equal(withFindings.status, 'failed');
    assert.match(fails.at(-1), /agent produced no changes/);
    await removeWorktree(repo, withFindings.worktree, withFindings.branch).catch(() => {});
    // Only "behind main" left (ARCHITECTURE 68): the orchestrator updates the branch, so the head is resubmitted.
    const behindOnly = await run({ ...base, pr: 9, review: { findings: ['#1 blocker branch is 1 commits behind main Fix: Rebase onto origin/main and push.'] } }, noop);
    assert.deepEqual([behindOnly.status, behindOnly.resubmitted], ['submitted', true]);
  });

  it('without a ladder the agent gets no model (commandAgent path unchanged)', async () => {
    let seen = 'unset';
    const client = { progress: async () => ({}), submit: async () => ({}), fail: async () => ({}) };
    const agent = async ({ task, worktree, model }) => {
      seen = model;
      fs.writeFileSync(path.join(worktree, 'f.txt'), 'x\n');
      return { tokens: 0, evidence: task.acceptance.map((criterion) => ({ criterion, met: true, detail: '' })) };
    };
    const task = { id: 'T-0602', title: 'No ladder', department: 'core', size: 'S', paths: ['swarm/x/**'], acceptance: ['a'], pr: null, review: null, holder: null, attempts: 0 };
    const r = await runTask({ task, client, manager: 'me-core', identity: ID, stateDir, repoDir: repo, agent, checks: commandChecks(['node', '-e', '']), openPr: async () => 1, log: { warn() {} } });
    assert.equal(r.status, 'submitted');
    assert.equal(seen, null);
  });
});
