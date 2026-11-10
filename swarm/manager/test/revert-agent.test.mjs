import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { revertAgent, revertShaOf } from '../src/revert-agent.mjs';
import { git } from '../src/worktree.mjs';

const ID = { name: 't', email: 't@t' };
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

describe('revert agent', () => {
  it('reads the sha from the revert criterion; ordinary tasks have none', () => {
    const sha = 'b'.repeat(40);
    assert.equal(revertShaOf({ acceptance: ['works', `revert ${sha}`] }), sha);
    assert.equal(revertShaOf({ acceptance: ['works'] }), null);
    assert.equal(revertShaOf({ acceptance: ['revert not-a-sha'] }), null);
  });

  it('stages the inverse of the commit in the worktree, so the task commit records it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-revert-'));
    made.push(dir);
    await git(dir, ['init', '--quiet']);
    fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['-c', `user.name=${ID.name}`, '-c', `user.email=${ID.email}`, 'commit', '--quiet', '-m', 'base']);
    fs.writeFileSync(path.join(dir, 'bad.txt'), 'bad\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['-c', `user.name=${ID.name}`, '-c', `user.email=${ID.email}`, 'commit', '--quiet', '-m', 'culprit']);
    const culprit = await git(dir, ['rev-parse', 'HEAD']);
    const task = { id: 'T-1201', acceptance: ['the revert applies', `revert ${culprit}`] };
    const out = await revertAgent({ task, worktree: dir });
    assert.equal(fs.existsSync(path.join(dir, 'bad.txt')), false, 'bad.txt removed in the working tree');
    const status = await git(dir, ['status', '--porcelain']);
    assert.match(status, /D  bad\.txt/, 'deletion is staged for the commit step');
    assert.equal(out.evidence.length, 2);
    assert.ok(out.evidence.every((e) => e.met));
  });

  it('refuses a task without a revert criterion', async () => {
    await assert.rejects(revertAgent({ task: { acceptance: ['x'] }, worktree: os.tmpdir() }), /no revert criterion/);
  });
});
