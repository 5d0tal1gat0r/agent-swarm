// Runs one leased task end to end on this host.
// New task: worktree on a new branch -> agent -> checks -> commit -> rebase -> push -> PR -> submit.
// Fix task (pr is set; the orchestrator returned it as changes_requested):
// worktree on the pushed branch -> agent (gets the review findings) -> checks -> commit
// -> rebase -> force-with-lease push -> submit on the same PR.
// Any failure reports `fail` (spends an attempt) and removes the worktree. A run cut short by the
// manager shutting down, or by a signal to the subagent (exit 143/130), reports `release` instead:
// the task goes back to the queue without spending an attempt (ARCHITECTURE 64).
import { modelForAttempt } from './ladder.mjs';
import { attachWorktree, branchName, commitAll, createWorktree, git, push, pushForce, rebase, remoteSha, removeWorktree } from './worktree.mjs';
import { randomUUID } from 'node:crypto';

let stopping = false;
/** Called on SIGTERM/SIGINT: runs that fail from now on were interrupted, not wrong. */
export function markStopping(value = true) { stopping = value; }
const INTERRUPTED = /\bexit (143|130)\b|\bSIGTERM\b|\bSIGINT\b/;

export function prBody(task, evidence) {
  const rows = evidence.map((e) => `- [${e.met ? 'x' : ' '}] ${e.criterion}${e.detail ? ` (${e.detail})` : ''}`).join('\n');
  return `Task ${task.id} (department ${task.department}, ${task.size}).\n\nAcceptance:\n${rows}\n\nSubmitted by the swarm manager.`;
}

async function prepare({ task, repoDir, stateDir }) {
  if (task.pr == null) {
    const wt = await createWorktree({ repoDir, stateDir, taskId: task.id, department: task.department, title: task.title });
    return { ...wt, fix: false, expectedSha: null };
  }
  const branch = branchName(task.department, task.id, task.title);
  const wt = await attachWorktree({ repoDir, stateDir, taskId: task.id, branch });
  return { ...wt, fix: true, expectedSha: wt.sha };
}

