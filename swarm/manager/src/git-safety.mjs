// Pure guard for every `git push` the manager runs (guardrail 3, ARCHITECTURE 21, 44).
// Allowed: push or delete of the task's own branch; force only as
// --force-with-lease=<branch>:<40-hex sha>. Everything else throws.
const SHA = /^[a-f0-9]{40}$/;
const FORBIDDEN = new Set(['--mirror', '--all', '--branches', '--tags', '--follow-tags', '--prune']);
const FORCE = new Set(['--force', '-f']);
const DELETE = new Set(['--delete', '-d']);

const qualify = (ref) => (ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);

/** args: the full git argv, starting with 'push'. Returns nothing; throws Error on any unsafe push. */
export function assertSafePush({ args, taskBranch, baseBranch = 'main' }) {
  if (!Array.isArray(args) || args[0] !== 'push') throw new Error('guard: not a git push');
  if (!taskBranch || /^(HEAD)?$/.test(taskBranch)) throw new Error('guard: task branch unknown (detached HEAD?)');
  const own = qualify(taskBranch);
  const base = qualify(baseBranch);
  if (own === base) throw new Error(`guard: task branch ${taskBranch} is the base branch`);

  let del = false;
  let lease = null;
  const positional = [];
  for (const a of args.slice(1)) {
    if (FORBIDDEN.has(a)) throw new Error(`guard: ${a} is not allowed`);
    if (FORCE.has(a)) throw new Error('guard: plain force refused; use --force-with-lease=<branch>:<sha>');
    if (DELETE.has(a)) del = true;
    else if (a.startsWith('--force-with-lease')) {
      const m = /^--force-with-lease=([^:]+):(.*)$/.exec(a);
      if (!m || !SHA.test(m[2])) throw new Error('guard: --force-with-lease needs an expected sha (--force-with-lease=<branch>:<sha>)');
      lease = qualify(m[1]);
    } else if (a.startsWith('-') && !['--quiet', '-q', '-u', '--set-upstream', '--force-if-includes'].includes(a)) {
      throw new Error(`guard: push flag ${a} is not allowed`);
    } else if (!a.startsWith('-')) positional.push(a);
  }
  const specs = positional.slice(1); // first positional is the remote
  if (specs.length === 0) throw new Error('guard: push needs an explicit refspec');

  for (let spec of specs) {
    if (spec.startsWith('+')) throw new Error(`guard: force refspec ${spec} refused`);
    const colon = spec.indexOf(':');
    const dst = qualify(colon === -1 ? spec : spec.slice(colon + 1));
    if (dst === base) throw new Error(`guard: push to base branch ${baseBranch} refused`);
    if (dst !== own) throw new Error(`guard: ${dst} is not the task branch ${own}`);
    if (del && colon !== -1 && spec.slice(0, colon) !== '') throw new Error('guard: --delete takes branch names only');
  }
  if (lease && lease !== own) throw new Error(`guard: lease on ${lease} is not the task branch`);
}
