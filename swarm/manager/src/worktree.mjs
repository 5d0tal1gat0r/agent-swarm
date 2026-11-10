// Git worktrees per task. Every git write runs on the host (never in the
// container). Commands use argument arrays and no shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { assertSafePush } from './git-safety.mjs';
import { withRepoLock } from './repo-lock.mjs';

const run = promisify(execFile);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0' };

export async function git(cwd, args, { identity } = {}) {
  const prefix = identity ? ['-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`] : [];
  try {
    const { stdout } = await run('git', [...prefix, ...args], { cwd, env: GIT_ENV, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (err) {
    throw new Error(`git ${args[0]} failed: ${(err.stderr || err.message).trim().split('\n').slice(-3).join(' | ')}`);
  }
}

/** Lower-case, dash-separated, at most 40 characters. Safe as a path segment. */
export function slugify(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  if (!slug) throw new Error('title produces an empty slug');
  return slug;
}

export function branchName(department, taskId, title) {
  return `${department}/${taskId.toLowerCase()}-${slugify(title)}`;
}

export function worktreePath(stateDir, taskId) {
  if (!/^T-[0-9]{4,}$/.test(taskId)) throw new Error(`bad task id ${taskId}`);
  return path.join(stateDir, 'wt', taskId);
}

/** Runs fn under the lock of the clone that `dir` belongs to (all worktrees of one clone share it). */
async function locked(dir, fn, run = git) {
  const common = await run(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return withRepoLock(common, fn);
}

/** Fetches origin main and adds a worktree for the task on a new branch. */
export async function createWorktree({ repoDir, stateDir, taskId, department, title, base = 'origin/main' }) {
  return locked(repoDir, async () => {
    await git(repoDir, ['fetch', '--quiet', 'origin', 'main']);
    const dir = worktreePath(stateDir, taskId);
    if (existsSync(dir)) throw new Error(`worktree already exists for ${taskId}`);
    const branch = branchName(department, taskId, title);
    await git(repoDir, ['worktree', 'add', '--quiet', '-b', branch, dir, base]);
    return { dir, branch };
  });
}

/** Rebases the worktree on the current origin/main. A conflict aborts the rebase and throws. */
export async function rebase(dir, identity) {
  await locked(dir, () => git(dir, ['fetch', '--quiet', 'origin', 'main'], { identity }));
  try {
    await git(dir, ['rebase', '--quiet', 'origin/main'], { identity });
  } catch (err) {
    await git(dir, ['rebase', '--abort'], { identity }).catch(() => {});
    throw new Error(`rebase conflict: ${err.message}`);
  }
}

/** Stages everything and commits. Returns the head SHA, or null when nothing changed. */
export async function commitAll(dir, message, identity) {
  await git(dir, ['add', '-A'], { identity });
  const status = await git(dir, ['status', '--porcelain'], { identity });
  if (!status) return null;
  await git(dir, ['commit', '--quiet', '-m', message], { identity });
  return git(dir, ['rev-parse', 'HEAD'], { identity });
}

/** Every manager push goes through here: the guard sees the real HEAD branch of the worktree. */
async function guardedPush(dir, args, run = git) {
  const taskBranch = await run(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assertSafePush({ args, taskBranch, baseBranch: 'main' });
  await locked(dir, () => run(dir, args), run);
}

export async function push(dir, branch, { run = git } = {}) {
  await guardedPush(dir, ['push', '--quiet', '-u', 'origin', `HEAD:${branch}`], run);
}

/** The sha of a branch on origin, or null when it does not exist there. */
export async function remoteSha(dir, branch, { run = git } = {}) {
  const out = await run(dir, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
  const sha = String(out ?? '').trim().split(/\s+/)[0];
  return /^[a-f0-9]{40}$/.test(sha) ? sha : null;
}

/** Push after a rebase. Refuses if the remote branch moved since `expectedSha` was read. */
export async function pushForce(dir, branch, expectedSha, { run = git } = {}) {
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '')) throw new Error('pushForce needs the expected remote sha');
  await guardedPush(dir, ['push', '--quiet', `--force-with-lease=${branch}:${expectedSha}`, 'origin', `HEAD:${branch}`], run);
}

/** Fix work: fetches the pushed task branch and checks it out in the task's worktree. */
export async function attachWorktree({ repoDir, stateDir, taskId, branch }) {
  return locked(repoDir, async () => {
    await git(repoDir, ['fetch', '--quiet', 'origin', branch]);
    const dir = worktreePath(stateDir, taskId);
    await removeWorktreeUnlocked(repoDir, dir, branch);
    await git(repoDir, ['worktree', 'add', '--quiet', '-B', branch, dir, `origin/${branch}`]);
    const sha = await git(dir, ['rev-parse', 'HEAD']);
    return { dir, branch, sha };
  });
}

/** Removes a worktree. Caller must hold the repo lock (attachWorktree does). */
async function removeWorktreeUnlocked(repoDir, dir, branch) {
  if (existsSync(dir)) {
    await git(repoDir, ['worktree', 'remove', '--force', dir]).catch(() => rmSync(dir, { recursive: true, force: true }));
  }
  await git(repoDir, ['worktree', 'prune']).catch(() => {});
  if (branch) await git(repoDir, ['branch', '-D', branch]).catch(() => {});
}

/** Removes the worktree directory and its local branch. */
export async function removeWorktree(repoDir, dir, branch) {
  return locked(repoDir, () => removeWorktreeUnlocked(repoDir, dir, branch));
}

const FINISHED = new Set(['merged', 'cancelled']);

/**
 * Removes the worktree and local branch of every task under <stateDir>/wt/ that the
 * orchestrator reports merged or cancelled. Tasks in `skip` (running in this process)
 * are not looked up. Remote branches are never touched. Errors are logged per task.
 * Returns the removed task ids.
 */
export async function cleanupFinishedWorktrees({ repoDir, stateDir, client, skip = new Set(), log = console }) {
  let ids;
  try {
    ids = readdirSync(path.join(stateDir, 'wt')).filter((id) => /^T-[0-9]{4,}$/.test(id)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const removed = [];
  for (const id of ids) {
    if (skip.has(id)) continue;
    try {
      const task = await client.getTask(id);
      if (!FINISHED.has(task?.status)) continue;
      const dir = worktreePath(stateDir, id);
      const head = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
      // Only a task branch (<department>/<task id>-<slug>) is deleted, never main or a detached HEAD.
      const branch = head && head.includes(`/${id.toLowerCase()}-`) ? head : null;
      await removeWorktree(repoDir, dir, branch);
      removed.push(id);
      log.log?.(`[cleanup] removed worktree of ${task.status} ${id}${branch ? ` and branch ${branch}` : ''}`);
    } catch (err) {
      log.warn?.(`[cleanup] ${id}: ${err.message}`);
    }
  }
  return removed;
}
