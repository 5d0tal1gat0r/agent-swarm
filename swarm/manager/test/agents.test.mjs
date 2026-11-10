import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { after, describe, it } from 'node:test';
import { commandAgent } from '../src/agents.mjs';

const made = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-agent-'));
  made.push(dir);
  return dir;
};
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

describe('container command agent', () => {
  it('runs the command in the worktree container with no .git and no GitHub token', async () => {
    const root = tmp();
    const wt = path.join(root, 'wt', 'T-0009');
    fs.mkdirSync(wt, { recursive: true });
    const calls = [];
    const spawnFn = (cmd, args) => {
      calls.push([cmd, ...args]);
      const child = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    const agent = commandAgent({ runtime: 'podman', image: 'node:22-bookworm-slim', command: ['node', '-e', 'process.exit(0)'], stateDir: root, managerName: 'me-core', uid: 1000, gid: 1000, spawnFn });
    const out = await agent({ task: { id: 'T-0009', acceptance: ['works'] }, worktree: wt });
    assert.deepEqual(out.evidence, [{ criterion: 'works', met: true, detail: 'exit 0 in node:22-bookworm-slim' }]);
    const [runtime, ...args] = calls[0];
    assert.equal(runtime, 'podman');
    assert.ok(args.includes(`${wt}:/work:rw`));
    assert.ok(args.indexOf('node:22-bookworm-slim') < args.indexOf('node'), 'command follows the image');
    assert.equal(args.some((a) => a.includes('.git')), false);
    const envFile = path.join(root, 'env-T-0009');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(envFile, 'utf8'), /GH_TOKEN/);
  });

  it('a failing container command fails the task', async () => {
    const root = tmp();
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt, { recursive: true });
    const spawnFn = () => {
      const child = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('close', 2));
      return child;
    };
    const agent = commandAgent({ runtime: 'docker', image: 'img', command: ['false'], stateDir: root, managerName: 'm', uid: 1, gid: 1, spawnFn });
    await assert.rejects(agent({ task: { id: 'T-0010', acceptance: ['x'] }, worktree: wt }), /agent command failed \(exit 2\)/);
  });
});
