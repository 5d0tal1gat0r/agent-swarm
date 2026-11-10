import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildDockerArgs, modelFor, prepareJob, renderPrompt, runContainer } from '../src/sandbox.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ap-test-'));

describe('modelFor', () => {
  it('returns the model configured for the job kind, or empty for the agent default', () => {
    const config = { models: { build: 'claude-sonnet-5-5', fix: null } };
    assert.equal(modelFor(config, 'build'), 'claude-sonnet-5-5');
    assert.equal(modelFor(config, 'fix'), '');
    assert.equal(modelFor(config, 'review'), '');
    assert.equal(modelFor({}, 'build'), '');
  });
});

describe('renderPrompt', () => {
  it('fills variables once and leaves braces inside values alone', () => {
    const out = renderPrompt('build', { issue: 4, issueTitle: 'T', issueBody: 'use {{member}} here', branch: 'b', agentName: 'a', member: 'bob', repo: 'o/r' });
    assert.ok(out.includes('implement GitHub issue #4 in o/r'));
    assert.ok(out.includes('use {{member}} here'));
  });
});

describe('buildDockerArgs', () => {
  it('runs a removable, limited container with only the job dir mounted', () => {
    const args = buildDockerArgs({ name: 'n', dir: '/tmp/job', envFile: '/tmp/env' });
    assert.ok(args.includes('--rm'));
    assert.equal(args[args.indexOf('--memory') + 1], '4g');
    assert.ok(args.includes('no-new-privileges'));
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
    assert.deepEqual(mounts, ['/tmp/job:/job:ro']);
    assert.ok(!args.some((a) => a.includes('GH_TOKEN')), 'secrets go through the env file, not argv');
  });
});

describe('prepareJob', () => {
  it('writes secrets only to a 0600 env file', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'gh'), 'ghp_secret\n');
    fs.writeFileSync(path.join(d, 'claude'), 'sk-claude\n');
    const config = { repo: 'o/r', member: 'bob', agent: 'claude', busMcpUrl: 'http://bus/mcp', githubTokenFile: path.join(d, 'gh'), claudeTokenFile: path.join(d, 'claude'), models: { review: 'claude-sonnet-5-5' } };
    const { dir, envFile } = prepareJob({ kind: 'review', pr: 3 }, config, 'prompt');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    const env = fs.readFileSync(envFile, 'utf8');
    assert.ok(env.includes('GH_TOKEN=ghp_secret') && env.includes('CLAUDE_CODE_OAUTH_TOKEN=sk-claude') && env.includes('PR=3'));
    assert.ok(env.includes('MODEL=claude-sonnet-5-5\n'));
    for (const f of fs.readdirSync(dir)) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes('secret'));
  });

  it('refuses multi-line secret files', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'gh'), 'a\nb\n');
    const config = { repo: 'o/r', member: 'bob', agent: 'claude', busMcpUrl: 'u', githubTokenFile: path.join(d, 'gh'), claudeTokenFile: path.join(d, 'gh') };
    assert.throws(() => prepareJob({ kind: 'build', issue: 1 }, config, 'p'), /exactly one line/);
  });
});

describe('runContainer', () => {
  function fakeSpawn(behaviour) {
    const calls = [];
    const spawnFn = (cmd, args) => {
      calls.push(args);
      const child = new EventEmitter();
      child.kill = () => setImmediate(() => child.emit('close', null));
      if (behaviour === 'ok' && args[0] === 'run') setImmediate(() => child.emit('close', 0));
      return child;
    };
    return { calls, spawnFn };
  }

  it('reports success', async () => {
    const { spawnFn } = fakeSpawn('ok');
    const r = await runContainer(['run'], { name: 'n', logFile: path.join(tmp(), 'log'), timeoutMs: 1000, spawnFn });
    assert.deepEqual(r, { ok: true, code: 0, timedOut: false });
  });

  it('kills job at time limit', async () => {
    const { calls, spawnFn } = fakeSpawn('hang');
    const r = await runContainer(['run'], { name: 'job-1', logFile: path.join(tmp(), 'log'), timeoutMs: 20, spawnFn });
    assert.equal(r.timedOut, true);
    assert.equal(r.ok, false);
    assert.ok(calls.some((a) => a[0] === 'kill' && a[1] === 'job-1'));
  });
});
