// Machine gate for a submitted PR. Pure: no I/O. The caller passes a PR
// snapshot (from GitHub) and gets back blockers, numbered later as findings.
// Any blocker sends the task to changes_requested. A humanReview path does not
// block; it stops auto-merge and sends the task to needs-human.
import { matchGlob } from '../../shared/globs.mjs';

const DEFAULT_MAX_DELETED = 10;
const DEFAULT_PROTECTED = ['.github/**', 'swarm/policy.yaml', 'swarm/departments.yaml', 'AGENTS.md', 'swarm/deploy/**', '**/package-lock.json'];
// Same patterns as swarm/deploy/test/deploy.test.mjs, tested per added line.
// Also used by test/repo-secrets.test.mjs to scan every tracked file.
export const SECRET_PATTERNS = [
  ['github token (ghp_)', /ghp_[A-Za-z0-9]{20,}/],
  ['github token (github_pat_)', /github_pat_[A-Za-z0-9_]{20,}/],
  ['private key', /BEGIN [A-Z ]*PRIVATE KEY/],
  ['GH_TOKEN assignment', /^GH_TOKEN=\S+/],
];
const isEnvFile = (file) => /^\.env(\..+)?$/.test(file.split('/').pop()) && file.split('/').pop() !== '.env.example';

const short = (sha) => String(sha ?? '').slice(0, 7);

/**
 * @param task     { paths, size, acceptance }
 * @param pr       { baseRefName, headSha, files: string[], additions, deletions }
 * @param checks   [{ name, headSha, conclusion }]
 * @param behindBy commits the PR head is behind its base
 * @param submittedHeadSha head the manager submitted
 * @param policy   { limits: { maxChangedLines, maxDeletedFiles? }, humanReview: glob[], protected?: glob[] }
 *   pr.changes (optional): [{ filename, status, patch?, previous_filename? }] as GitHub lists them.
 */
export function machineGate({ task, pr, checks, behindBy, submittedHeadSha, policy }) {
  const findings = [];
  const block = (problem, fix, file = '') => findings.push({ severity: 'blocker', file, problem, fix });

  if (pr.baseRefName !== 'main') block(`PR base is ${pr.baseRefName}, must be main`, 'Retarget the PR to main.');
  if (pr.headSha !== submittedHeadSha) {
    block(`head moved: submitted ${short(submittedHeadSha)}, now ${short(pr.headSha)}`, 'Submit again from the current head.');
  }
  const ci = checks.find((c) => c.name === 'check' && c.headSha === pr.headSha);
  if (!ci || ci.conclusion !== 'success') {
    block(`required check "check" is ${ci?.conclusion ?? 'missing'} on the head commit`, 'Fix CI on the branch and push.');
  }
  if (pr.files.length === 0) block('PR changes no files', 'Make the change or cancel the task.');
  for (const file of pr.files) {
    if (!task.paths.some((glob) => matchGlob(glob, file))) {
      block(`file outside task paths: ${file}`, `Revert ${file}, or move it to a task owned by its department.`, file);
    }
  }
  const lines = pr.additions + pr.deletions;
  const max = policy.limits.maxChangedLines[task.size];
  if (lines > max) block(`change is ${lines} lines, limit for size ${task.size} is ${max}`, 'Split the change into smaller tasks.');
  if (behindBy > 0) block(`branch is ${behindBy} commits behind main`, 'Rebase onto origin/main and push.');

  const changes = pr.changes ?? [];
  for (const c of changes) {
    if (c.status === 'removed') continue;
    if (['added', 'renamed', 'copied'].includes(c.status) && isEnvFile(c.filename)) {
      block(`adds an env file: ${c.filename}`, `Remove ${c.filename}; commit only .env.example.`, c.filename);
    }
    const added = String(c.patch ?? '').split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    for (const [name, re] of SECRET_PATTERNS) {
      if (added.some((l) => re.test(l))) {
        block(`added lines in ${c.filename} look like a secret: ${name}`, `Remove it from ${c.filename}, rotate the credential, and rewrite the commit.`, c.filename);
      }
    }
  }

  // Deleted files: a rename deletes its old path. Many deletions or any protected one needs a human.
  const deleted = changes.flatMap((c) => (c.status === 'removed' ? [c.filename] : c.status === 'renamed' && c.previous_filename ? [c.previous_filename] : []));
  const maxDeleted = policy.limits.maxDeletedFiles ?? DEFAULT_MAX_DELETED;
  const protectedGlobs = policy.protected ?? DEFAULT_PROTECTED;
  const risky = deleted.length > maxDeleted ? deleted : deleted.filter((file) => protectedGlobs.some((glob) => matchGlob(glob, file)));

  const humanReview = [...new Set([...pr.files.filter((file) => policy.humanReview.some((glob) => matchGlob(glob, file))), ...risky])];
  return { ok: findings.length === 0, findings: numberFindings(findings), humanReview };
}

/** Adds n = 1, 2, ... in order. */
export function numberFindings(findings) {
  return findings.map((f, i) => ({ n: i + 1, ...f }));
}
