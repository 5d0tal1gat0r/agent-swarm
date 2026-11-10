// Serialises git operations that touch shared repo state (worktree add/remove,
// fetch, push). Keyed by the git common dir, so every worktree of one clone
// shares a queue. In-process only: one manager process per clone.
const queues = new Map();

export function withRepoLock(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const settled = run.catch(() => {});
  queues.set(key, settled);
  settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return run;
}
