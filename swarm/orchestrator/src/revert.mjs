// Main red: when the head of main goes red, revert the PR behind it. The revert
// is an ordinary task: its own epic, department platform, priority p0, size M,
// paths exactly the culprit PR's files. Gates, review loop and humanReview rules
// all apply. Nobody merges their own revert. Guards: at most one revert per
// sha, and a revert is never reverted (a red revert would loop forever).
import { nextTaskId } from './planner.mjs';

export const REVERT_TITLE = /^Revert PR #(\d+)/;
export const REVERT_CRITERION = /^revert ([a-f0-9]{40})$/;
const SIZE = 'M';

function nextEpicId(store) {
  let n = store.epicAges().size + 1;
  while (store.epicAges().has(`E-${String(n).padStart(4, '0')}`)) n += 1;
  return `E-${String(n).padStart(4, '0')}`;
}

/**
 * Creates the revert task for the PR behind `sha`, once. Returns { status, ... }:
 * created | exists | skipped (with reason). Never throws on a missing PR.
 */
export async function revertMainRed({ store, gh, sha, repo, policy }) {
  const criterion = `revert ${sha}`;
  const existing = store.listTasks().find((t) => t.acceptance.includes(criterion));
  if (existing) return { status: 'exists', taskId: existing.id };

  const prs = await gh.pullsForCommit(sha);
  if (prs.length === 0) return { status: 'skipped', reason: `head ${sha.slice(0, 7)} has no PR; nothing to revert by PR` };
  const number = prs[0];
  const pr = await gh.pr(number);
  if (REVERT_TITLE.test(pr.title)) return { status: 'skipped', reason: `PR #${number} is itself a revert; not reverting a revert` };
  const files = await gh.files(number);
  if (files.length === 0) return { status: 'skipped', reason: `PR #${number} changes no files` };

  const epic = store.createEpic({
    id: nextEpicId(store),
    repo,
    title: `Revert PR #${number}`,
    body: `main checks red at ${sha.slice(0, 7)}. Automatic revert of PR #${number}.`,
    source: 'monitor',
    issue: null,
  });
  const task = store.createTask({
    id: nextTaskId(store),
    epicId: epic.id,
    repo,
    title: `Revert PR #${number} (main red at ${sha.slice(0, 7)})`,
    department: 'platform',
    priority: 'p0',
    size: SIZE,
    paths: files,
    dependsOn: [],
    acceptance: [criterion, `main checks green again after the revert of PR #${number} merges`],
    budget: policy.budgets[SIZE],
  });
  return { status: 'created', taskId: task.id, pr: number, files: files.length };
}
