import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { assertNoGithubToken, buildRunArgs, runContainer, writeEnvFile } from '../sandbox.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sb-'));

describe('sandbox args', () => {
  it('mounts only the worktree rw, runs as the host uid, and never mounts .git', () => {
    const wt = path.join(tmp(), 'wt', 'T-0001');
    fs.mkdirSync(wt, { recursive: true });
    const args = buildRunArgs({ name: 'n', worktreeDir: wt, envFile: '/tmp/e', image: 'img', uid: 1000, gid: 1000 });
    const mounts = args.flatMap((a, i) => (a === '-v' ? [args[i + 1]] : []));
    assert.deepEqual(mounts, [`${wt}:/work:rw`]);
    assert.equal(args[args.indexOf('--user') + 1], '1000:1000');
    assert.ok(args.includes('--cap-drop') && args.includes('no-new-privileges'));
    assert.equal(args.includes('--userns=keep-id'), false, 'docker does not get the podman flag');
    assert.ok(args.includes('--rm'));
  });

  it('podman also gets keep-id', () => {
    const wt = tmp();
    const args = buildRunArgs({ runtime: 'podman', name: 'n', worktreeDir: wt, envFile: '/tmp/e', image: 'img', uid: 1, gid: 1 });
    assert.ok(args.includes('--userns=keep-id'));
  });

  it('refuses a missing worktree, a relative path, and a .git mount', () => {
    assert.throws(() => buildRunArgs({ name: 'n', worktreeDir: '/nope/x', envFile: '/e', image: 'i', uid: 1, gid: 1 }), /no worktree/);
    assert.throws(() => buildRunArgs({ name: 'n', worktreeDir: 'rel', envFile: '/e', image: 'i', uid: 1, gid: 1 }), /absolute/);
    const repo = tmp();
    fs.mkdirSync(path.join(repo, '.git'));
    assert.throws(() => buildRunArgs({ name: 'n', worktreeDir: path.join(repo, '.git'), envFile: '/e', image: 'i', uid: 1, gid: 1 }), /refusing to mount a .git/);
  });
});

describe('sandbox env', () => {
  it('writes the env file mode 0600', () => {
    const file = path.join(tmp(), 'env');
    writeEnvFile(file, { AGENT: 'claude', TASK: 'T-0001' });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(file, 'utf8'), /AGENT=claude/);
  });

  it('refuses GitHub tokens and newline injection', () => {
    assert.throws(() => assertNoGithubToken({ GH_TOKEN: 'x' }), /must not receive GitHub tokens/);
    assert.throws(() => writeEnvFile(path.join(tmp(), 'e'), { A: 'x\nGH_TOKEN=evil' }), /newline/);
  });
});

describe('runContainer', () => {
  function fakeSpawn(behaviour) {
    const calls = [];
    const spawnFn = (cmd, args) => {
      calls.push([cmd, ...args]);
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

  it('kills the container at the time limit', async () => {
    const { calls, spawnFn } = fakeSpawn('hang');
    const r = await runContainer(['run'], { runtime: 'podman', name: 'job-1', logFile: path.join(tmp(), 'log'), timeoutMs: 20, spawnFn });
    assert.equal(r.timedOut, true);
    assert.ok(calls.some((c) => c[0] === 'podman' && c[1] === 'kill' && c[2] === 'job-1'));
  });
});
