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
import { canActOnManager, canActOnTask, readPauses } from '../src/controls.mjs';

const SWARM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const task = (id, extra = {}) => ({ id, epicId: 'E-0001', repo: 'o/r', title: id, department: 'core', priority: 'p1', size: 'S', paths: [`swarm/orchestrator/src/${id}.mjs`], dependsOn: [], acceptance: ['works'], budget: { tokens: 1000, minutes: 30 }, ...extra });

describe('control permissions (pure)', () => {
  const tokens = { managers: { 'alice-core': { member: 'alice', roles: ['manager'] }, 'bob-core': { member: 'bob', roles: ['manager'] } } };
  const alice = { name: 'alice-core', member: 'alice', roles: ['manager'] };
  const owner = { name: 'owner-ops', member: 'owner', roles: ['manager', 'owner'] };
  it('owner acts on everything; a member only on tasks and managers of their own member', () => {
    assert.equal(canActOnTask(owner, { holder: 'bob-core' }, tokens), true);
    assert.equal(canActOnTask(alice, { holder: 'alice-core' }, tokens), true);
    assert.equal(canActOnTask(alice, { holder: 'bob-core' }, tokens), false);
    assert.equal(canActOnTask(alice, { holder: null }, tokens), false, 'unheld tasks are owner-only');
    assert.equal(canActOnManager(alice, 'alice-core', tokens), true);
    assert.equal(canActOnManager(alice, 'bob-core', tokens), false);
    assert.equal(canActOnManager(owner, 'bob-core', tokens), true);
  });
});

