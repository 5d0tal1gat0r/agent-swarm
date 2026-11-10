import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { parseDepartments, parsePolicy } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { addManager } from '../src/tokens.mjs';
import { createServer, listen } from '../src/api.mjs';
import { verifyOrchestrator } from '../../shared/locate.mjs';
import { validate } from '../../protocol/validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');
const SHA = 'd'.repeat(40);
const EVIDENCE = [{ criterion: 'works', met: true, detail: 'tested' }];

function clock(start = '2026-11-01T18:00:00.000Z') {
  let t = Date.parse(start);
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('api', () => {
  let server, base, store, ck, tokensFile, dir;
  const token = {};
  const pauseState = { on: false };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-api-'));
    tokensFile = path.join(dir, 'managers.json');
    const depts = parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8'));
    // core is hosted by alice, with bob as standby. Everything else stays with the owner.
    depts.departments.core.host = 'alice';
    depts.departments.core.standby = 'bob';
    const departments = parseDepartments(depts);
    const policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
    token.alice = addManager(tokensFile, { name: 'alice-core', member: 'alice', departments: ['core'] });
    token.bob = addManager(tokensFile, { name: 'bob-core', member: 'bob', departments: ['core'] });
    token.owner = addManager(tokensFile, { name: 'owner-intake', member: 'owner', departments: [], roles: ['intake'] });
    token.outsider = addManager(tokensFile, { name: 'docs-mgr', member: 'carol', departments: ['docs'] });
    token.dash = addManager(tokensFile, { name: 'server-dashboard', member: 'owner', departments: [], roles: ['dashboard'] });
    ck = clock();
    store = openStore({ clock: ck, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    store.createTask({ id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'one', department: 'core', priority: 'p1', size: 'S', paths: ['swarm/orchestrator/src/x.mjs'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 } });
    const made = createServer({ store, departments, policy, tokensFile, clock: ck, guard: { isPaused: () => pauseState.on, status: () => ({ reason: 'incident' }) }, log: { error() {} } });
    server = made.server;
    const addr = await listen(server, { host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const call = (who, method, url, body, headers = {}) => fetch(`${base}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${token[who]}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it('refuses requests without a valid token', async () => {
    assert.equal((await call(null, 'GET', '/departments/core/queue')).status, 401);
    assert.equal((await call('outsider', 'GET', '/departments/core/queue')).status, 200, 'any valid token may read the queue');
    const bad = await fetch(`${base}/departments/core/queue`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(bad.status, 401);
  });

  it('whoami proves the token hash to the real manager only, without a bearer', async () => {
    assert.equal(await verifyOrchestrator(base, { manager: 'alice-core', token: token.alice }), true);
    assert.equal(await verifyOrchestrator(base, { manager: 'alice-core', token: token.bob }), false, 'wrong token');
    assert.equal(await verifyOrchestrator(base, { manager: 'nobody', token: token.alice }), false, 'unknown manager');
    assert.equal((await call(null, 'POST', '/whoami', { manager: 'alice-core', nonce: 'not hex!' })).status, 404);
  });

  it('paused: lease returns no task and a reason, then works again after resume', async () => {
    pauseState.on = true;
    const r = await call('alice', 'POST', '/tasks/lease', { department: 'core', slots: 1, manager: 'alice-core' });
    pauseState.on = false;
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { tasks: [], paused: 'swarm paused: incident' });
    assert.equal(store.getTask('T-0001').status, 'queued', 'nothing leased');
  });

  it('dashboard token reads the snapshot: tasks, epics, managers, metrics; no history inline', async () => {
    const r = await call('dash', 'GET', '/snapshot');
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.at, 'string');
    const t = r.body.tasks.find((x) => x.id === 'T-0001');
    assert.equal(t.title, 'one');
    assert.equal(t.department, 'core');
    assert.equal(t.history, undefined, 'history comes from /tasks/:id/history');
    assert.deepEqual(r.body.epics.map((e) => e.id), ['E-0001']);
    const names = r.body.managers.map((m) => m.name);
    assert.ok(names.includes('alice-core') && !names.includes('server-dashboard') && !names.includes('owner-intake'), 'manager-role tokens only');
    assert.ok(r.body.managers.every((m) => ['idle', 'busy', 'offline'].includes(m.state)));
    assert.equal(r.body.managers.find((m) => m.name === 'alice-core').member, 'alice');
    assert.deepEqual(r.body.managers.find((m) => m.name === 'alice-core').departments, ['core']);
    assert.ok(r.body.departments.includes('core'));
    assert.deepEqual(r.body.pauses, { departments: {}, managers: {} });
    assert.equal(typeof r.body.metrics.statusCounts, 'object');
    assert.ok(!JSON.stringify(r.body).includes('hash'), 'no token hashes');
  });

  it('snapshot departmentInfo matches each loaded department; the departments id list is unchanged', async () => {
    const doc = parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8'));
    doc.departments.core.host = 'alice';
    const r = await call('dash', 'GET', '/snapshot');
    assert.equal(r.status, 200);
    const expected = Object.entries(doc.departments).map(([id, d]) => ({
      id, agent: d.agent, paths: d.paths, concurrency: d.concurrency, maxSubagents: d.maxSubagents, host: d.host,
    }));
    assert.deepEqual(r.body.departmentInfo, expected);
    assert.deepEqual(r.body.departments, Object.keys(doc.departments), 'id list unchanged');
  });

  it('member and owner tokens get the same departmentInfo', async () => {
    const member = await call('alice', 'GET', '/snapshot');
    const owner = await call('dash', 'GET', '/snapshot');
    assert.equal(member.status, 200);
    assert.equal(owner.status, 200);
    assert.ok(member.body.departmentInfo.length > 0);
    assert.deepEqual(member.body.departmentInfo, owner.body.departmentInfo);
  });

  it('the whole snapshot response validates against api/snapshot.response; a bad departmentInfo entry is rejected', async () => {
    const r = await call('dash', 'GET', '/snapshot');
    assert.deepEqual(validate('api/snapshot.response', r.body), { ok: true, errors: [] });
    const bad = structuredClone(r.body);
    bad.departmentInfo[0].agent = 'gpt';
    const check = validate('api/snapshot.response', bad);
    assert.equal(check.ok, false);
    assert.match(check.errors.join('\n'), /\/departmentInfo\/0\/agent/);
  });

  it('task history and /me; the dashboard role is refused on writes and other reads', async () => {
    const h = await call('dash', 'GET', '/tasks/T-0001/history');
    assert.equal(h.status, 200);
    assert.ok(Array.isArray(h.body.history));
    assert.equal((await call('dash', 'GET', '/tasks/T-9999/history')).status, 404);
    assert.deepEqual((await call('dash', 'GET', '/me')).body, { name: 'server-dashboard', member: 'owner', roles: ['dashboard'] });
    assert.equal((await call('alice', 'GET', '/me')).body.name, 'alice-core');
    assert.equal((await call(null, 'GET', '/me')).status, 401);
    assert.equal((await call('dash', 'POST', '/tasks/lease', { manager: 'server-dashboard', department: 'core', slots: 1 })).status, 403);
    assert.equal((await call('dash', 'GET', '/departments/core/queue')).status, 403);
    assert.equal((await call('alice', 'GET', '/snapshot')).status, 200, 'managers may read the snapshot too');
    assert.equal((await call('owner', 'GET', '/snapshot')).status, 403, 'intake-only token may not');
  });

  it('health is open', async () => {
    assert.equal((await call(null, 'GET', '/health')).status, 200);
  });

  it('a manager not bound to the department cannot lease it', async () => {
    const r = await call('outsider', 'POST', '/tasks/lease', { department: 'core', slots: 1, manager: 'docs-mgr' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /not bound to core/);
  });

  it('the body manager must match the token', async () => {
    const r = await call('alice', 'POST', '/tasks/lease', { department: 'core', slots: 1, manager: 'bob-core' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /does not match token/);
  });

  it('a standby may not lease while the host is online', async () => {
    await call('alice', 'POST', '/managers/heartbeat', { manager: 'alice-core', agent: 'claude', version: '1', freeSlots: 1, running: [] });
    const r = await call('bob', 'POST', '/tasks/lease', { department: 'core', slots: 1, manager: 'bob-core' });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /host alice is online/);
  });

  it('the host leases, and a repeated Idempotency-Key returns the same result', async () => {
    const first = await call('alice', 'POST', '/tasks/lease', { department: 'core', slots: 1, manager: 'alice-core' }, { 'idempotency-key': 'k1' });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.tasks.map((t) => t.id), ['T-0001']);
    const again = await call('alice', 'POST', '/tasks/lease', { department: 'core', slots: 1, manager: 'alice-core' }, { 'idempotency-key': 'k1' });
    assert.deepEqual(again.body.tasks.map((t) => t.id), ['T-0001']);
  });

  it('progress, then submit, through the API', async () => {
    const p = await call('alice', 'POST', '/tasks/T-0001/progress', { manager: 'alice-core', phase: 'checks', note: 'running', tokens: 100 });
    assert.equal(p.status, 200);
    assert.equal(p.body.task.status, 'in_progress');
    const s = await call('alice', 'POST', '/tasks/T-0001/submit', { manager: 'alice-core', pr: 12, headSha: SHA, evidence: EVIDENCE });
    assert.equal(s.status, 200);
    assert.equal(s.body.task.status, 'submitted');
  });

  it('a wrong holder gets 409, an unknown task 404', async () => {
    const r = await call('alice', 'POST', '/tasks/T-0001/progress', { manager: 'alice-core', phase: 'pr', note: '', tokens: 0 });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /not leased by alice-core/);
    assert.equal((await call('alice', 'GET', '/tasks/T-9999')).status, 404);
  });

  it('an invalid body is rejected with the field named', async () => {
    const r = await call('alice', 'POST', '/tasks/T-0001/fail', { manager: 'alice-core', reason: '' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /\/reason/);
  });

  it('an oversized body is refused', async () => {
    const big = { manager: 'alice-core', reason: 'x'.repeat(2 * 1024 * 1024) };
    const r = await call('alice', 'POST', '/tasks/T-0001/fail', big);
    assert.equal(r.status, 413);
  });

  it('only an intake token may create an epic', async () => {
    const denied = await call('alice', 'POST', '/epics', { repo: 'o/r', title: 'x', body: 'y' });
    assert.equal(denied.status, 403);
    const ok = await call('owner', 'POST', '/epics', { repo: 'o/r', title: 'Pilot', body: 'queue inspection' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.epic.id, 'E-0002');
  });

  it('the department queue view lists only queued tasks, in order', async () => {
    store.createTask({ id: 'T-0002', epicId: 'E-0002', repo: 'o/r', title: 'two', department: 'core', priority: 'p0', size: 'S', paths: ['swarm/orchestrator/src/y.mjs'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 } });
    const r = await call('outsider', 'GET', '/departments/core/queue');
    assert.deepEqual(r.body.tasks.map((t) => t.id), ['T-0002']);
  });

  it('a standby may lease once the host has been silent past the stale window', async () => {
    ck.advance(3 * 60_000);
    const r = await call('bob', 'POST', '/tasks/lease', { department: 'core', slots: 1, manager: 'bob-core' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tasks.map((t) => t.id), ['T-0002']);
  });
});

describe('api restart', () => {
  it('keeps heartbeats across a restart: alive when recent, silent once stale', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-api-restart-'));
    const tokensFile = path.join(dir, 'managers.json');
    const dbFile = path.join(dir, 'swarm.db');
    const depts = parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8'));
    depts.departments.core.host = 'alice';
    depts.departments.core.standby = 'bob';
    const departments = parseDepartments(depts);
    const policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
    const alice = addManager(tokensFile, { name: 'alice-core', member: 'alice', departments: ['core'] });
    const bob = addManager(tokensFile, { name: 'bob-core', member: 'bob', departments: ['core'] });
    const ck = clock();

    async function boot() {
      const store = openStore({ path: dbFile, clock: ck });
      const made = createServer({ store, departments, policy, tokensFile, clock: ck, log: { error() {} } });
      const addr = await listen(made.server, { host: '127.0.0.1', port: 0 });
      const base = `http://127.0.0.1:${addr.port}`;
      const post = (tok, url, body) => fetch(`${base}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
        body: JSON.stringify(body),
      }).then((r) => r.status);
      return { store, made, post, stop: () => { made.server.close(); store.close(); } };
    }
    const lease = (a) => a.post(bob, '/tasks/lease', { department: 'core', slots: 1, manager: 'bob-core' });

    const first = await boot();
    first.store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    assert.equal(await first.post(alice, '/managers/heartbeat', { manager: 'alice-core', agent: 'claude', version: '1', freeSlots: 1, running: [] }), 200);
    first.stop();

    ck.advance(30_000);
    const second = await boot();
    assert.equal(second.made.heartbeats.get('alice-core').at, Date.parse('2026-11-01T18:00:00.000Z'));
    assert.equal(await lease(second), 403, 'host still alive after restart');

    ck.advance(policy.limits.heartbeatStaleMinutes * 60_000);
    assert.equal(await lease(second), 200, 'host silent since before the restart');
    second.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('listen', () => {
  it('refuses to bind every interface', async () => {
    const store = openStore({ clock: clock() });
    const { server } = createServer({
      store,
      departments: parseDepartments(parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8'))),
      policy: parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8'))),
      tokensFile: path.join(os.tmpdir(), 'nope-missing.json'),
      clock: clock(),
      log: { error() {} },
    });
    await assert.rejects(listen(server, { host: '0.0.0.0', port: 0 }), /refusing to bind all interfaces/);
    await assert.rejects(listen(server, { host: '::', port: 0 }), /refusing to bind all interfaces/);
    store.close();
  });
});

describe('open PR cap per manager', () => {
  it('at the cap a manager gets its fix but no new task, with a reason; below the cap it leases', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-api-cap-'));
    const tokensFile = path.join(dir, 'managers.json');
    const alice = addManager(tokensFile, { name: 'alice-core', member: 'alice', departments: ['core'] });
    const ck = clock();
    const store = openStore({ clock: ck, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    for (let i = 1; i <= 4; i += 1) {
      store.createTask({ id: `T-000${i}`, epicId: 'E-0001', repo: 'o/r', title: `t${i}`, department: 'core', priority: 'p1', size: 'S', paths: ['swarm/x.mjs'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 } });
    }
    const doc = parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8'));
    doc.departments.core.host = 'alice';
    const departments = parseDepartments(doc);
    const policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
    assert.equal(policy.limits.maxOpenPrsPerManager, 2);
    const { server } = createServer({ store, departments, policy, tokensFile, clock: ck, log: { error() {} } });
    const addr = await listen(server, { host: '127.0.0.1', port: 0 });
    const lease = (slots) => fetch(`http://127.0.0.1:${addr.port}/tasks/lease`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice}` },
      body: JSON.stringify({ department: 'core', slots, manager: 'alice-core' }),
    }).then((r) => r.json());
    const submit = (id, pr) => {
      store.progress({ id, manager: 'alice-core', phase: 'checks', note: '', tokens: 1 });
      store.submit({ id, manager: 'alice-core', pr, headSha: SHA, evidence: EVIDENCE });
    };
    try {
      assert.deepEqual((await lease(2)).tasks.map((t) => t.id), ['T-0001', 'T-0002']);
      submit('T-0001', 1);
      const one = await lease(1);
      assert.deepEqual(one.tasks.map((t) => t.id), ['T-0003'], '1 open PR: below the cap');
      submit('T-0002', 2); // 2 open PRs now, T-0003 still unfinished and PR-less
      store.startReview('T-0001');
      store.requestChanges('T-0001', ['fix it']);
      const capped = await lease(2);
      assert.deepEqual(capped.tasks.map((t) => t.id), ['T-0001'], 'fix still comes back');
      assert.match(capped.limited, /2 open PRs/);
      assert.equal(store.getTask('T-0004').status, 'queued', 'new task not leased');
      store.startReview('T-0002');
      store.markMerged('T-0002');
    } finally {
      server.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
