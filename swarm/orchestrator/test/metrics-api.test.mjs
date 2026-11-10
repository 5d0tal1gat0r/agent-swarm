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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');

describe('metrics and dashboard routes', () => {
  let server, base, store, dir;
  const token = {};

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-metrics-api-'));
    const tokensFile = path.join(dir, 'managers.json');
    const departments = parseDepartments(parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8')));
    const policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
    token.manager = addManager(tokensFile, { name: 'alice-core', member: 'alice', departments: ['core'] });
    token.intake = addManager(tokensFile, { name: 'owner-intake', member: 'owner', departments: [], roles: ['intake'] });
    store = openStore({ clock: { now: () => Date.now() }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    store.createTask({ id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'one', department: 'core', priority: 'p1', size: 'S', paths: ['swarm/orchestrator/src/x.mjs'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 } });
    server = createServer({ store, departments, policy, tokensFile, log: { error() {} } }).server;
    const addr = await listen(server, { host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(() => {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /metrics needs a token, and an intake token is refused (manager role only)', async () => {
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    assert.equal((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token.intake}` } })).status, 403);
  });

  it('GET /metrics with a manager token returns the computed numbers', async () => {
    const r = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token.manager}` } });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.tasks, 1);
    assert.deepEqual(body.queueDepth, { core: 1 });
    assert.equal(body.merged.count, 0);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  });

  it('GET /dashboard is served without data, with the CSP header and nosniff', async () => {
    const r = await fetch(`${base}/dashboard`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    const html = await r.text();
    assert.doesNotMatch(html, /T-0001/);
    assert.match(html, /\/metrics/);
  });

  it('HEAD /dashboard returns 200 with the same headers and no body', async () => {
    const r = await fetch(`${base}/dashboard`, { method: 'HEAD' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(await r.text(), '');
  });
});