describe('operator API', () => {
  let server, base, store, dir;
  const token = {};
  const posts = [];
  const busState = new Map();
  const bus = {
    send: async (ch, text) => { posts.push([ch, text]); return 'ok'; },
    setState: async (ns, key, value) => { busState.set(`${ns}/${key}`, value); return 'ok'; },
    getState: async (ns, key) => busState.get(`${ns}/${key}`) ?? null,
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-controls-'));
    const tokensFile = path.join(dir, 'managers.json');
    const departments = parseDepartments(parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8')));
    const policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
    token.alice = addManager(tokensFile, { name: 'alice-core', member: 'owner', departments: ['core'] });
    token.bob = addManager(tokensFile, { name: 'bob-core', member: 'bob', departments: ['core'] });
    token.owner = addManager(tokensFile, { name: 'owner-ops', member: 'owner', departments: [], roles: ['manager', 'owner'] });
    token.dash = addManager(tokensFile, { name: 'server-dashboard', member: 'owner', departments: [], roles: ['dashboard'] });
    store = openStore({ leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    store.createTask(task('T-0001'));
    store.createTask(task('T-0002'));
    store.createTask(task('T-0003'));
    store.lease({ department: 'core', slots: 1, manager: 'bob-core' }); // bob holds T-0001
    const made = createServer({ store, departments, policy, tokensFile, bus, log: { error() {}, warn() {} } });
    server = made.server;
    base = `http://127.0.0.1:${(await listen(server, { host: '127.0.0.1', port: 0 })).port}`;
  });
  after(() => { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const call = (who, method, url, body) => fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${token[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it('task actions: a reason is required, roles are checked, history and bus record the move', async () => {
    assert.equal((await call('owner', 'POST', '/operator/tasks/T-0002/cancel', {})).status, 400);
    assert.equal((await call('dash', 'POST', '/operator/tasks/T-0002/cancel', { reason: 'not needed' })).status, 403);
    assert.equal((await call('alice', 'POST', '/operator/tasks/T-0001/cancel', { reason: 'not mine' })).status, 403, 'bob holds it');
    assert.equal((await call('bob', 'POST', '/operator/tasks/T-0001/bogus', { reason: 'xyz' })).status, 404);
    const ok = await call('bob', 'POST', '/operator/tasks/T-0001/cancel', { reason: 'duplicate of T-0002' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.task.status, 'cancelled');
    assert.match(store.history('T-0001').at(-1).reason, /duplicate of T-0002 \(by bob-core\)/);
    assert.ok(posts.some(([ch, text]) => ch === 'swarm' && /operator cancel/.test(text)));
    assert.equal((await call('owner', 'POST', '/operator/tasks/T-0002/resolve', { reason: 'wrong move' })).status, 409, 'queued cannot be resolved');
    assert.equal((await call(null, 'POST', '/operator/tasks/T-0002/cancel', { reason: 'xyz' })).status, 401);
  });

  it('global pause and resume are owner-only and write bus state swarm/paused', async () => {
    assert.equal((await call('alice', 'POST', '/operator/pause', { reason: 'incident' })).status, 403);
    assert.equal((await call('owner', 'POST', '/operator/pause', {})).status, 400);
    assert.equal((await call('owner', 'POST', '/operator/pause', { reason: 'incident' })).status, 200);
    assert.equal(JSON.parse(busState.get('swarm/paused')).paused, true);
    assert.equal(JSON.parse(busState.get('swarm/paused')).by, 'owner-ops');
    assert.equal((await call('owner', 'POST', '/operator/resume', { reason: 'fixed' })).status, 200);
    assert.equal(JSON.parse(busState.get('swarm/paused')).paused, false);
  });

  it('department pause is owner-only and stops leasing that department', async () => {
    assert.equal((await call('alice', 'POST', '/operator/departments/core/pause', { reason: 'refactor' })).status, 403);
    assert.equal((await call('owner', 'POST', '/operator/departments/nope/pause', { reason: 'refactor' })).status, 404);
    assert.equal((await call('owner', 'POST', '/operator/departments/core/pause', { reason: 'refactor' })).status, 200);
    assert.equal(readPauses(store).departments.core.by, 'owner-ops');
    const lease = await call('alice', 'POST', '/tasks/lease', { manager: 'alice-core', department: 'core', slots: 1 });
    assert.deepEqual(lease.body.tasks, []);
    assert.match(lease.body.paused, /department core paused: refactor/);
    assert.equal((await call('owner', 'POST', '/operator/departments/core/resume', { reason: 'done' })).status, 200);
    assert.equal(readPauses(store).departments.core, undefined);
  });

  it('manager pause: the member or the owner; a paused manager leases nothing', async () => {
    assert.equal((await call('bob', 'POST', '/operator/managers/alice-core/pause', { reason: 'nope' })).status, 403);
    assert.equal((await call('owner', 'POST', '/operator/managers/ghost/pause', { reason: 'nope' })).status, 404);
    assert.equal((await call('alice', 'POST', '/operator/managers/alice-core/pause', { reason: 'going offline' })).status, 200);
    const lease = await call('alice', 'POST', '/tasks/lease', { manager: 'alice-core', department: 'core', slots: 1 });
    assert.deepEqual(lease.body.tasks, []);
    assert.match(lease.body.paused, /manager alice-core paused: going offline/);
    const snap = await call('dash', 'GET', '/snapshot');
    assert.equal(snap.body.pauses.managers['alice-core'].reason, 'going offline');
    assert.equal((await call('owner', 'POST', '/operator/managers/alice-core/resume', { reason: 'back' })).status, 200);
    const again = await call('alice', 'POST', '/tasks/lease', { manager: 'alice-core', department: 'core', slots: 1 });
    assert.equal(again.body.tasks.length, 1);
  });

  it('create an epic from a form: any member token; dashboard token refused; validated', async () => {
    assert.equal((await call('dash', 'POST', '/operator/epics', { title: 'x', body: 'y' })).status, 403);
    assert.equal((await call('alice', 'POST', '/operator/epics', { title: '', body: 'y' })).status, 400);
    const r = await call('alice', 'POST', '/operator/epics', { title: 'Queue inspection', body: 'pilot epic' });
    assert.equal(r.status, 201);
    assert.equal(r.body.epic.title, 'Queue inspection');
    assert.equal(r.body.epic.source, 'human');
    assert.ok(posts.some(([, text]) => /operator epic .* by alice-core/.test(text)));
  });

  it('amend (ARCHITECTURE 63): owner only; paths stay in the department or a contract; dropping a dependency unblocks', async () => {
    store.createTask(task('T-0010'));
    store.createTask(task('T-0011', { dependsOn: ['T-0010'] }));
    assert.equal(store.getTask('T-0011').status, 'blocked');
    const amend = (who, body) => call(who, 'POST', '/operator/tasks/T-0011/amend', body);
    assert.equal((await amend('bob', { reason: 'widen', paths: ['swarm/orchestrator/src/x.mjs'] })).status, 403, 'members may not amend');
    assert.equal((await amend('owner', { paths: ['swarm/orchestrator/src/x.mjs'] })).status, 400, 'reason required');
    assert.equal((await amend('owner', { reason: 'widen', paths: ['swarm/manager/src/x.mjs'] })).status, 400, 'another department');
    assert.equal((await amend('owner', { reason: 'widen', paths: ['../etc/passwd'] })).status, 400);
    assert.equal((await amend('owner', { reason: 'drop', dropDependsOn: ['T-0003'] })).status, 400, 'not a dependency');
    const widened = await amend('owner', { reason: 'needs the schema too', paths: ['swarm/orchestrator/src/T-0011.mjs', 'swarm/protocol/api/x.schema.json'], acceptance: ['route and schema agree'] });
    assert.equal(widened.status, 200);
    assert.deepEqual(widened.body.task.paths, ['swarm/orchestrator/src/T-0011.mjs', 'swarm/protocol/api/x.schema.json'], 'a contract path is allowed');
    assert.equal(widened.body.task.status, 'blocked', 'still waits for T-0010');
    const dropped = await amend('owner', { reason: 'T-0010 is not needed', dropDependsOn: ['T-0010'] });
    assert.equal(dropped.status, 200);
    assert.deepEqual([dropped.body.task.status, dropped.body.task.dependsOn, dropped.body.task.attempts], ['queued', [], 0]);
    assert.match(dropped.body.task.history.at(-1).reason, /^amended: dropped T-0010: T-0010 is not needed \(by owner-ops\)/);
    assert.equal((await amend('owner', { reason: 'again', acceptance: ['x'] })).status, 409, 'a queued task is not amendable');
    assert.ok(posts.some(([, text]) => /operator amend T-0011: T-0010 is not needed by owner-ops/.test(text)));
  });
});
