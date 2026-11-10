import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { AUTH_IN_CONTAINER, buildSubagentRunArgs, runSubagent } from '../src/subagents.mjs';

const allowed = { claude: ['claude-haiku-5-5'], codex: ['gpt-5.6-luna'], gemini: ['gemini-2.5-flash-lite'] };
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sub-ct-')); made.push(d); return d; };

function fakeSpawn(script = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = { data: '', on() {}, end(p) { child.stdin.data = p; } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    calls.push({ cmd, args, opts, child });
    setImmediate(() => {
      if (script.stdout) child.stdout.emit('data', script.stdout);
      if (script.hang) return;
      child.emit('close', script.code ?? 0);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

describe('container run args', () => {
  it('mounts the worktree at /work rw and only the kind\'s auth file ro, and no host env', () => {
    const wt = dir();
    const auth = path.join(dir(), 'auth.json');
    fs.writeFileSync(auth, '{}');
    const args = buildSubagentRunArgs({ runtime: 'podman', name: 'swarm-sub-codex-1', image: 'swarm-subagent:1', worktree: wt, kind: 'codex', authFile: auth, uid: 1000, gid: 1000 });
    assert.ok(args.includes(`${wt}:/work:rw`));
    assert.ok(args.includes(`${auth}:${AUTH_IN_CONTAINER.codex}:ro`));
    assert.equal(args.filter((a) => a.includes('.credentials.json') || a.includes('oauth_creds') || a.includes('/.claude')).length, 0, 'no other CLI credentials');
    assert.ok(args.includes('--userns=keep-id'), 'podman keeps the host uid');
    assert.equal(args.includes('--env-file') || args.includes('-e'), false, 'no env passed in');
    assert.equal(args.at(-1), 'swarm-subagent:1', 'image is last: the command is appended after it');
    assert.equal(args.some((a) => /GH_TOKEN|GITHUB_TOKEN|docker\.sock/.test(a)), false);
  });

  it('docker gets no --userns flag; both drop all capabilities and set no-new-privileges', () => {
    const wt = dir();
    const auth = path.join(dir(), 'c.json');
    fs.writeFileSync(auth, '{}');
    const args = buildSubagentRunArgs({ runtime: 'docker', name: 'swarm-sub-claude-1', image: 'swarm-subagent:1', worktree: wt, kind: 'claude', authFile: auth, uid: 1000, gid: 1000 });
    assert.equal(args.some((a) => a.startsWith('--userns')), false);
    assert.deepEqual(args.slice(args.indexOf('--cap-drop'), args.indexOf('--cap-drop') + 2), ['--cap-drop', 'ALL']);
    assert.ok(args.includes('no-new-privileges'));
  });

  it('refuses a relative worktree, a .git mount, a missing auth file, and an unknown kind (no content in the error)', () => {
    const wt = dir();
    const auth = path.join(dir(), 'a.json');
    fs.writeFileSync(auth, '{"secret":"x"}');
    const base = { runtime: 'podman', name: 'swarm-sub-x-1', image: 'i:1', uid: 1, gid: 1 };
    assert.throws(() => buildSubagentRunArgs({ ...base, worktree: 'rel', kind: 'codex', authFile: auth }), /absolute path/);
    assert.throws(() => buildSubagentRunArgs({ ...base, worktree: path.join(wt, '.git'), kind: 'codex', authFile: auth }), /refusing to mount a .git/);
    assert.throws(() => buildSubagentRunArgs({ ...base, worktree: wt, kind: 'codex', authFile: '/nope/x.json' }), /auth file for codex not found/);
    assert.throws(() => buildSubagentRunArgs({ ...base, worktree: wt, kind: 'mistral', authFile: auth }), /no sandbox auth path/);
    try {
      buildSubagentRunArgs({ ...base, worktree: wt, kind: 'codex', authFile: '/nope/x.json' });
    } catch (err) {
      assert.doesNotMatch(err.message, /secret/);
    }
  });
});

describe('runSubagent container path', () => {
  it('spawns the container runtime with the run args and the CLI command last, prompt on stdin, no cwd', async () => {
    const wt = dir();
    const auth = path.join(dir(), 'o.json');
    fs.writeFileSync(auth, '{}');
    const spawnFn = fakeSpawn({ stdout: 'DONE' });
    const r = await runSubagent({
      kind: 'gemini', model: 'gemini-2.5-flash-lite', worktree: wt, prompt: 'do it', allowedModels: allowed,
      runtime: 'container', image: 'swarm-subagent:1', containerRuntime: 'podman', authFiles: { gemini: auth }, uid: 1000, gid: 1000, spawnFn,
    });
    assert.equal(r.reply, 'DONE');
    const call = spawnFn.calls[0];
    assert.equal(call.cmd, 'podman');
    assert.equal(call.opts.cwd, undefined);
    const imageAt = call.args.indexOf('swarm-subagent:1');
    assert.equal(call.args[imageAt + 1], 'gemini', 'CLI command follows the image');
    assert.ok(call.args.includes('/work'), 'inner command uses /work, not the host path');
    assert.equal(call.child.stdin.data, 'do it');
  });

  it('a timeout kills the client and removes the named container', async () => {
    const wt = dir();
    const auth = path.join(dir(), 'o.json');
    fs.writeFileSync(auth, '{}');
    const spawnFn = fakeSpawn({ hang: true });
    await assert.rejects(runSubagent({
      kind: 'gemini', model: 'gemini-2.5-flash-lite', worktree: wt, prompt: 'x', allowedModels: allowed,
      runtime: 'container', image: 'i:1', containerRuntime: 'podman', authFiles: { gemini: auth }, spawnFn, timeoutMs: 30,
    }), /timed out/);
    const rm = spawnFn.calls.find((c) => c.args[0] === 'rm');
    assert.ok(rm, 'rm -f issued for the named container');
    assert.equal(rm.args[1], '-f');
    assert.match(rm.args[2], /^swarm-sub-gemini-/);
  });

  it('container runtime needs an image; an unknown runtime is refused', async () => {
    await assert.rejects(runSubagent({ kind: 'gemini', model: 'gemini-2.5-flash-lite', worktree: dir(), prompt: 'x', allowedModels: allowed, runtime: 'container', spawnFn: fakeSpawn() }), /needs an image/);
    await assert.rejects(runSubagent({ kind: 'gemini', model: 'gemini-2.5-flash-lite', worktree: dir(), prompt: 'x', allowedModels: allowed, runtime: 'vm', spawnFn: fakeSpawn() }), /unknown subagent runtime/);
  });
});

describe('subagent filesystem allowlist (guardrail 8, ARCHITECTURE 44)', () => {
  for (const kind of ['claude', 'codex', 'gemini']) {
    it(`${kind}: only the worktree (rw at /work) and its auth file (ro) are mounted; no env, socket, home or main .git`, () => {
      const main = dir(); // stands in for the main clone
      fs.mkdirSync(path.join(main, '.git', 'worktrees', 'w'), { recursive: true });
      const wt = dir();
      // A linked worktree's .git is a file pointing into the main clone's .git dir.
      fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'w')}\n`);
      const auth = path.join(dir(), 'auth.json');
      fs.writeFileSync(auth, '{}');
      for (const runtime of ['podman', 'docker']) {
        const args = buildSubagentRunArgs({ runtime, name: `swarm-sub-${kind}-1`, image: 'swarm-subagent:1', worktree: wt, kind, authFile: auth, uid: 1000, gid: 1000 });
        const mounts = [];
        args.forEach((a, i) => {
          if (['-v', '--volume', '--mount'].includes(a)) mounts.push(args[i + 1]);
          else if (/^(-v|--volume|--mount)=/.test(a)) mounts.push(a.split('=').slice(1).join('='));
        });
        assert.deepEqual(mounts.sort(), [`${wt}:/work:rw`, `${auth}:${AUTH_IN_CONTAINER[kind]}:ro`].sort(), 'exact mount allowlist');
        for (const m of mounts) {
          assert.doesNotMatch(m, /docker\.sock|podman\.sock|\/run\/|^\/:|:\/:/, 'no runtime socket or root mount');
          assert.equal(m.startsWith(`${main}`), false, 'main clone .git is not mounted (commits happen outside the container)');
          assert.equal(m.startsWith(`${os.homedir()}:`), false, 'no home dir mount');
        }
        for (const flag of ['-e', '--env', '--env-file', '--privileged', '--pid=host', '--network=host', '--volumes-from']) {
          assert.equal(args.some((a) => a === flag || a.startsWith(`${flag}=`)), false, `no ${flag}`);
        }
      }
    });
  }
});