/** Apply queued safe directives only after a model turn has completed. */
export async function applyDirectiveCheckpoints({
  task, assignmentId, worktree, initialResult, journal, agent, sessionReporter = null,
  maxContinuations = 5, idFactory = () => `run-${task.id}-continuation-${randomUUID().slice(0, 8)}`, log = console,
}) {
  let result = initialResult;
  let continuations = 0;
  const report = async (body) => {
    try { await sessionReporter?.(body); } catch (error) { log.warn?.(`[task] ${task.id} session report failed: ${error.message}`); }
  };
  while (continuations < maxContinuations) {
    const directives = journal.pendingFor({ taskId: task.id, assignmentId });
    if (!directives.length) return result;
    continuations += 1;
    const sessionId = idFactory();
    const startedAt = new Date().toISOString();
    const session = {
      id: sessionId, assignmentId, agentKind: result.agentKind ?? 'manager', model: result.model ?? null,
      status: 'running', phase: 'continuation', startedAt, updatedAt: startedAt,
      inputTokens: 0, outputTokens: 0, lastEventSeq: 0,
    };
    await report({ operation: 'start', session });
    try {
      const next = await agent({
        task, worktree, initialEvidence: result.evidence ?? null,
        continuation: {
          assignmentId,
          priorSummary: `Prior turn completed with ${result.subtasks ?? 1} subtask(s) and ${result.tokens ?? 0} billable tokens.`,
          directives,
          sessionId,
        },
      });
      result = {
        ...next,
        tokens: Number(result.tokens ?? 0) + Number(next.tokens ?? 0),
        evidence: next.evidence ?? result.evidence ?? [],
        assignmentId,
        sessionId,
      };
      const finished = { ...session, status: 'completed', updatedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
      await report({ operation: 'finish', session: finished });
      for (const directive of directives) {
        await journal.markApplied(directive.id, { result: `continued in ${sessionId}`, replacementSessionId: sessionId });
      }
    } catch (error) {
      const failed = { ...session, status: 'failed', updatedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
      await report({ operation: 'finish', session: failed });
      for (const directive of directives) await journal.markFailed(directive.id, { result: String(error.message ?? error).slice(0, 2000) }).catch(() => {});
      throw error;
    }
  }
  if (journal.pendingFor({ taskId: task.id, assignmentId }).length) {
    log.warn?.(`[task] ${task.id} has directives deferred after ${maxContinuations} continuations`);
    return { ...result, directivesDeferred: true };
  }
  return result;
}

export async function runTask({ task, client, manager, identity, stateDir, repoDir, agent, checks, openPr, ladder = null, directiveJournal = null, sessionReporter = null, agentKind = 'manager', log = console }) {
  let wt = null;
  const id = task.id;
  try {
    wt = await prepare({ task, repoDir, stateDir });
    const model = ladder ? modelForAttempt(ladder, task.attempts) : null;
    await client.progress(id, { manager, phase: 'planning', note: `worktree ${wt.branch}${wt.fix ? ' (fix)' : ''}${model ? ` model ${model}` : ''}`, tokens: 0 });

    // A finding that only says the branch is behind main is the orchestrator's to fix (ARCHITECTURE 68).
    const findings = (task.review?.findings ?? []).filter((f) => !/commits behind main/.test(f));
    const assignmentId = task.assignmentId ?? `agent-${task.id}-implementer-main`;
    const initialSessionId = `run-${task.id}-${task.attempts + 1}-${randomUUID().slice(0, 8)}`;
    const initialStartedAt = new Date().toISOString();
    const initialSession = {
      id: initialSessionId, assignmentId, agentKind, model, status: 'running', phase: 'implement',
      startedAt: initialStartedAt, updatedAt: initialStartedAt, inputTokens: 0, outputTokens: 0, lastEventSeq: 0,
    };
    await sessionReporter?.({ operation: 'start', session: initialSession }).catch((err) => log.warn?.(`[task] ${id} session start not reported: ${err.message}`));
    const control = {};
    const unregisterControl = directiveJournal?.register?.(task.id, control) ?? (() => {});
    let result;
    let initialStatus = 'completed';
    try {
      result = await agent({ task, worktree: wt.dir, findings, model, assignmentId, sessionId: initialSessionId, control });
    } catch (error) {
      if (!control.interrupted && !control.stopped) throw error;
      initialStatus = 'interrupted';
      await directiveJournal.poll();
      const pending = directiveJournal.pendingFor({ taskId: task.id, assignmentId });
      if (control.stopped) {
        for (const item of pending.filter((directive) => directive.kind === 'stop')) {
          await directiveJournal.markApplied(item.id, { result: 'run stopped at owner checkpoint', replacementSessionId: null });
        }
        unregisterControl();
        const reason = 'stopped by owner directive';
        const stoppedAt = new Date().toISOString();
        await sessionReporter?.({ operation: 'finish', session: {
          ...initialSession, status: 'interrupted', updatedAt: stoppedAt, endedAt: stoppedAt,
        } }).catch((err) => log.warn?.(`[task] ${id} stopped session not reported: ${err.message}`));
        await client.release(id, { manager, reason });
        return { status: 'released', reason, worktree: wt.dir, preserved: true };
      }
      control.interrupted = false;
      result = { tokens: 0, subtasks: 1, evidence: null, assignmentId, agentKind, model };
    }
    const initialEndedAt = new Date().toISOString();
    await sessionReporter?.({ operation: 'finish', session: {
      ...initialSession, status: initialStatus, updatedAt: initialEndedAt, endedAt: initialEndedAt,
    } }).catch((err) => log.warn?.(`[task] ${id} session finish not reported: ${err.message}`));
    if (directiveJournal) {
      await directiveJournal.poll();
      const stableAssignmentId = result.assignmentId ?? assignmentId;
      result = await applyDirectiveCheckpoints({
        task, assignmentId: stableAssignmentId, worktree: wt.dir, initialResult: result, journal: directiveJournal, sessionReporter, log,
        agent: ({ continuation, initialEvidence }) => agent({ task, worktree: wt.dir, findings, model, continuation, initialEvidence, control }),
      });
    }
    unregisterControl();
    await client.progress(id, { manager, phase: 'subagents', note: result.subtasks > 1 ? `agent finished, ${result.subtasks} subtasks ran` : 'agent finished', tokens: result.tokens });

    await client.progress(id, { manager, phase: 'checks', note: 'running checks', tokens: 0 });
    const check = await checks(wt.dir);
    if (!check.ok) throw new Error(check.summary);

    const sha = await commitAll(wt.dir, `${id}: ${task.title}`, identity);
    if (!sha && wt.fix && !findings.length) {
      // Fix work with no findings (a person resolved a review that failed, not the code): the PR as it
      // stands goes back to review (ARCHITECTURE 66).
      const headSha = await git(wt.dir, ['rev-parse', 'HEAD']);
      await client.submit(id, { manager, pr: task.pr, headSha, evidence: result.evidence });
      return { status: 'submitted', pr: task.pr, headSha, branch: wt.branch, worktree: wt.dir, fix: true, resubmitted: true };
    }
    if (!sha) throw new Error('agent produced no changes');
    await rebase(wt.dir, identity);

    await client.progress(id, { manager, phase: 'pr', note: `pushing ${wt.branch}`, tokens: 0 });
    if (wt.fix) await pushForce(wt.dir, wt.branch, wt.expectedSha);
    else {
      // A new task has no PR, so its branch belongs to the swarm. An earlier attempt may have pushed
      // it and stopped before the PR (E-0003 T-0005): overwrite it, leased to the sha just read.
      const old = await remoteSha(wt.dir, wt.branch);
      if (old) await pushForce(wt.dir, wt.branch, old);
      else await push(wt.dir, wt.branch);
    }
    const headSha = await git(wt.dir, ['rev-parse', 'HEAD']);
    const pr = wt.fix ? task.pr : await openPr({ cwd: repoDir, branch: wt.branch, title: `${id}: ${task.title}`, body: prBody(task, result.evidence) });

    await client.submit(id, { manager, pr, headSha, evidence: result.evidence });
    return { status: 'submitted', pr, headSha, branch: wt.branch, worktree: wt.dir, fix: wt.fix };
  } catch (err) {
    const reason = String(err.message ?? err).slice(0, 500);
    if (stopping || INTERRUPTED.test(reason)) {
      log.warn?.(`[task] ${id} interrupted, released without spending an attempt: ${reason}`);
      await client.release(id, { manager, reason: `interrupted${stopping ? ' (manager stopping)' : ''}: ${reason}`.slice(0, 500) }).catch((e) => log.warn?.(`[task] could not release: ${e.message}`));
      if (wt) await removeWorktree(repoDir, wt.dir, wt.branch).catch(() => {});
      return { status: 'released', reason };
    }
    log.warn?.(`[task] ${id} failed: ${reason}`);
    await client.fail(id, { manager, reason }).catch((e) => log.warn?.(`[task] could not report failure: ${e.message}`));
    if (wt) await removeWorktree(repoDir, wt.dir, wt.branch).catch(() => {});
    return { status: 'failed', reason };
  }
}
