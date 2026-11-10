import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { installAgents, lintAgent, loadAgents, parseAgentFile } from '../src/agents-install.mjs';
import { loadPolicy } from '../../orchestrator/src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');
const models = loadPolicy(path.join(SWARM, 'policy.yaml')).models.claude;
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

const agentText = ({ name = 'x', model = 'claude-sonnet-5-5', body = 'Do the work.', tools = 'Read, Edit', description = 'd' } = {}) =>
  `---\nname: ${name}\ndescription: ${description}\nmodel: ${model}\ntools: ${tools}\n---\n\n${body}\n`;

describe('subagent role files', () => {
  it('the shipped role files pass lint against the policy allow-list', () => {
    const agents = loadAgents(path.join(SWARM, 'agents'), models);
    assert.deepEqual(agents.map((a) => a.meta.name).sort(), ['checker', 'doc-writer', 'explorer', 'fixer', 'implementer', 'test-writer']);
    for (const a of agents) assert.ok(models.includes(a.meta.model));
  });

  it('lint rejects a model off the allow-list, a name that does not match the file, and git write instructions', () => {
    const cases = [
      [{ file: 'x.md', ...parseAgentFile(agentText({ model: 'claude-fake-1' })) }, /not on the allow-list/],
      [{ file: 'x.md', ...parseAgentFile(agentText({ name: 'other' })) }, /must match file name/],
      [{ file: 'x.md', ...parseAgentFile(agentText({ body: 'Then run git push origin HEAD.' })) }, /git write instructions/],
      [{ file: 'x.md', ...parseAgentFile(agentText({ body: 'Run gh pr merge 5.' })) }, /git write instructions/],
      [{ file: 'x.md', ...parseAgentFile(agentText({ tools: '' })) }, /tools is required/],
    ];
    for (const [parsed, pattern] of cases) assert.match(lintAgent(parsed, models).join('\n'), pattern);
  });

  it('a body that only says not to run git is fine', () => {
    const parsed = { file: 'x.md', ...parseAgentFile(agentText({ body: 'Never run git. The manager commits and pushes.' })) };
    assert.deepEqual(lintAgent(parsed, models), []);
  });

  it('parseAgentFile rejects a file with no frontmatter', () => {
    assert.throws(() => parseAgentFile('# just markdown'), /missing frontmatter/);
  });

  it('loadAgents reports every problem at once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-agents-lint-'));
    made.push(dir);
    fs.writeFileSync(path.join(dir, 'a.md'), agentText({ name: 'a', model: 'nope' }));
    fs.writeFileSync(path.join(dir, 'b.md'), agentText({ name: 'wrong' }));
    assert.throws(() => loadAgents(dir, models), (err) => /a\.md.*allow-list[\s\S]*b\.md.*must match/.test(err.message));
  });

  it('installAgents copies the lint-clean files to the destination folder', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-agents-src-'));
    const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-agents-dest-'));
    made.push(src, dest);
    fs.writeFileSync(path.join(src, 'x.md'), agentText({ name: 'x' }));
    assert.deepEqual(installAgents({ srcDir: src, destDir: path.join(dest, 'agents'), allowedModels: models }), ['x.md']);
    assert.equal(fs.readFileSync(path.join(dest, 'agents', 'x.md'), 'utf8'), agentText({ name: 'x' }));
  });
});
