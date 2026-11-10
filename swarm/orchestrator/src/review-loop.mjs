// Review loop. Submitted tasks go through the machine gate, then the review
// model. A pass arms auto-merge pinned to the reviewed head. A fail sends the
// task back to the manager that submitted it (changes_requested), or to a
// person (needs-human). in_review tasks are reconciled until their PR merges.
// Every step runs in one queue, so repo writes are serialised.
import { machineGate } from './gates.mjs';
import { ReviewError, runReview } from './reviewer.mjs';

const MAX_FINDING = 1000;
const MAX_REASON = 300;

/** One review finding as the task stores it: a plain string, at most 1000 characters. */
export function formatFinding(f) {
  const where = f.file ? `${f.file}: ` : '';
  return `#${f.n} ${f.severity} ${where}${f.problem} Fix: ${f.fix}`.slice(0, MAX_FINDING);
}

const short = (sha) => String(sha ?? '').slice(0, 7);

// How long a submitted task waits for CI to start and finish before the gate treats it as a blocker.
export const CI_WAIT_MS = 30 * 60_000;
// How long a requested branch update may take to show a new head before the gate reports the branch as behind.
export const UPDATE_WAIT_MS = 10 * 60_000;

export function createReviewLoop({ store, gh, callModel, policy, departments, promptText, guard = null, log = console, clock = Date }) {
  const contracts = departments.contracts ?? [];
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function review(task) {
    const id = task.id;
    // CI still running (or not started) on the submitted head: wait as submitted, spend no round.
    // Found live: a pending check was a blocker, so the fix agent got nothing to fix and the task failed.
    const head = await gh.pr(task.pr);
    if (head.state === 'OPEN') {
      // A branch that is only behind main is brought up to date here, without a review round (ARCHITECTURE 68).
      // A conflict makes GitHub refuse the update; the gate then sends it back as a blocker, as before.
      const pending = task.review.update;
      if (pending) {
        if (head.headSha !== task.review.headSha) {
          store.adoptUpdatedHead(id, head.headSha);
          log.info?.(`[review] ${id} PR #${task.pr} updated from main: ${short(pending.from)} -> ${short(head.headSha)}`);
          return null;
        }
        if (clock.now() - Date.parse(pending.at) < UPDATE_WAIT_MS) return null;
      } else if (await updateFromMain(task, head.headSha)) return null;
      const ci = (await gh.checks(head.headSha)).find((c) => c.name === 'check');
      const submittedAt = Math.max(
        Date.parse([...(task.history ?? [])].reverse().find((h) => h.to === 'submitted')?.at ?? task.updatedAt),
        task.review.updatedAt ? Date.parse(task.review.updatedAt) : 0,
      );
      if ((!ci || ci.conclusion === 'pending') && clock.now() - submittedAt < CI_WAIT_MS) return null;
    }
    store.startReview(id);
    const pr = await gh.pr(task.pr);
    if (pr.state === 'MERGED') return store.markMerged(id, `merged PR #${pr.number} before review`);
    if (pr.state !== 'OPEN') return store.needsHuman(id, `PR #${pr.number} is ${pr.state} before review`);

    const changes = await gh.fileChanges(task.pr);
    const files = changes.map((c) => c.filename);
    const checks = await gh.checks(pr.headSha);
    const behindBy = await gh.behindBy(pr.headSha);
    const gate = machineGate({ task, pr: { ...pr, files, changes }, checks, behindBy, submittedHeadSha: task.review.headSha, policy });
    if (!gate.ok) return store.requestChanges(id, gate.findings.map(formatFinding));

    try {
      const verdict = await runReview({ task, diff: await gh.diff(task.pr), policy, contracts, callModel, promptText });
      if (verdict.verdict === 'changes_requested') return store.requestChanges(id, verdict.findings.map(formatFinding));
    } catch (err) {
      if (err instanceof ReviewError) return store.needsHuman(id, `review failed: ${err.message}`.slice(0, MAX_REASON));
      throw err;
    }

    if (gate.humanReview.length > 0) return store.needsHuman(id, `human review required: ${gate.humanReview.join(', ')}`.slice(0, MAX_REASON));
    return merge(task, pr.headSha);
  }

  /** Asks GitHub to update a branch that is behind main. True when the update was accepted. */
  async function updateFromMain(task, headSha) {
    const behind = await gh.behindBy(headSha);
    if (behind === 0) return false;
    try {
      await gh.updateBranch(task.pr, headSha);
    } catch (err) {
      log.info?.(`[review] ${task.id} PR #${task.pr} branch update refused: ${err.message}`);
      return false;
    }
    store.branchUpdateRequested(task.id, behind);
    log.info?.(`[review] ${task.id} PR #${task.pr} is ${behind} commits behind main: update requested`);
    return true;
  }

  async function merge(task, headSha) {
    // Re-check right before arming: main may have moved while the model reviewed. Update and review the
    // new head again; only a branch GitHub cannot update goes back to the manager.
    if (await updateFromMain(task, headSha)) return store.getTask(task.id);
    const behind = await gh.behindBy(headSha);
    if (behind > 0) {
      return store.requestChanges(task.id, [formatFinding({
        n: 1, severity: 'blocker', file: '', problem: `branch is ${behind} commits behind main after review`, fix: 'Rebase onto origin/main and push.',
      })]);
    }
    await gh.enableAutoMerge(task.pr, headSha);
    log.info?.(`[review] ${task.id} PR #${task.pr} auto-merge armed at ${short(headSha)}`);
    return store.getTask(task.id);
  }

  async function reconcile(task) {
    const pr = await gh.pr(task.pr);
    if (pr.state === 'MERGED') return store.markMerged(task.id, `merged PR #${pr.number} at ${short(pr.mergeCommit)}`);
    if (pr.state === 'CLOSED') return store.needsHuman(task.id, `PR #${pr.number} closed without merge`);
    if (pr.headSha !== task.review.headSha) {
      return store.needsHuman(task.id, `head moved during review: ${short(task.review.headSha)} -> ${short(pr.headSha)}`);
    }
    if (!pr.autoMergeEnabled) return store.needsHuman(task.id, `auto-merge is no longer armed on PR #${pr.number}`);
    return null;
  }

  /** Runs one step if the task is still in the expected state. Unexpected errors go to needs-human. */
  async function step(id, from, fn) {
    if (store.getTask(id).status !== from) return null;
    try {
      return await fn(store.getTask(id));
    } catch (err) {
      log.error?.(`[review] ${id}: ${err.message}`);
      if (store.getTask(id).status === 'in_review') return store.needsHuman(id, `review error: ${err.message}`.slice(0, MAX_REASON));
      return null;
    }
  }

  /** One pass over submitted and in_review tasks. */
  async function tick() {
    const results = [];
    for (const { id } of store.listTasks({ status: 'submitted' })) {
      // Paused or main red: the task waits as submitted (no model call, nothing armed). Already armed PRs are not disarmed.
      if (guard?.mergeBlock(store.getTask(id))) continue;
      results.push(await serial(() => step(id, 'submitted', review)));
    }
    for (const { id } of store.listTasks({ status: 'in_review' })) {
      results.push(await serial(() => step(id, 'in_review', reconcile)));
    }
    return results.filter(Boolean);
  }

  return { tick };
}
