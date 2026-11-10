import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { parseDepartments, parsePolicy } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { addManager, readTokens } from '../src/tokens.mjs';
import { createServer, listen } from '../src/api.mjs';
import { createJobs } from '../src/admin.mjs';

const SWARM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('jobs (pure)', () => {
  it('runs one job of a kind at a time and records the result or the error', async () => {
    let release;
    const jobs = createJobs({ clock: { now: () => 1000 } });
    const a = jobs.start('plan:E-1', () => new Promise((r) => { release = r; }));
    assert.equal(a.status, 'running');
    assert.throws(() => jobs.start('plan:E-1', async () => 1), /already running/);
    await new Promise((r) => setImmediate(r)); // the job body starts on the next tick
    release({ tasks: 3 });
    await jobs.settled(a.id);
    assert.deepEqual(jobs.get(a.id).result, { tasks: 3 });
    assert.equal(jobs.get(a.id).status, 'done');
    const b = jobs.start('plan:E-1', async () => { throw new Error('model said no'); });
    await jobs.settled(b.id);
    assert.equal(jobs.get(b.id).status, 'failed');
    assert.equal(jobs.get(b.id).error, 'model said no');
    assert.equal(jobs.get('nope'), null);
  });
});

describe('admin API', () => {
  let server, base, store, dir, tokensFile;
  const token = {};
  const posts = [];
  const calls = [];
  const bus = { send: async (ch, text) => { posts.push(text); return 'ok'; }, setState: async () => 'ok', getState: async () => null };
  const ops = {
    plan: async (epicId, { dryRun }) => { calls.push(['plan', epicId, dryRun]); return { model: 'm', tasks: [{ key: 'a', department: 'core', title: 'x' }], written: !dryRun }; },
    intakeOnce: async () => { calls.push(['intake']); return { created: [{ id: 'E-0002' }], skipped: [], errors: [] }; },
    backup: () => { calls.push(['backup']); return '/home/x/.swarm/backups/manual-1.db'; },
    info: () => ({ version: 'abc1234', startedAt: '2026-11-02T10:00:00.000Z', features: { review: true, intake: false, dispatch: true, planCmd: true } }),
  };

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-admin-'));
    tokensFile = path.join(dir, 'managers.json');
    const departments = parseDepartments(parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8')));
    const policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
    token.owner = addManager(tokensFile, { name: 'owner-ops', member: 'o', departments: [], roles: ['manager', 'owner'] });
    token.alice = addManager(tokensFile, { name: 'alice-core', member: 'alice', departments: ['core'] });
    token.dash = addManager(tokensFile, { name: 'server-dashboard', member: 'o', departments: [], roles: ['dashboard'] });
    store = openStore({ leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    const made = createServer({ store, departments, policy, tokensFile, bus, ops, log: { error() {}, warn() {}, log() {} } });
    server = made.server;
    base = `http://127.0.0.1:${(await listen(server, { host: '127.0.0.1', port: 0 })).port}`;
  });
  after(() => { server.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const call = (who, method, url, body) => fetch(`${base}${url}`, {
    method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${token[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const waitJob = async (id) => {
    for (let i = 0; i < 50; i++) {
      const j = await call('owner', 'GET', `/operator/jobs/${id}`);
      if (j.body.job.status !== 'running') return j.body.job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('job did not settle');
  };

  it('plan an epic: owner only, dry run first, then a real run; result in a job', async () => {
    assert.equal((await call('alice', 'POST', '/operator/epics/E-0001/plan', { dryRun: true })).status, 403);
    assert.equal((await call('owner', 'POST', '/operator/epics/E-9999/plan', { dryRun: true })).status, 404);
    const dry = await call('owner', 'POST', '/operator/epics/E-0001/plan', { dryRun: true });
    assert.equal(dry.status, 202);
    const done = await waitJob(dry.body.job.id);
    assert.equal(done.status, 'done');
    assert.equal(done.result.written, false);
    assert.deepEqual(calls.at(-1), ['plan', 'E-0001', true]);
    assert.equal((await call('owner', 'POST', '/operator/epics/E-0001/plan', { dryRun: false })).status, 400, 'a real run needs a reason');
    const real = await call('owner', 'POST', '/operator/epics/E-0001/plan', { dryRun: false, reason: 'plan the pilot' });
    assert.equal((await waitJob(real.body.job.id)).result.written, true);
    assert.ok(posts.some((p) => /operator plan E-0001 by owner-ops: plan the pilot/.test(p)));
  });

  it('intake now and backup now: owner only', async () => {
    assert.equal((await call('alice', 'POST', '/operator/intake', { reason: 'xyz' })).status, 403);
    const j = await call('owner', 'POST', '/operator/intake', { reason: 'new epic issue' });
    assert.equal((await waitJob(j.body.job.id)).result.created[0].id, 'E-0002');
    assert.equal((await call('alice', 'POST', '/operator/backup', { reason: 'xyz' })).status, 403);
    const b = await call('owner', 'POST', '/operator/backup', { reason: 'before upgrade' });
    assert.equal(b.status, 200);
    assert.match(b.body.file, /manual-1\.db$/);
  });

  it('tokens: list without hashes, create shows the raw token once, revoke; owner only', async () => {
    assert.equal((await call('alice', 'GET', '/operator/tokens')).status, 403);
    const list = await call('owner', 'GET', '/operator/tokens');
    assert.deepEqual(list.body.tokens.map((t) => t.name).sort(), ['alice-core', 'owner-ops', 'server-dashboard']);
    assert.ok(!JSON.stringify(list.body).includes('hash'));
    assert.equal((await call('owner', 'POST', '/operator/tokens', { name: 'bob-qa', member: 'bob', departments: ['qa'], role: 'manager' })).status, 400, 'reason required');
    assert.equal((await call('owner', 'POST', '/operator/tokens', { name: 'Bad Name', member: 'bob', departments: ['qa'], role: 'manager', reason: 'new member' })).status, 400);
    assert.equal((await call('owner', 'POST', '/operator/tokens', { name: 'bob-qa', member: 'bob', departments: ['nope'], role: 'manager', reason: 'new member' })).status, 400, 'unknown department');
    const made = await call('owner', 'POST', '/operator/tokens', { name: 'bob-qa', member: 'bob', departments: ['qa'], role: 'manager', reason: 'new member' });
    assert.equal(made.status, 201);
    assert.equal(typeof made.body.token, 'string');
    assert.ok(made.body.token.length >= 40);
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${made.body.token}` } })).status, 200, 'the new token works');
    assert.equal((await call('owner', 'POST', '/operator/tokens', { name: 'bob-qa', member: 'bob', departments: ['qa'], role: 'manager', reason: 'again' })).status, 409);
    assert.equal((await call('owner', 'POST', '/operator/tokens/bob-qa/revoke', { reason: 'left the team' })).status, 200);
    assert.equal(readTokens(tokensFile).managers['bob-qa'], undefined);
    assert.equal((await fetch(`${base}/me`, { headers: { authorization: `Bearer ${made.body.token}` } })).status, 401, 'revoked');
    assert.equal((await call('owner', 'POST', '/operator/tokens/owner-ops/revoke', { reason: 'oops' })).status, 409, 'never the last owner token');
    assert.ok(!posts.some((p) => p.includes(made.body.token)), 'the raw token never goes to the bus');
  });

  it('snapshot carries service info; plan without a plan command is 501', async () => {
    const snap = await call('dash', 'GET', '/snapshot');
    assert.equal(snap.body.service.version, 'abc1234');
    assert.equal(snap.body.service.features.planCmd, true);
  });
});
