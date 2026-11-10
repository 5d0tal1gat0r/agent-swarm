import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AGENTS, DEFAULT_MODELS, MODEL_KINDS, loadConfig, resolveModels } from '../src/config.mjs';

/** Writes a config with real secret files so loadConfig's file checks pass. */
function write(extra) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-cfg-'));
  for (const f of ['gh', 'claude', 'auth.json', 'oauth_creds.json']) fs.writeFileSync(path.join(d, f), '{}');
  const file = path.join(d, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    member: 'bob',
    githubTokenFile: path.join(d, 'gh'),
    claudeTokenFile: path.join(d, 'claude'),
    codexAuthFile: path.join(d, 'auth.json'),
    geminiAuthFile: path.join(d, 'oauth_creds.json'),
    ...extra,
  }));
  return file;
}

describe('loadConfig models', () => {
  it('lists the three agents and the models each one defaults to', () => {
    assert.deepEqual([...AGENTS].sort(), ['claude', 'codex', 'gemini']);
    assert.deepEqual(loadConfig(write({})).models, DEFAULT_MODELS.claude);
    assert.equal(DEFAULT_MODELS.claude.fix, 'claude-haiku-5-5');
    assert.equal(DEFAULT_MODELS.gemini.fix, 'gemini-2.5-flash-lite');
  });

  it('uses the gemini defaults when agent is gemini', () => {
    assert.deepEqual(loadConfig(write({ agent: 'gemini' })).models, DEFAULT_MODELS.gemini);
  });

  it('sets no codex model unless the user does', () => {
    assert.deepEqual(loadConfig(write({ agent: 'codex' })).models, {});
    assert.deepEqual(loadConfig(write({ agent: 'codex', models: { codex: { build: 'gpt-5.6-terra' } } })).models, { build: 'gpt-5.6-terra' });
  });

  it('overrides one kind per agent and keeps the rest of the defaults', () => {
    const config = loadConfig(write({ models: { claude: { fix: 'claude-sonnet-5-5' } } }));
    assert.equal(config.models.fix, 'claude-sonnet-5-5');
    assert.equal(config.models.build, 'claude-sonnet-5-5');
  });

  it('ignores another agent\'s models', () => {
    const config = loadConfig(write({ models: { gemini: { build: 'gemini-x' } } }));
    assert.deepEqual(config.models, DEFAULT_MODELS.claude);
  });

  it('accepts null to use the agent default', () => {
    assert.equal(loadConfig(write({ models: { claude: { fix: null } } })).models.fix, null);
  });

  it('rejects model ids that could break the env file', () => {
    assert.throws(() => loadConfig(write({ models: { claude: { build: 'x\nGH_TOKEN=evil' } } })), /is not a model id/);
  });

  it('rejects unknown agents, including antigravity (no sandbox runner yet)', () => {
    assert.throws(() => loadConfig(write({ agent: 'antigravity' })), /agent must be one of/);
    assert.throws(() => loadConfig(write({ models: { antigravity: { build: 'flash' } } })), /not a known agent/);
  });

  it('requires the gemini auth file when agent is gemini', () => {
    assert.throws(() => loadConfig(write({ agent: 'gemini', geminiAuthFile: '/nope' })), /geminiAuthFile not found/);
  });

  it('rejects a model id with a leading dash (would inject a CLI flag)', () => {
    assert.throws(() => loadConfig(write({ models: { claude: { fix: '--dangerously-skip-permissions' } } })), /is not a model id/);
    assert.throws(() => loadConfig(write({ models: { claude: { fix: '-x' } } })), /is not a model id/);
  });

  it('rejects non-string model values', () => {
    assert.throws(() => loadConfig(write({ models: { claude: { fix: 42 } } })), /is not a model id/);
    assert.throws(() => loadConfig(write({ models: { claude: { fix: ['a'] } } })), /is not a model id/);
  });

  it('rejects unknown job kinds (a typo must not be ignored)', () => {
    assert.throws(() => loadConfig(write({ models: { claude: { fixx: 'claude-haiku-5-5' } } })), /fixx is not a job kind/);
    assert.deepEqual([...MODEL_KINDS].sort(), ['build', 'fix', 'review']);
  });

  it('rejects models that are not objects', () => {
    assert.throws(() => loadConfig(write({ models: 'claude-haiku-5-5' })), /models must be an object/);
    assert.throws(() => loadConfig(write({ models: { claude: 'x' } })), /models.claude must be an object/);
  });

  it('resolveModels keeps unknown agents empty', () => {
    assert.deepEqual(resolveModels('nobody', {}), {});
  });
});
