import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { machineGate, numberFindings } from '../src/gates.mjs';

const HEAD = 'a'.repeat(40);
const policy = {
  limits: { maxChangedLines: { S: 400, M: 1000 } },
  humanReview: ['.github/**', 'swarm/policy.yaml'],
};
const task = { paths: ['swarm/manager/**'], size: 'S', acceptance: ['works'] };
const clean = () => ({
  pr: { baseRefName: 'main', headSha: HEAD, files: ['swarm/manager/src/x.mjs'], additions: 10, deletions: 2 },
  checks: [{ name: 'check', headSha: HEAD, conclusion: 'success' }],
  behindBy: 0,
  submittedHeadSha: HEAD,
  policy,
});
const run = (patch = {}) => {
  const base = clean();
  return machineGate({ task, ...base, ...patch, pr: { ...base.pr, ...(patch.pr ?? {}) } });
};
const problems = (r) => r.findings.map((f) => f.problem);

describe('machine gate', () => {
  it('passes a clean PR with no findings and no human review', () => {
    assert.deepEqual(run(), { ok: true, findings: [], humanReview: [] });
  });

  it('blocks a PR not targeting main', () => {
    assert.match(problems(run({ pr: { baseRefName: 'feature/x' } }))[0], /base is feature\/x, must be main/);
  });

  it('blocks when the head moved after submit', () => {
    const r = run({ pr: { headSha: 'b'.repeat(40) } });
    assert.equal(r.ok, false);
    assert.match(problems(r).join('\n'), /head moved/);
  });

  it('requires the check run on the head commit to succeed', () => {
    assert.match(problems(run({ checks: [] })).join('\n'), /"check" is missing/);
    assert.match(problems(run({ checks: [{ name: 'check', headSha: HEAD, conclusion: 'failure' }] })).join('\n'), /is failure/);
    // A green check on an older commit does not count.
    const old = [{ name: 'check', headSha: 'c'.repeat(40), conclusion: 'success' }];
    assert.match(problems(run({ checks: old })).join('\n'), /is missing/);
  });

  it('numbers one finding per out-of-scope file', () => {
    const r = run({ pr: { files: ['swarm/manager/src/x.mjs', 'swarm/orchestrator/src/y.mjs', 'docs/z.md'] } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.findings.map((f) => [f.n, f.file]), [[1, 'swarm/orchestrator/src/y.mjs'], [2, 'docs/z.md']]);
    assert.ok(r.findings.every((f) => f.severity === 'blocker' && f.fix));
  });

  it('blocks a PR that changes no files', () => {
    assert.match(problems(run({ pr: { files: [] } })).join('\n'), /changes no files/);
  });

  it('applies the size limit for the task size', () => {
    assert.equal(run({ pr: { additions: 399, deletions: 1 } }).ok, true);
    assert.match(problems(run({ pr: { additions: 401, deletions: 0 } })).join('\n'), /401 lines, limit for size S is 400/);
  });

  it('blocks a branch behind main', () => {
    assert.match(problems(run({ behindBy: 2 })).join('\n'), /2 commits behind main/);
  });

  it('flags humanReview paths without blocking, so auto-merge stops', () => {
    const wide = { ...task, paths: ['swarm/**'] };
    const r = machineGate({ task: wide, ...clean(), pr: { ...clean().pr, files: ['swarm/manager/src/x.mjs', 'swarm/policy.yaml'] } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.humanReview, ['swarm/policy.yaml']);
  });

  // Guardrails. Item 2 (paths outside the task) already existed; this proves it, see also
  // 'numbers one finding per out-of-scope file'.
  it('guardrail 2: a file outside the task paths blocks the PR', () => {
    const r = run({ pr: { files: ['swarm/manager/src/x.mjs', '.github/workflows/ci.yml'] } });
    assert.equal(r.ok, false);
    assert.deepEqual(r.findings.map((f) => f.file), ['.github/workflows/ci.yml']);
  });

  const wide = { ...task, paths: ['**'] };
  const gate = (changes, p = policy) => machineGate({ task: wide, ...clean(), policy: p, pr: { ...clean().pr, files: changes.map((c) => c.filename), changes } });
  const removed = (filename) => ({ filename, status: 'removed' });

  it('guardrail 1: deleting more than maxDeletedFiles goes to human review, not a block', () => {
    const files = Array.from({ length: 11 }, (_, i) => removed(`swarm/manager/src/f${i}.mjs`));
    const r = gate(files, { ...policy, limits: { ...policy.limits, maxDeletedFiles: 10 } });
    assert.equal(r.ok, true);
    assert.equal(r.humanReview.length, 11);
    assert.deepEqual(gate(files.slice(0, 10), { ...policy, limits: { ...policy.limits, maxDeletedFiles: 10 } }).humanReview, []);
    // Default limit is 10 when the policy omits the key.
    assert.equal(gate(files).humanReview.length, 11);
  });

  it('guardrail 1: deleting a protected file goes to human review; adding or editing it does not', () => {
    for (const f of ['AGENTS.md', 'swarm/departments.yaml', 'swarm/manager/package-lock.json', '.github/CODEOWNERS']) {
      assert.deepEqual(gate([removed(f)]).humanReview, [f], f);
    }
    assert.deepEqual(gate([{ filename: 'AGENTS.md', status: 'modified' }]).humanReview, []);
    assert.deepEqual(gate([removed('swarm/manager/src/x.mjs')]).humanReview, []);
    // A rename deletes the old path.
    assert.deepEqual(gate([{ filename: 'docs/a.md', status: 'renamed', previous_filename: 'AGENTS.md' }]).humanReview, ['AGENTS.md']);
    // Policy can narrow the list.
    assert.deepEqual(gate([removed('AGENTS.md')], { ...policy, protected: ['x/**'] }).humanReview, []);
  });

  it('guardrail 4: added secret-looking lines block, naming file and pattern but not the secret', () => {
    const cases = {
      'github token (ghp_)': `ghp_${'A'.repeat(30)}`,
      'github token (github_pat_)': `github_pat_${'b'.repeat(30)}`,
      'private key': '-----BEGIN RSA ' + 'PRIVATE KEY-----', // split so the repo secret check does not flag this file
      'GH_TOKEN assignment': 'GH_TOKEN=abc123',
    };
    for (const [name, secret] of Object.entries(cases)) {
      const r = gate([{ filename: 'swarm/manager/a.txt', status: 'modified', patch: `@@ -1 +1,2 @@\n ok\n+${secret}` }]);
      assert.equal(r.ok, false, name);
      assert.match(problems(r)[0], new RegExp(`a\\.txt.*${name.replace(/[()]/g, '\\$&')}`));
      assert.equal(JSON.stringify(r).includes(secret), false, 'secret leaked into findings');
    }
  });

  it('guardrail 4: removed or context lines with a secret do not block; added .env files do', () => {
    const old = `ghp_${'A'.repeat(30)}`;
    assert.equal(gate([{ filename: 'a.txt', status: 'modified', patch: `@@ -1,2 +1 @@\n-${old}\n ${old}` }]).ok, true);
    for (const f of ['.env', 'swarm/.env.local']) {
      const r = gate([{ filename: f, status: 'added' }]);
      assert.equal(r.ok, false, f);
      assert.match(problems(r)[0], /adds an env file/);
    }
    assert.equal(gate([{ filename: '.env.example', status: 'added' }]).ok, true);
    assert.equal(gate([{ filename: 'environment.mjs', status: 'added' }]).ok, true);
    assert.equal(gate([removed('.env')]).ok, true);
  });

  it('numberFindings starts at 1 and keeps order', () => {
    assert.deepEqual(numberFindings([{ problem: 'a' }, { problem: 'b' }]).map((f) => f.n), [1, 2]);
  });
});
