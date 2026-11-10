// Deterministic agent for revert tasks (no model call). It applies
// `git revert --no-commit <sha>` in the task worktree. The task runner's commit
// step records the result. The sha comes from the task's revert criterion.
import { git } from './worktree.mjs';

export const REVERT_CRITERION = /^revert ([a-f0-9]{40})$/;

/** The sha a revert task reverts, or null for an ordinary task. */
export function revertShaOf(task) {
  for (const criterion of task.acceptance ?? []) {
    const m = REVERT_CRITERION.exec(criterion);
    if (m) return m[1];
  }
  return null;
}

export async function revertAgent({ task, worktree }) {
  const sha = revertShaOf(task);
  if (!sha) throw new Error('revert task has no revert criterion');
  await git(worktree, ['revert', '--no-commit', sha]);
  return {
    tokens: 0,
    evidence: task.acceptance.map((criterion) => ({ criterion, met: true, detail: `git revert --no-commit ${sha.slice(0, 7)}` })),
  };
}
