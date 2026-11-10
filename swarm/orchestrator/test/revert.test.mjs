import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore } from '../src/store.mjs';
import { revertMainRed } from '../src/revert.mjs';

const SHA = 'a'.repeat(40);
const policy = { budgets: { S: { tokens: 500000, minutes: 30 }, M: { tokens: 1500000, minutes: 60 } } };
const fakeGh = ({ prs = [9], title = 'Swarm: feature', files = ['swarm/orchestrator/src/x.mjs', 'docs/x.md'] } = {}) => ({
  async pullsForCommit() { return prs; },
  async pr(n) { return { number: n, title }; },
  async files() { return files; },
});
const store = () => {
  const s = openStore({ clock: { now: () => Date.now() }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
  return s;
};

describe('main red revert', () => {
  it('creates one platform p0 task with the culprit PR files, in its own monitor epic', async () => {
    const s = store();
    const r = await revertMainRed({ store: s, gh: fakeGh(), sha: SHA, repo: 'o/r', policy });
    assert.equal(r.status, 'created');
    const t = s.getTask(r.taskId);
    assert.equal(t.department, 'platform');
    assert.equal(t.priority, 'p0');
    assert.equal(t.size, 'M');
    assert.deepEqual(t.paths, ['swarm/orchestrator/src/x.mjs', 'docs/x.md']);
    assert.ok(t.acceptance.includes(`revert ${SHA}`));
    assert.equal(s.getEpic(t.epicId).source, 'monitor');
    assert.match(s.getEpic(t.epicId).title, /Revert PR #9/);
    s.close();
  });

  it('a second call for the same sha creates nothing', async () => {
    const s = store();
    await revertMainRed({ store: s, gh: fakeGh(), sha: SHA, repo: 'o/r', policy });
    const again = await revertMainRed({ store: s, gh: fakeGh(), sha: SHA, repo: 'o/r', policy });
    assert.equal(again.status, 'exists');
    assert.equal(s.listTasks().length, 1);
    s.close();
  });

  it('a head with no PR is skipped, not an error', async () => {
    const s = store();
    const r = await revertMainRed({ store: s, gh: fakeGh({ prs: [] }), sha: SHA, repo: 'o/r', policy });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /no PR/);
    assert.equal(s.listTasks().length, 0);
    s.close();
  });

  it('never reverts a revert, so a red revert cannot loop', async () => {
    const s = store();
    const r = await revertMainRed({ store: s, gh: fakeGh({ title: 'Revert PR #9 (main red at abc1234)' }), sha: SHA, repo: 'o/r', policy });
    assert.equal(r.status, 'skipped');
    assert.match(r.reason, /not reverting a revert/);
    s.close();
  });

  it('a PR that changes no files is skipped', async () => {
    const s = store();
    const r = await revertMainRed({ store: s, gh: fakeGh({ files: [] }), sha: SHA, repo: 'o/r', policy });
    assert.equal(r.status, 'skipped');
    s.close();
  });
});
