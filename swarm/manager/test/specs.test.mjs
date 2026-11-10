import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { loadDepartments } from '../../orchestrator/src/config.mjs';
import { SPEC_SECTIONS, lintSpecs, readSpec } from '../src/specs.mjs';
import { buildPlanningPrompt, subagentAgent } from '../src/subagents.mjs';

const SWARM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANAGERS = path.join(SWARM, 'managers');
const departments = loadDepartments(path.join(SWARM, 'departments.yaml'));

function specText(globs, skip = null) {
  return ['# Manager spec: x', ...SPEC_SECTIONS.filter((s) => s !== skip).flatMap((s) => [
    `## ${s}`, s === 'Owns' ? globs.map((g) => `- \`${g}\``).join('\n') : 'text',
  ])].join('\n\n');
}
function tmpManagers(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specs-'));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, `${name}.md`), text);
  return dir;
}
const oneDept = { departments: { core: { paths: ['a/**', 'b/**'] } } };

describe('manager specs', () => {
  it('every department in departments.yaml has a complete spec matching its paths', () => {
    assert.deepEqual(lintSpecs({ managersDir: MANAGERS, departments }), []);
  });

  it('flags a missing file, a missing section, and Owns globs that differ from departments.yaml', () => {
    assert.deepEqual(lintSpecs({ managersDir: tmpManagers({}), departments: oneDept }), ['core: no file managers/core.md']);
    assert.deepEqual(lintSpecs({ managersDir: tmpManagers({ core: specText(['a/**', 'b/**'], 'Never') }), departments: oneDept }), ['core: missing section "## Never"']);
    assert.deepEqual(lintSpecs({ managersDir: tmpManagers({ core: specText(['a/**', 'c/**']) }), departments: oneDept }), [
      'core: Owns lists c/** which departments.yaml does not have',
      'core: Owns is missing b/** from departments.yaml',
    ]);
  });

  it('flags sections out of order', () => {
    const text = specText(['a/**', 'b/**']).replace('## Never', '## TEMP').replace('## Tools allowed', '## Never').replace('## TEMP', '## Tools allowed');
    assert.match(lintSpecs({ managersDir: tmpManagers({ core: text }), departments: oneDept })[0], /out of order/);
  });

  it('readSpec returns the file text, or null when there is none', () => {
    assert.match(readSpec(MANAGERS, 'core'), /^# Manager spec: core/);
    assert.equal(readSpec(MANAGERS, 'nope'), null);
  });

  it('the planning prompt carries the department spec', () => {
    const task = { id: 'T-1', title: 't', acceptance: ['works'], paths: ['swarm/orchestrator/**'] };
    const prompt = buildPlanningPrompt(task, ['implementer'], '# Manager spec: core\n\n## Never\n\n- rewrite migrations');
    assert.match(prompt, /## Department rules\n\n# Manager spec: core/);
    assert.doesNotMatch(buildPlanningPrompt(task, ['implementer']), /Department rules/);
  });

  it('the single implementer and every subtask get the department spec', async () => {
    const prompts = [];
    const runner = async ({ prompt, readOnly }) => {
      prompts.push(prompt);
      if (readOnly) return { reply: JSON.stringify({ result: '{"subtasks":[{"role":"implementer","paths":["a/x/**"],"prompt":"p1"},{"role":"test-writer","paths":["a/y/**"],"prompt":"p2"}]}' }) };
      return { reply: '' };
    };
    const agent = subagentAgent({ kind: 'claude', allowedModels: { claude: ['claude-haiku-5-5'] }, agentsDir: path.join(SWARM, 'agents'),
      runner, departmentSpec: 'SPEC-MARKER', log: { warn() {}, info() {} } });
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
    const git = (...args) => execFileSync('git', ['-C', worktree, ...args]);
    git('init', '--quiet');
    fs.writeFileSync(path.join(worktree, 'seed.txt'), 'x\n');
    git('add', '-A');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed');
    await agent({ task: { id: 'T-1', title: 't', acceptance: ['works'], paths: ['a/**'] }, worktree, model: 'claude-haiku-5-5' });
    assert.equal(prompts.length, 3, 'planning + 2 subtasks');
    for (const p of prompts) assert.match(p, /## Department rules\n\nSPEC-MARKER/);
  });
});
