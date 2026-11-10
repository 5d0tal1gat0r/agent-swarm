import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { openStore } from '../src/store.mjs';
import { ownerOf, queueView, routePaths, UNOWNED_DEPARTMENT } from '../src/router.mjs';
import { parseDepartments } from '../src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');
const depts = () => parseDepartments(parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8')));

describe('routing: rule 1, one owner per task', () => {
  it('a task inside one department routes there, as one work group', () => {
    const r = routePaths(depts(), ['swarm/orchestrator/src/api.mjs', 'swarm/orchestrator/test/api.test.mjs']);
    assert.deepEqual(r.groups, [{ department: 'core', kind: 'work', paths: ['swarm/orchestrator/src/api.mjs', 'swarm/orchestrator/test/api.test.mjs'], dependsOnContract: false }]);
    assert.deepEqual(r.alerts, []);
  });

  it('ownerOf finds the single owning department', () => {
    assert.equal(ownerOf(depts(), 'autopilot/src/worker.mjs'), 'runtime');
    assert.equal(ownerOf(depts(), 'autopilot/README.md'), 'docs');
    assert.equal(ownerOf(depts(), 'no/such/file.txt'), null);
  });
});

describe('routing: rule 2, split with contract first', () => {
  it('a contract path splits off as a contract group that work groups depend on', () => {
    const r = routePaths(depts(), ['swarm/protocol/api/queue.response.schema.json', 'swarm/orchestrator/src/api.mjs', 'swarm/manager/bin/manager.mjs']);
    const kinds = r.groups.map((g) => `${g.kind}:${g.department}`);
    assert.deepEqual(kinds, ['contract:core', 'work:core', 'work:runtime']);
    assert.equal(r.groups[0].dependsOnContract, false);
    assert.equal(r.groups[1].dependsOnContract, true);
    assert.equal(r.groups[2].dependsOnContract, true);
  });

  it('paths across departments without contracts split into independent groups', () => {
    const r = routePaths(depts(), ['swarm/orchestrator/src/api.mjs', 'docs/swarm.md']);
    assert.deepEqual(r.groups.map((g) => `${g.kind}:${g.department}:${g.dependsOnContract}`), ['work:core:false', 'work:docs:false']);
  });
});

describe('routing: rule 3, unowned paths', () => {
  it('an unowned path goes to platform and raises alert.unowned_path', () => {
    const r = routePaths(depts(), ['random/thing.bin']);
    assert.deepEqual(r.groups, [{ department: UNOWNED_DEPARTMENT, kind: 'work', paths: ['random/thing.bin'], dependsOnContract: false }]);
    assert.deepEqual(r.alerts, [{ type: 'alert.unowned_path', department: 'platform', path: 'random/thing.bin' }]);
  });

  it('rejects an empty path list', () => {
    assert.throws(() => routePaths(depts(), []), /at least one path/);
  });
});

describe('queue view: rule order and dependsOn gating', () => {
  function store() {
    const clock = { t: Date.parse('2026-11-01T18:00:00.000Z'), now() { return this.t; } };
    const s = openStore({ clock });
    s.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    return s;
  }
  const task = (id, extra = {}) => ({
    id, epicId: 'E-0001', repo: 'o/r', title: id, department: 'core', priority: 'p1', size: 'S',
    paths: [`swarm/orchestrator/src/${id}.mjs`], dependsOn: [], acceptance: ['ok'],
    budget: { tokens: 500000, minutes: 30 }, ...extra,
  });

  it('lists queued tasks by priority, and hides blocked ones', () => {
    const s = store();
    s.createTask(task('T-0001', { priority: 'p2' }));
    s.createTask(task('T-0002', { priority: 'p0' }));
    s.createTask(task('T-0003'));
    s.createTask(task('T-0004', { dependsOn: ['T-0003'] }));
    assert.deepEqual(queueView(s, 'core').map((t) => t.id), ['T-0002', 'T-0003', 'T-0001']);
  });

  it('a blocked task joins the queue only after its dependency merges', () => {
    const s = store();
    s.createTask(task('T-0001'));
    s.createTask(task('T-0002', { dependsOn: ['T-0001'] }));
    assert.deepEqual(queueView(s, 'core').map((t) => t.id), ['T-0001']);
    s.lease({ department: 'core', slots: 1, manager: 'm' });
    s.progress({ id: 'T-0001', manager: 'm', phase: 'pr', note: '', tokens: 0 });
    s.submit({ id: 'T-0001', manager: 'm', pr: 3, headSha: 'b'.repeat(40), evidence: [{ criterion: 'ok', met: true, detail: '' }] });
    s.startReview('T-0001');
    s.markMerged('T-0001');
    assert.deepEqual(queueView(s, 'core').map((t) => t.id), ['T-0002']);
  });
});
