import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore } from '../src/store.mjs';
import { UPDATE_WAIT_MS, createReviewLoop, formatFinding } from '../src/review-loop.mjs';

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const MERGE = '3'.repeat(40);
const policy = {
  limits: { maxChangedLines: { S: 400, M: 1000 }, maxReviewRounds: 3 },
  humanReview: ['.github/**'],
  models: { claude: ['claude-opus-5-5', 'claude-sonnet-5-5'] },
  reviewModel: { default: 'claude-sonnet-5-5', large: 'claude-opus-5-5' },
};
const departments = { contracts: ['swarm/protocol/**'] };
const APPROVE = JSON.stringify({ verdict: 'approve', summary: 'ok', findings: [] });
const CHANGES = JSON.stringify({ verdict: 'changes_requested', summary: 'fix', findings: [{ severity: 'major', file: 'swarm/orchestrator/src/t1.mjs', problem: 'off by one', fix: 'use <=' }] });

function setup({ maxReviewRounds = 3 } = {}) {
  const clock = { now: () => Date.now() };
  const store = openStore({ clock, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds });
  store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
  store.createTask({
    id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'Thing', department: 'core', priority: 'p1', size: 'S',
    paths: ['swarm/orchestrator/src/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 },
  });
  const gh = {
    state: { head: H1, prState: 'OPEN', files: ['swarm/orchestrator/src/t1.mjs'], ci: 'success', behind: [0], armed: false, armFails: false, mergeCommit: null, mergeHead: null },
    calls: { model: 0 },
    async pr() {
      const s = this.state;
      return { number: 9, baseRefName: 'main', headSha: s.head, state: s.prState, mergeCommit: s.mergeCommit, autoMergeEnabled: s.armed, additions: 10, deletions: 0 };
    },
    async fileChanges() { return this.state.files.map((filename) => ({ filename, status: 'modified' })); },
    async checks(sha) { return [{ name: 'check', headSha: sha, conclusion: this.state.ci }]; },
    async behindBy() { const q = this.state.behind; return q.length > 1 ? q.shift() : q[0]; },
    async diff() { return 'diff --git a/x b/x\n+ok\n'; },
    async updateBranch(n, sha) {
      this.calls.update = [...(this.calls.update ?? []), [n, sha]];
      if (this.state.updateFails) throw new Error('HTTP 422: merge conflict');
    },
    async enableAutoMerge(n, sha) {
      if (this.state.armFails) throw new Error('auto-merge did not arm on PR #9');
      this.state.armed = true;
      this.state.mergeHead = sha;
    },
  };
  const callModel = (reply) => async () => { gh.calls.model += 1; return reply; };
  return { store, gh, callModel, clock };
}

/** Lease, progress and submit T-0001 at `sha` as manager me-core. */
function submit(store, sha = H1) {
  store.lease({ department: 'core', slots: 1, manager: 'me-core' });
  store.progress({ id: 'T-0001', manager: 'me-core', phase: 'checks', note: '', tokens: 1 });
  return store.submit({ id: 'T-0001', manager: 'me-core', pr: 9, headSha: sha, evidence: [{ criterion: 'works', met: true, detail: 'ok' }] });
}

const loopFor = (ctx, reply = APPROVE, extra = {}) => createReviewLoop({
  store: ctx.store, gh: ctx.gh, callModel: ctx.callModel(reply), policy, departments, promptText: 'REVIEW', log: { error() {}, info() {} }, ...extra,
});

describe('review loop', () => {
  it('approves a clean PR, arms auto-merge on the reviewed head, then marks it merged', async () => {
    const ctx = setup();
    submit(ctx.store);
    const loop = loopFor(ctx);
    await loop.tick();
    assert.equal(ctx.store.getTask('T-0001').status, 'in_review');
    assert.equal(ctx.gh.state.armed, true);
    assert.equal(ctx.gh.state.mergeHead, H1, 'auto-merge pinned to the reviewed head');
    assert.equal(ctx.gh.calls.model, 1);

    ctx.gh.state.prState = 'MERGED';
    ctx.gh.state.mergeCommit = MERGE;
    await loop.tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'merged');
    assert.match(t.history.at(-1).reason, /merged PR #9/);
  });

  it('waits while CI is pending or not started: the task stays submitted, no round spent, no model call', async () => {
    const ctx = setup();
    submit(ctx.store);
    ctx.gh.state.ci = 'pending';
    const loop = loopFor(ctx);
    await loop.tick();
    let t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'submitted', 'found live: a pending check sent the task back as changes_requested');
    assert.equal(t.review.rounds ?? 0, 0);
    assert.equal(ctx.gh.calls.model, 0);
    ctx.gh.checks = async () => [];
    await loop.tick();
    assert.equal(ctx.store.getTask('T-0001').status, 'submitted', 'no check run yet also waits');
    ctx.gh.checks = async (sha) => [{ name: 'check', headSha: sha, conclusion: 'success' }];
    await loop.tick();
    t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'in_review');
    assert.equal(ctx.gh.state.armed, true);
  });

  it('after the CI wait limit, a still-pending check goes through the gate as a blocker', async () => {
    const ctx = setup();
    submit(ctx.store);
    ctx.gh.state.ci = 'pending';
    const now = Date.now();
    const loop = loopFor(ctx, APPROVE, { clock: { now: () => now + 31 * 60_000 } });
    await loop.tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'changes_requested');
    assert.match(t.review.findings[0], /pending/);
  });

  it('sends an out-of-scope PR back with numbered findings and never calls the model', async () => {
    const ctx = setup();
    ctx.gh.state.files = ['swarm/orchestrator/src/t1.mjs', 'docs/readme.md'];
    submit(ctx.store);
    await loopFor(ctx).tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'changes_requested');
    assert.equal(t.review.findings.length, 1);
    assert.match(t.review.findings[0], /^#1 blocker docs\/readme\.md: file outside task paths: docs\/readme\.md Fix: /);
    assert.equal(ctx.gh.calls.model, 0);
    assert.equal(t.holder, 'me-core', 'holder kept for the fix');
  });

  it('turns a model changes_requested verdict into a changes_requested task', async () => {
    const ctx = setup();
    submit(ctx.store);
    await loopFor(ctx, CHANGES).tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'changes_requested');
    assert.match(t.review.findings[0], /^#1 major swarm\/orchestrator\/src\/t1\.mjs: off by one Fix: use <=/);
  });

  it('after maxReviewRounds, a second rejection goes to needs-human', async () => {
    const ctx = setup({ maxReviewRounds: 1 });
    submit(ctx.store);
    await loopFor(ctx, CHANGES).tick();
    assert.equal(ctx.store.getTask('T-0001').status, 'needs-human');
  });

  it('a .github path needs a person, so auto-merge is not armed', async () => {
    const ctx = setup();
    ctx.store.cancel('T-0001', 'replaced in test');
    ctx.store.createTask({
      id: 'T-0002', epicId: 'E-0001', repo: 'o/r', title: 'CI', department: 'core', priority: 'p1', size: 'S',
      paths: ['.github/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 },
    });
    ctx.store.lease({ department: 'core', slots: 1, manager: 'me-core' });
    ctx.store.progress({ id: 'T-0002', manager: 'me-core', phase: 'checks', note: '', tokens: 1 });
    ctx.gh.state.files = ['.github/workflows/x.yml'];
    ctx.store.submit({ id: 'T-0002', manager: 'me-core', pr: 9, headSha: H1, evidence: [{ criterion: 'works', met: true, detail: 'ok' }] });
    await loopFor(ctx).tick();
    const t = ctx.store.getTask('T-0002');
    assert.equal(t.status, 'needs-human');
    assert.match(t.history.at(-1).reason, /human review required: \.github\/workflows\/x\.yml/);
    assert.equal(ctx.gh.state.armed, false);
  });

  it('a model reply that breaks the schema goes to needs-human, not a silent pass', async () => {
    const ctx = setup();
    submit(ctx.store);
    await loopFor(ctx, 'Looks good to me!').tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'needs-human');
    assert.match(t.history.at(-1).reason, /review failed: review output is not valid JSON/);
  });

  it('when auto-merge does not arm, the task goes to needs-human', async () => {
    const ctx = setup();
    ctx.gh.state.armFails = true;
    submit(ctx.store);
    await loopFor(ctx).tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'needs-human');
    assert.match(t.history.at(-1).reason, /review error: auto-merge did not arm/);
  });

  it('a branch behind main is updated by the orchestrator and reviewed on the new head, without a round (ARCHITECTURE 68)', async () => {
    const ctx = setup();
    ctx.gh.state.behind = [3, 0];
    submit(ctx.store);
    const loop = loopFor(ctx);
    await loop.tick();
    let t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'submitted');
    assert.deepEqual(ctx.gh.calls.update, [[9, H1]]);
    assert.equal(t.review.update.behind, 3);
    assert.equal(ctx.gh.calls.model, 0);
    await loop.tick();
    assert.equal(ctx.store.getTask('T-0001').status, 'submitted', 'waits while GitHub has not moved the head');
    ctx.gh.state.head = H2;
    await loop.tick();
    t = ctx.store.getTask('T-0001');
    assert.equal(t.review.headSha, H2);
    assert.equal(t.review.update, null);
    await loop.tick();
    t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'in_review');
    assert.equal(t.review.rounds, 0);
    assert.equal(ctx.gh.state.mergeHead, H2);
  });

  it('a branch GitHub cannot update (conflict) goes back to the manager as a blocker', async () => {
    const ctx = setup();
    ctx.gh.state.behind = [3];
    ctx.gh.state.updateFails = true;
    submit(ctx.store);
    await loopFor(ctx).tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'changes_requested');
    assert.match(t.review.findings[0], /3 commits behind main/);
  });

  it('an update that never shows a new head falls through to the gate after UPDATE_WAIT_MS', async () => {
    const ctx = setup();
    ctx.gh.state.behind = [3];
    submit(ctx.store);
    await loopFor(ctx).tick();
    assert.equal(ctx.store.getTask('T-0001').status, 'submitted');
    await loopFor(ctx, APPROVE, { clock: { now: () => Date.now() + UPDATE_WAIT_MS + 1 } }).tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'changes_requested');
    assert.equal(ctx.gh.calls.update.length, 1, 'asked GitHub once');
  });

  it('a branch that falls behind main during review is updated and reviewed again, not sent back', async () => {
    const ctx = setup();
    ctx.gh.state.behind = [0, 0, 2];
    submit(ctx.store);
    await loopFor(ctx).tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'submitted');
    assert.equal(t.review.rounds, 0);
    assert.equal(t.review.update.behind, 2);
    assert.match(t.history.at(-1).reason, /2 commits behind main after review/);
    assert.equal(ctx.gh.state.armed, false);
  });

  it('a branch that falls behind during review and cannot be updated is sent back before arming', async () => {
    const ctx = setup();
    ctx.gh.state.behind = [0, 0, 2];
    ctx.gh.state.updateFails = true;
    submit(ctx.store);
    await loopFor(ctx).tick();
    const t = ctx.store.getTask('T-0001');
    assert.equal(t.status, 'changes_requested');
    assert.match(t.review.findings[0], /2 commits behind main after review/);
    assert.equal(ctx.gh.state.armed, false);
  });

  it('a head pushed during review, a closed PR, or auto-merge disarmed each go to needs-human', async () => {
    const moved = setup();
    submit(moved.store);
    const loop1 = loopFor(moved);
    await loop1.tick();
    moved.gh.state.head = H2;
    await loop1.tick();
    assert.match(moved.store.getTask('T-0001').history.at(-1).reason, /head moved during review/);

    const closed = setup();
    submit(closed.store);
    const loop2 = loopFor(closed);
    await loop2.tick();
    closed.gh.state.prState = 'CLOSED';
    await loop2.tick();
    assert.match(closed.store.getTask('T-0001').history.at(-1).reason, /closed without merge/);

    const disarmed = setup();
    submit(disarmed.store);
    const loop3 = loopFor(disarmed);
    await loop3.tick();
    disarmed.gh.state.armed = false;
    await loop3.tick();
    assert.match(disarmed.store.getTask('T-0001').history.at(-1).reason, /no longer armed/);
  });

  it('after changes_requested, only the submitting manager gets the fix back, first, in progress', async () => {
    const ctx = setup();
    ctx.gh.state.files = ['docs/readme.md'];
    submit(ctx.store);
    await loopFor(ctx).tick();
    assert.equal(ctx.store.getTask('T-0001').status, 'changes_requested');

    assert.deepEqual(ctx.store.leaseFixes({ department: 'core', manager: 'someone-else' }), []);
    const [fix] = ctx.store.leaseFixes({ department: 'core', manager: 'me-core' });
    assert.equal(fix.id, 'T-0001');
    assert.equal(fix.status, 'in_progress');
    assert.equal(fix.lease.manager, 'me-core');
  });

  it('formatFinding keeps the file, the problem and the fix in one string under 1000 characters', () => {
    const s = formatFinding({ n: 2, severity: 'minor', file: 'a.mjs', problem: 'p'.repeat(2000), fix: 'f' });
    assert.ok(s.length <= 1000);
    assert.match(s, /^#2 minor a\.mjs: p/);
  });
});
