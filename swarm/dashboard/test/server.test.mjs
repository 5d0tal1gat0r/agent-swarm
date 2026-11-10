import assert from 'node:assert/strict';
import { once } from 'node:events';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_DETAIL_PATH, AGENT_WRITE_PATH, CSP, MAINTENANCE_OVERRUN_MS, MAX_STREAMS, OWNER_CHECK_MS, LOGIN_MAX_FAILURES, OPERATOR_GET_PATH, OPERATOR_PATH, SESSION_MAX_MS, SESSION_TTL_MS, createDashboard } from '../src/server.mjs';
import { removeUser, setUser } from '../src/users.mjs';

const ORCH = 'http://orch:3423';
const DASH_TOKEN = 'dash-secret-token';
const ALICE = 'alice-token-1234567890abcdef';
const BOB = 'bob-token-1234567890abcdef12';
const CAROL = 'carol-token-1234567890abcdef';
const SNAP = { at: '2026-11-02T12:00:00Z', tasks: [{ id: 'T-0001', title: 'one', status: 'queued' }], epics: [], managers: [], metrics: {}, paused: false };

function fakeOrchestrator() {
  const o = { up: true, seen: [], posts: [] };
  o.snapshot = structuredClone(SNAP);
  o.fetchFn = async (url, init) => {
    const bearer = init.headers.authorization.slice(7);
    o.seen.push([url, bearer]);
    if (!o.up) throw new Error('connect ECONNREFUSED');
    if (o.hangMe && url === `${ORCH}/me`) return new Promise(() => {});
    const ok = (body) => new Response(JSON.stringify(body), { status: 200 });
    if (url === `${ORCH}/snapshot`) return bearer === DASH_TOKEN ? ok(o.snapshot) : new Response('{}', { status: 401 });
    if (url === `${ORCH}/me`) return [ALICE, BOB, CAROL].includes(bearer) ? ok({ name: bearer.split('-')[0], member: bearer.split('-')[0], roles: bearer === CAROL ? ['owner'] : ['manager'] }) : new Response('{}', { status: 401 });
    if (url.includes('/agents/assignments/') && url.endsWith('/events')) return ok({ events: [{ type: 'status', summary: 'private detail' }] });
    if (url.includes('/agents/assignments/')) return ok({ assignment: { id: 'agent-T-0001-implementer-main', goal: 'Private goal' }, session: { model: 'gpt-5.6-luna' } });
    if (url.includes('/agents/conversations/') && url.endsWith('/messages')) return ok({ messages: [{ text: 'private conversation' }] });
    if (url.includes('/agents/audit')) return ok({ items: [{ id: 'directive-1', kind: 'directive', action: 'pause', status: 'applied', reason: 'operator reason' }] });
    if (url === `${ORCH}/operator/tokens` && !init.method) return new Response(JSON.stringify({ tokens: [{ name: 'a' }] }), { status: bearer === ALICE ? 200 : 403 });
    if (url.startsWith(`${ORCH}/operator/`)) { o.posts.push({ url, bearer, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true }), { status: bearer === ALICE ? 200 : 403 }); }
    if (url === `${ORCH}/tasks/T-0001/history`) return ok({ history: [{ from: null, to: 'queued', at: 'x', reason: 'created' }] });
    return new Response('{}', { status: 404 });
  };
  return o;
}

const servers = [];
after(() => servers.forEach((s) => s.close()));

// Users for the password sign-in (ARCHITECTURE 54): each test identity is its token constant.
const USERS = { [ALICE]: ['alice', 'alice-password-1'], [BOB]: ['bob', 'bob-password-12'], [CAROL]: ['carol', 'carol-password-1'] };
function usersFile() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-users-')), 'users.json');
  for (const [token, [name, password]] of Object.entries(USERS)) setUser(file, { name, password, token });
  return file;
}

async function start({ bus = null, snapshotFile = null, sessionsFile = null, users = usersFile(), clock: startClock = null, chatDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-chat-')), 'chat'), maintenanceFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-maint-')), 'maintenance.json'), agentCockpit = false, agentBridge = null } = {}) {
  const orch = fakeOrchestrator();
  const clock = startClock ?? { t: Date.parse('2026-11-02T12:00:00Z'), now() { return this.t; } };
  const dash = createDashboard({ resolveUrl: async () => (orch.up ? ORCH : null), token: DASH_TOKEN, bus, fetchFn: orch.fetchFn, clock, log: { warn() {}, error() {} }, usersFile: users, snapshotFile, sessionsFile, chatDir, maintenanceFile, agentCockpit, agentBridge });
  dash.server.listen(0, '127.0.0.1');
  await once(dash.server, 'listening');
  servers.push(dash.server);
  const base = `http://127.0.0.1:${dash.server.address().port}`;
  const cookies = {};
  const login = async (user, password, headers = {}) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ user, password }) });
  // Signs in once per identity and reuses the session cookie; an unknown identity sends a made-up cookie.
  const cookieFor = async (who) => {
    if (!who) return {};
    if (!USERS[who]) return { cookie: 'swarm_sid=deadbeef' };
    if (!cookies[who]) {
      const res = await login(...USERS[who]);
      cookies[who] = (res.headers.get('set-cookie') ?? '').split(';')[0];
    }
    return { cookie: cookies[who] };
  };
  const post = async (p, who, body) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(await cookieFor(who)) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const get = async (p, who) => {
    const res = await fetch(`${base}${p}`, { headers: await cookieFor(who) });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text.startsWith('{') ? JSON.parse(text) : null };
  };
  return { dash, orch, clock, get, post, login, cookies, base, maintenanceFile };
}

describe('server dashboard', () => {
  it('feature-gates the cockpit and proxies only exact agent detail/write paths with the viewer token', async () => {
    const bridge = {
      snapshot: () => ({ summary: { assignments: [{ id: 'orchestrator', status: 'running' }], sessions: [] }, feed: [], lastSeq: 0, updatedAt: 1 }),
      subscribe: () => () => {},
    };
    assert.equal((await (await start()).get('/agents')).status, 404);
    const { dash, orch, get, post } = await start({ agentCockpit: true, agentBridge: bridge });
    await dash.poll();
    const page = await get('/agents');
    assert.equal(page.status, 200);
    assert.match(page.text, /Agent cockpit/);
    assert.equal((await get('/agents.js')).status, 200);
    assert.equal((await get('/agents-render.mjs')).status, 200);
    const summary = await get('/api/agents', ALICE);
    assert.equal(summary.status, 200);
    assert.equal(summary.body.summary.assignments[0].id, 'orchestrator');
    assert.ok(!JSON.stringify(summary.body).includes('private conversation'));
    const detail = await get('/api/agents/assignments/agent-T-0001-implementer-main/events', ALICE);
    assert.equal(detail.status, 200);
    assert.equal(orch.seen.at(-1)[1], ALICE);
    const context = await get('/api/agents/assignments/agent-T-0001-implementer-main', ALICE);
    assert.equal(context.body.assignment.goal, 'Private goal');
    const audit = await get('/api/agents/audit?assignment=agent-T-0001-implementer-main', ALICE);
    assert.equal(audit.status, 200);
    assert.equal(audit.body.items[0].reason, 'operator reason');
    assert.equal(orch.seen.at(-1)[1], ALICE);
    const prompt = await post('/api/operator/agents/orchestrator/prompt', ALICE, { text: 'status?', idempotencyKey: 'prompt-status', extra: 'drop' });
    assert.equal(prompt.status, 200);
    assert.deepEqual(orch.posts.at(-1).body, { text: 'status?', idempotencyKey: 'prompt-status' });
    assert.equal((await get('/api/agents/conversations/x/../../snapshot', ALICE)).status, 404);
    assert.ok(AGENT_DETAIL_PATH.test('/api/agents/conversations/orchestrator/messages'));
    assert.ok(AGENT_WRITE_PATH.test('/api/operator/agent-actions/action-1/confirm'));
    orch.up = false;
    await dash.poll();
    assert.equal((await get('/api/agents', ALICE)).status, 200, 'cached summary remains readable');
    assert.equal((await get('/api/agents/assignments/agent-T-0001-implementer-main/events', ALICE)).status, 503);
    assert.equal((await post('/api/operator/agents/orchestrator/prompt', ALICE, { text: 'x', idempotencyKey: 'prompt-status-offline' })).status, 503);
  });

  it('serves the page with a self-only CSP and no inline script', async () => {
    const { get } = await start();
    const page = await get('/');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), CSP);
    assert.match(CSP, /script-src 'self';/);
    assert.doesNotMatch(page.text, /<script>(?!<\/script>)/, 'no inline script body');
    assert.equal((await get('/render.mjs')).status, 200);
    assert.equal((await get('/bars.mjs')).status, 200, 'bar sizing module is served');
    assert.equal((await get('/graph-card.mjs')).status, 200);
    assert.match((await get('/')).text, /id="notifications"/);
    assert.equal((await get('/favicon.ico')).status, 204);
    assert.match((await get('/style.css')).text, /\[hidden\] \{ display: none !important; \}/, 'hidden wins over display rules');
    assert.equal((await get('/../server.mjs')).status, 404);
  });

  it('a viewer token is checked with the orchestrator; unknown tokens and no token get 401', async () => {
    const { dash, get } = await start();
    await dash.poll();
    assert.equal((await get('/api/snapshot')).status, 401);
    assert.equal((await get('/api/snapshot', 'nope')).status, 401);
    const r = await get('/api/snapshot', ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.viewer, 'alice');
    assert.equal(r.body.online, true);
    assert.deepEqual(r.body.snapshot.tasks.map((t) => t.id), ['T-0001']);
    assert.ok(!r.text.includes(DASH_TOKEN), 'the dashboard token never reaches a viewer');
  });

  it('orchestrator offline: signed-in viewers still read the last snapshot and offlineSince; history is 503', async () => {
    const { dash, orch, clock, get } = await start();
    await dash.poll();
    await get('/api/snapshot', ALICE);
    orch.up = false;
    clock.t += 60_000;
    await dash.poll();
    const r = await get('/api/snapshot', ALICE);
    assert.equal(r.body.online, false);
    assert.equal(r.body.offlineSince, clock.t);
    assert.deepEqual(r.body.snapshot, SNAP, 'last snapshot kept');
    assert.deepEqual(r.body.viewerRoles, ['manager'], 'last known roles kept');
    const fresh = await get('/api/snapshot', BOB);
    assert.equal(fresh.status, 200, 'a password sign-in reads without the orchestrator (ARCHITECTURE 67)');
    assert.equal(fresh.body.viewer, 'bob');
    assert.deepEqual(fresh.body.viewerRoles, [], 'no roles for a viewer never checked');
    assert.equal((await get('/api/history/T-0001', ALICE)).status, 503);
    clock.t += SESSION_TTL_MS + 1;
    assert.equal((await get('/api/snapshot', ALICE)).status, 401, 'sessions still expire');
    assert.equal((await get('/api/snapshot', 'nope')).status, 401, 'no session, no read');
  });

  it('the last snapshot is saved and loaded by a restarted dashboard (ARCHITECTURE 67)', async () => {
    const snapshotFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-snap-')), 'snapshot.json');
    const first = await start({ snapshotFile });
    await first.dash.poll();
    assert.equal(fs.statSync(snapshotFile).mode & 0o777, 0o600);
    const second = await start({ snapshotFile });
    second.orch.up = false;
    await second.dash.poll();
    const r = await second.get('/api/snapshot', ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.online, false);
    assert.deepEqual(r.body.snapshot, SNAP);
    assert.equal(r.body.fetchedAt, first.clock.t);
  });

  it('history is proxied with the dashboard token; ids are validated', async () => {
    const { dash, orch, get } = await start();
    await dash.poll();
    const r = await get('/api/history/T-0001', ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.history[0].to, 'queued');
    assert.deepEqual(orch.seen.at(-1), [`${ORCH}/tasks/T-0001/history`, DASH_TOKEN]);
    assert.equal((await get('/api/history/..%2F..%2Fsnapshot', ALICE)).status, 404);
  });

  it('alerts come from the swarm channel, newest first, with sender names', async () => {
    const bus = {
      agents: async () => [{ id: 'id-o', name: 'swarm-orchestrator' }],
      channelHistory: async (ch) => (ch === 'swarm' ? [
        { id: 1, from_agent: 'id-o', content: 'WARN dispatch.no_manager dept:qa: 2 queued', created_at: '2026-11-02 11:50:00' },
        { id: 2, from_agent: 'id-x', content: 'watchdog: orchestrator back up', created_at: '2026-11-02 11:55:00' },
      ] : null),
    };
    const { dash, get } = await start({ bus });
    await dash.poll();
    const r = await get('/api/snapshot', ALICE);
    assert.deepEqual(r.body.alerts.map((a) => [a.id, a.from]), [[2, 'id-x'], [1, 'swarm-orchestrator']]);
    assert.equal(r.body.alerts[1].at, '2026-11-02T11:50:00Z');
  });

  it('actions go to /operator with the viewer\'s own token, never the dashboard token', async () => {
    const { dash, orch, get, post } = await start();
    await dash.poll();
    assert.equal((await get('/api/snapshot', ALICE)).body.viewerRoles[0], 'manager');
    const r = await post('/api/operator/tasks/T-0001/cancel', ALICE, { reason: 'duplicate', extra: 'dropped' });
    assert.equal(r.status, 200);
    assert.deepEqual(orch.posts.at(-1), { url: `${ORCH}/operator/tasks/T-0001/cancel`, bearer: ALICE, body: { reason: 'duplicate' } });
    assert.equal((await post('/api/operator/pause', BOB, { reason: 'x' })).status, 403, 'orchestrator decides the role');
    assert.equal((await post('/api/operator/pause', null, { reason: 'x' })).status, 401);
    assert.equal((await post('/api/operator/tasks/T-1/delete', ALICE, { reason: 'x' })).status, 404);
    assert.equal((await post('/api/operator/pause', ALICE, 'not json')).status, 400);
    assert.equal((await post('/api/operator/pause', ALICE, { reason: 'x'.repeat(5000) })).status, 400, 'body cap');
    assert.ok(!orch.posts.some((p) => p.bearer === DASH_TOKEN));
    orch.up = false;
    await dash.poll();
    assert.equal((await post('/api/operator/resume', ALICE, { reason: 'back' })).status, 503);
  });

  it('only known operator paths are proxied', () => {
    for (const ok of ['/api/operator/pause', '/api/operator/epics', '/api/operator/departments/qa/resume', '/api/operator/managers/alice-core/pause', '/api/operator/tasks/T-0001/replan']) assert.ok(OPERATOR_PATH.test(ok), ok);
    for (const bad of ['/api/operator/tasks/T-1/submit', '/api/operator/../snapshot', '/api/operator/managers/x/delete', '/api/operator/']) assert.ok(!OPERATOR_PATH.test(bad), bad);
  });

  it('admin: owner GETs and new POSTs are proxied with the viewer token; extra fields forwarded only from the allow-list', async () => {
    const { dash, orch, get, post } = await start();
    await dash.poll();
    const t = await get('/api/operator/tokens', ALICE);
    assert.equal(t.status, 200);
    assert.equal(orch.seen.at(-1)[1], ALICE);
    assert.equal((await get('/api/operator/tokens', BOB)).status, 403);
    assert.equal((await get('/api/operator/managers', ALICE)).status, 404);
    await post('/api/operator/tokens', ALICE, { name: 'bob-qa', member: 'bob', departments: ['qa'], role: 'manager', reason: 'new', admin: true });
    assert.deepEqual(orch.posts.at(-1).body, { reason: 'new', name: 'bob-qa', member: 'bob', departments: ['qa'], role: 'manager' });
    await post('/api/operator/epics/E-0003/plan', ALICE, { dryRun: true });
    assert.deepEqual(orch.posts.at(-1).body, { dryRun: true });
    for (const ok of ['/api/operator/intake', '/api/operator/backup', '/api/operator/tokens/bob-qa/revoke', '/api/operator/epics/E-1/plan']) assert.ok(OPERATOR_PATH.test(ok), ok);
    assert.ok(OPERATOR_GET_PATH.test('/api/operator/jobs/0123456789ab'));
    assert.ok(!OPERATOR_GET_PATH.test('/api/operator/jobs/../snapshot'));
  });

  it('health: watchdog file and bus health are read on the dashboard machine', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-')), 'watchdog.json');
    fs.writeFileSync(file, JSON.stringify({ state: 'up', since: 5 }));
    const orch = fakeOrchestrator();
    const fetchFn = async (url, init = {}) => (url === 'http://bus/health' ? new Response('{}') : orch.fetchFn(url, { headers: { authorization: 'Bearer x' }, ...init }));
    const dash = createDashboard({ resolveUrl: async () => ORCH, token: DASH_TOKEN, fetchFn, watchdogFile: file, busHealthUrl: 'http://bus/health', log: { warn() {}, error() {} } });
    await dash.poll();
    assert.deepEqual(dash.state.health, { watchdog: { state: 'up', since: 5 }, bus: 'ok' });
  });

  it('password sign-in: right password sets an HttpOnly SameSite=Strict cookie; wrong password and unknown user get 401; logout ends the session', async () => {
    const { dash, login, base } = await start();
    await dash.poll();
    assert.equal((await login('alice', 'wrong-password')).status, 401);
    assert.equal((await login('mallory', 'alice-password-1')).status, 401);
    const ok = await login('alice', 'alice-password-1');
    assert.equal(ok.status, 200);
    const setCookie = ok.headers.get('set-cookie');
    assert.match(setCookie, /^swarm_sid=[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=2592000$/);
    const cookie = setCookie.split(';')[0];
    const snap = await fetch(`${base}/api/snapshot`, { headers: { cookie } });
    assert.equal(snap.status, 200);
    assert.ok(!(await snap.text()).includes(ALICE), 'the member token never reaches the page');
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { authorization: `Bearer ${ALICE}` } })).status, 401, 'tokens no longer sign in');
    await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status, 401);
  });

  it('password change: needs a session and the current password; ends the user\'s other sessions', async () => {
    const { dash, login, base } = await start();
    await dash.poll();
    const cookieOf = async (pw) => (await login('alice', pw)).headers.get('set-cookie').split(';')[0];
    const change = (cookie, body, extra = {}) => fetch(`${base}/api/password`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...extra }, body: JSON.stringify(body) });
    const first = await cookieOf('alice-password-1');
    const second = await cookieOf('alice-password-1');
    assert.equal((await change(null, { current: 'alice-password-1', next: 'alice-new-pass-2' })).status, 401);
    assert.equal((await change(first, { current: 'alice-password-1', next: 'short' })).status, 400);
    assert.equal((await change(first, { current: 'wrong-password', next: 'alice-new-pass-2' })).status, 403);
    assert.equal((await change(first, { current: 'alice-password-1', next: 'alice-new-pass-2' })).status, 200);
    assert.equal((await login('alice', 'alice-password-1')).status, 401, 'old password gone');
    assert.equal((await login('alice', 'alice-new-pass-2')).status, 200);
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { cookie: first } })).status, 200, 'this session stays');
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { cookie: second } })).status, 401, 'other sessions end');
    assert.equal((await change(first, { current: 'x', next: 'alice-new-pass-3' }, { origin: 'http://evil.example' })).status, 403);
  });

  it('sessions survive a restart, stay alive while used, and end at the cap or when the user is removed (ARCHITECTURE 71)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sess-'));
    const sessionsFile = path.join(dir, 'sessions.json');
    const users = usersFile();
    const clock = { t: Date.parse('2026-11-02T12:00:00Z'), now() { return this.t; } };
    const first = await start({ sessionsFile, users, clock });
    await first.dash.poll();
    const cookie = (await first.login('alice', 'alice-password-1')).headers.get('set-cookie').split(';')[0];
    assert.ok(!fs.readFileSync(sessionsFile, 'utf8').includes(cookie.split('=')[1]), 'the raw session id is not stored');
    assert.ok(!fs.readFileSync(sessionsFile, 'utf8').includes(ALICE), 'no token is stored');
    assert.equal(fs.statSync(sessionsFile).mode & 0o777, 0o600);
    const second = await start({ sessionsFile, users, clock });
    await second.dash.poll();
    const read = async () => (await fetch(`${second.base}/api/snapshot`, { headers: { cookie } })).status;
    assert.equal(await read(), 200, 'a restarted dashboard keeps the session');
    for (let i = 0; i < 3; i++) { clock.t += SESSION_TTL_MS - 3600_000; assert.equal(await read(), 200, 'use keeps it alive'); }
    clock.t = Date.parse('2026-11-02T12:00:00Z') + SESSION_MAX_MS;
    assert.equal(await read(), 401, 'ends at the cap even while used');
    const cookie2 = (await second.login('alice', 'alice-password-1')).headers.get('set-cookie').split(';')[0];
    removeUser(users, 'alice');
    assert.equal((await fetch(`${second.base}/api/snapshot`, { headers: { cookie: cookie2 } })).status, 401, 'a removed user is signed out');
  });

  it('sessions expire; failed sign-ins are rate limited; cross-site POSTs are refused', async () => {
    const { dash, login, clock, base } = await start();
    await dash.poll();
    const cookie = (await login('bob', 'bob-password-12')).headers.get('set-cookie').split(';')[0];
    clock.t += SESSION_TTL_MS + 1;
    assert.equal((await fetch(`${base}/api/snapshot`, { headers: { cookie } })).status, 401, 'expired');
    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await login('bob', 'nope-nope-nope');
    assert.equal((await login('bob', 'bob-password-12')).status, 429, 'locked out after repeated failures');
    clock.t += 11 * 60_000;
    assert.equal((await login('bob', 'bob-password-12')).status, 200, 'the lock lifts after the window');
    assert.equal((await login('bob', 'bob-password-12', { origin: 'http://evil.example' })).status, 403);
  });

  it('graph: /api/graph needs a session and returns bus data read every minute; the page is served', async () => {
    const calls = [];
    const bus = {
      agents: async (o) => { calls.push(['agents', o]); return [{ id: 'a1', name: 'swarm-orchestrator', status: 'online' }]; },
      listChannels: async () => [{ id: 'c1', name: 'swarm' }],
      channelHistory: async () => [{ id: 1, from_agent: 'a1', content: 'x'.repeat(900), created_at: 't' }],
      stateList: async (ns) => (ns === 'swarm' ? [{ namespace: 'swarm', key: 'orchestrator', value: 'v', updated_by: 'a1' }] : []),
    };
    const { dash, get, clock } = await start({ bus });
    await dash.poll();
    assert.equal((await get('/api/graph')).status, 401);
    const r = await get('/api/graph', ALICE);
    assert.equal(r.status, 200);
    assert.equal(r.body.bus.state[0].key, 'orchestrator');
    assert.equal(r.body.bus.messages.swarm[0].content.length, 500, 'messages trimmed');
    assert.ok(calls.some(([k, o]) => k === 'agents' && o?.includeOffline), 'offline agents included');
    const n = calls.length;
    await dash.poll();
    assert.equal(calls.filter(([k, o]) => k === 'agents' && o?.includeOffline).length, calls.slice(0, n).filter(([k, o]) => k === 'agents' && o?.includeOffline).length, 'not re-read within the minute');
    assert.equal((await get('/graph')).status, 200);
    assert.equal((await get('/graph.mjs')).status, 200);
    const livePage = await get('/');
    assert.equal(livePage.status, 200);
    assert.doesNotMatch(livePage.text, /tokens-panel/, 'token administration is not embedded in the live view');
    const adminPage = await get('/admin');
    assert.equal(adminPage.status, 200);
    assert.match(adminPage.text, /Access tokens/);
    assert.equal((await get('/admin.js')).status, 200);
  });
});

describe('chat (ARCHITECTURE 72)', () => {
  // Reads SSE frames from a stream until `count` frames have arrived.
  const frames = async (reader, count) => {
    const dec = new TextDecoder();
    let buf = '';
    const out = [];
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!frame.startsWith(':')) out.push(frame);
      }
    }
    return out;
  };

  it('chat needs a session', async () => {
    const { get, post } = await start();
    assert.equal((await get('/api/chat/channels')).status, 401);
    assert.equal((await get('/api/chat/channels', 'nobody')).status, 401);
    assert.equal((await post('/api/chat/channels/general/messages', 'nobody', { text: 'hi' })).status, 401);
    assert.equal((await get('/api/chat/stream')).status, 401);
  });

  it('members post and read; author comes from the session', async () => {
    const { get, post } = await start();
    const r = await post('/api/chat/channels/general/messages', ALICE, { text: 'hi', author: 'mallory' });
    assert.equal(r.status, 201);
    assert.equal(r.body.author, 'alice');
    const h = await get('/api/chat/channels/general/messages', BOB);
    assert.equal(h.status, 200);
    assert.deepEqual(h.body.messages.map((m) => [m.author, m.text]), [['alice', 'hi']]);
    assert.equal(h.body.more, false);
    const ch = await get('/api/chat/channels', BOB);
    assert.deepEqual(ch.body, { channels: [{ name: 'general', createdBy: null, createdAt: ch.body.channels[0].createdAt }], admin: false, me: 'bob', lastId: 1 });
    assert.equal((await post('/api/chat/channels/general/messages', ALICE, { text: '   ' })).status, 400);
    assert.equal((await post('/api/chat/channels/general/messages', ALICE, '{not json')).status, 400);
    assert.equal((await get('/api/chat/channels/nope/messages', ALICE)).status, 404);
  });

  it('only owners create and delete channels', async () => {
    const { dash, get, post } = await start();
    await dash.poll();
    assert.equal((await post('/api/chat/channels', BOB, { name: 'ops' })).status, 403);
    assert.equal((await get('/api/chat/channels', CAROL)).body.admin, true);
    const made = await post('/api/chat/channels', CAROL, { name: 'ops' });
    assert.equal(made.status, 201);
    assert.equal(made.body.createdBy, 'carol');
    assert.equal((await post('/api/chat/channels', CAROL, { name: 'ops' })).status, 409);
    assert.equal((await post('/api/chat/channels', CAROL, { name: 'Bad Name' })).status, 400);
    assert.equal((await post('/api/chat/channels/ops/messages', BOB, { text: 'in ops' })).status, 201);
    assert.equal((await post('/api/chat/channels/ops/delete', BOB, {})).status, 403);
    assert.equal((await post('/api/chat/channels/ops/delete', CAROL, {})).status, 200);
    assert.equal((await post('/api/chat/channels/ops/messages', BOB, { text: 'gone?' })).status, 404);
    assert.equal((await post('/api/chat/channels/general/delete', CAROL, {})).status, 409);
  });

  it('works while the orchestrator is offline', async () => {
    const { dash, orch, get, post } = await start();
    await get('/api/chat/channels', ALICE);
    orch.up = false;
    await dash.poll();
    assert.equal((await post('/api/chat/channels/general/messages', ALICE, { text: 'still here' })).status, 201);
    assert.equal((await get('/api/chat/channels/general/messages', ALICE)).body.messages.length, 1);
  });

  it('cross-site POST refused', async () => {
    const { base, cookies, post } = await start();
    await post('/api/chat/channels/general/messages', ALICE, { text: 'warm up' });
    const res = await fetch(`${base}/api/chat/channels/general/messages`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example', cookie: cookies[ALICE] }, body: JSON.stringify({ text: 'x' }) });
    assert.equal(res.status, 403);
  });

  it('stream replays after=<id> then delivers live events', async () => {
    const { dash, base, cookies, post } = await start();
    await dash.poll();
    await post('/api/chat/channels/general/messages', ALICE, { text: 'one' });
    await post('/api/chat/channels/general/messages', ALICE, { text: 'two' });
    const ac = new AbortController();
    const res = await fetch(`${base}/api/chat/stream?after=1`, { headers: { cookie: cookies[ALICE] }, signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    assert.equal(res.headers.get('content-security-policy'), CSP);
    const reader = res.body.getReader();
    const [first] = await frames(reader, 1);
    assert.match(first, /^id: 2\nevent: message\ndata: /);
    assert.equal(JSON.parse(first.split('data: ')[1]).text, 'two');
    await post('/api/chat/channels/general/messages', BOB, { text: 'three' });
    const [next] = await frames(reader, 1);
    assert.match(next, /^id: 3\nevent: message\n/);
    await post('/api/chat/channels', CAROL, { name: 'ops' });
    const [made] = await frames(reader, 1);
    assert.match(made, /^event: channel-created\ndata: .*"name":"ops"/);
    ac.abort();
  });

  it('stream answers at once even with nothing to replay', async () => {
    const { base, cookies, post } = await start();
    await post('/api/chat/channels/general/messages', ALICE, { text: 'warm up' });
    const ac = new AbortController();
    const res = await Promise.race([
      fetch(`${base}/api/chat/stream?after=999`, { headers: { cookie: cookies[ALICE] }, signal: ac.signal }),
      new Promise((r) => setTimeout(() => r(null), 1000)),
    ]);
    ac.abort();
    assert.equal(res?.status, 200, 'headers flushed without waiting for an event');
  });

  it('stream ends when its session ends (user removed or signed out)', async () => {
    const users = usersFile();
    const { base, cookies, post } = await start({ users });
    await post('/api/chat/channels/general/messages', ALICE, { text: 'warm up' });
    await post('/api/chat/channels/general/messages', BOB, { text: 'warm up' });
    const open = async (who) => (await fetch(`${base}/api/chat/stream?after=999`, { headers: { cookie: cookies[who] } })).body.getReader();
    const alice = await open(ALICE);
    const bob = await open(BOB);
    removeUser(users, 'alice');
    await post('/api/logout', BOB, {});
    await post('/api/chat/channels/general/messages', CAROL, { text: 'secret' });
    const got = [await frames(alice, 1), await frames(bob, 1)];
    await Promise.all([alice.cancel(), bob.cancel()]);
    for (const g of got) assert.equal(g.some((f) => f.includes('secret')), false, 'no message after the session ended');
  });

  it('a full 2000-character message fits the request limit, even escaped or multi-byte', async () => {
    const { post } = await start();
    for (const text of ['é'.repeat(2000), '"\\'.repeat(1000), '😀'.repeat(2000)]) {
      const r = await post('/api/chat/channels/general/messages', ALICE, { text });
      assert.equal(r.status, 201, text.slice(0, 4));
    }
    const big = await post('/api/chat/channels/general/messages', BOB, { text: 'x'.repeat(40_000) });
    assert.equal(big.status, 413);
    assert.match(big.body.error, /too long/);
  });

  it('a slow orchestrator does not hold up the channel list (owner check gives up after OWNER_CHECK_MS)', async () => {
    const { dash, orch, get } = await start();
    await dash.poll();
    orch.hangMe = true;
    const t = Date.now();
    const r = await get('/api/chat/channels', BOB);
    assert.equal(r.status, 200);
    assert.equal(r.body.admin, false);
    assert.ok(Date.now() - t < OWNER_CHECK_MS + 1000, `took ${Date.now() - t} ms`);
  });

  it('at most MAX_STREAMS live streams per session', async () => {
    const { base, cookies, post } = await start();
    await post('/api/chat/channels/general/messages', BOB, { text: 'warm up' });
    const open = () => fetch(`${base}/api/chat/stream?after=999`, { headers: { cookie: cookies[BOB] } });
    const streams = [];
    try {
      for (let i = 0; i < MAX_STREAMS; i++) streams.push(await open());
      assert.deepEqual(streams.map((r) => r.status), Array(MAX_STREAMS).fill(200));
      streams.push(await open());
      assert.equal(streams.at(-1).status, 429);
      await streams.shift().body.cancel();
      await new Promise((r) => setTimeout(r, 100));
      streams.push(await open());
      assert.equal(streams.at(-1).status, 200);
    } finally {
      await Promise.all(streams.map((r) => r.body?.cancel().catch(() => {})));
    }
  });

  it('every page links to /chat', async () => {
    const { get } = await start();
    for (const p of ['/', '/graph', '/admin', '/chat']) assert.match((await get(p)).text, /href="\/chat"/, p);
  });

  it('/chat serves chat.html with the CSP', async () => {
    const { get } = await start();
    const page = await get('/chat');
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('content-security-policy'), CSP);
    assert.doesNotMatch(page.text, /<script>(?!<\/script>)/, 'no inline script body');
    assert.equal((await get('/chat.js')).status, 200);
    assert.equal((await get('/chat-render.mjs')).status, 200);
  });
});

describe('notifications (ARCHITECTURE 74)', () => {
  const frames = async (reader, count) => {
    const dec = new TextDecoder();
    let buf = '';
    const out = [];
    while (out.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!frame.startsWith(':')) out.push(frame);
      }
    }
    return out;
  };

  it('requires a signed-in session for notification APIs', async () => {
    const { get, post } = await start();
    assert.equal((await get('/api/notifications/preferences')).status, 401);
    assert.equal((await post('/api/notifications/preferences', null, { channels: ['general'] })).status, 401);
    assert.equal((await post('/api/notifications/read', null, { eventId: 'task-failed:T-0001' })).status, 401);
    assert.equal((await get('/api/notifications/stream')).status, 401);
  });

  it('streams filtered snapshot transitions and replays after an event id', async () => {
    const { dash, orch, base, cookies, get } = await start();
    await dash.poll();
    await get('/api/snapshot', ALICE);
    const ac = new AbortController();
    const res = await fetch(`${base}/api/notifications/stream?after=orchestrator-online`, { headers: { cookie: cookies[ALICE] }, signal: ac.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/event-stream/);
    const reader = res.body.getReader();
    orch.snapshot = { ...orch.snapshot, tasks: [{ ...orch.snapshot.tasks[0], status: 'failed' }] };
    await dash.poll();
    const [, failed] = await frames(reader, 2);
    assert.match(failed, /^id: task-failed:T-0001\nevent: notification\ndata: /);
    assert.equal(JSON.parse(failed.split('data: ')[1]).kind, 'task-failed');
    ac.abort();

    const replay = await fetch(`${base}/api/notifications/stream?after=orchestrator-online`, { headers: { cookie: cookies[ALICE] } });
    assert.equal(replay.status, 200);
    await replay.body.cancel();
    const prefs = await get('/api/notifications/preferences', ALICE);
    assert.equal(prefs.status, 200);
    assert.equal(prefs.body.kinds['task-failed'], true);
  });

  it('preferences and read state are authenticated, validated, and persisted', async () => {
    const { get, post } = await start();
    const saved = await post('/api/notifications/preferences', ALICE, { kinds: { 'task-failed': false }, channels: ['general'] });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.kinds['task-failed'], false);
    assert.deepEqual(saved.body.channels, ['general']);
    assert.equal((await post('/api/notifications/preferences', ALICE, { channels: ['Bad Name'] })).status, 400);
    const read = await post('/api/notifications/read', ALICE, { eventId: 'task-failed:T-0001' });
    assert.equal(read.status, 200);
    assert.equal(read.body.readThrough, 'task-failed:T-0001');
    assert.equal((await post('/api/notifications/read', ALICE, { eventId: 'bad id' })).status, 400);
    assert.equal((await get('/api/notifications/preferences', ALICE)).body.readThrough, 'task-failed:T-0001');
  });

  it('chat mentions are delivered only to the mentioned user', async () => {
    const { base, cookies, post, get } = await start();
    await get('/api/chat/channels', ALICE);
    await get('/api/chat/channels', BOB);
    const aliceRes = await fetch(`${base}/api/notifications/stream`, { headers: { cookie: cookies[ALICE] } });
    const bobRes = await fetch(`${base}/api/notifications/stream`, { headers: { cookie: cookies[BOB] } });
    await post('/api/chat/channels/general/messages', CAROL, { text: 'hello @alice' });
    const aliceReader = aliceRes.body.getReader();
    const [, aliceFrame] = await frames(aliceReader, 2);
    assert.match(aliceFrame, /event: notification/);
    assert.equal(JSON.parse(aliceFrame.split('data: ')[1]).kind, 'chat-mention');
    const bobReader = bobRes.body.getReader();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bobReader.cancel();
    await aliceReader.cancel();
  });

  it('limits notification streams per session', async () => {
    const { base, cookies, get } = await start();
    await get('/api/chat/channels', BOB);
    const open = () => fetch(`${base}/api/notifications/stream?after=999`, { headers: { cookie: cookies[BOB] } });
    const streams = [];
    try {
      for (let i = 0; i < MAX_STREAMS; i++) streams.push(await open());
      assert.deepEqual(streams.map((r) => r.status), Array(MAX_STREAMS).fill(200));
      assert.equal((await open()).status, 429);
    } finally {
      await Promise.all(streams.map((r) => r.body?.cancel().catch(() => {})));
    }
  });
});

describe('maintenance state (ARCHITECTURE 77)', () => {
  const on = (file, since, reason = 'upgrade abc1234 -> def5678') => fs.writeFileSync(file, JSON.stringify({ reason, by: 'swarmctl', since: new Date(since).toISOString(), auto: true }));

  it('off by default: /health and the snapshot say maintenance null', async () => {
    const { dash, get } = await start();
    await dash.poll();
    assert.equal((await get('/health')).body.maintenance, null);
    assert.equal((await get('/api/snapshot', ALICE)).body.maintenance, null);
  });

  it('a flag file shows in /health and the snapshot, with overrun after MAINTENANCE_OVERRUN_MS', async () => {
    const { dash, get, clock, maintenanceFile } = await start();
    await dash.poll();
    on(maintenanceFile, clock.t);
    const h = (await get('/health')).body.maintenance;
    assert.deepEqual(h, { reason: 'upgrade abc1234 -> def5678', since: new Date(clock.t).toISOString(), overrun: false });
    assert.equal((await get('/api/snapshot', ALICE)).body.maintenance.reason, 'upgrade abc1234 -> def5678');
    clock.t += MAINTENANCE_OVERRUN_MS + 1000;
    assert.equal((await get('/health')).body.maintenance.overrun, true);
    fs.writeFileSync(maintenanceFile, '{broken');
    assert.equal((await get('/health')).body.maintenance.reason, 'maintenance', 'an unreadable flag still counts as on');
    fs.rmSync(maintenanceFile);
    assert.equal((await get('/health')).body.maintenance, null);
  });

  it('writes are refused with 503 while on; chat posting and sign-in still work', async () => {
    const { dash, orch, get, post, clock, maintenanceFile } = await start();
    await dash.poll();
    await get('/api/chat/channels', CAROL);
    on(maintenanceFile, clock.t);
    const op = await post('/api/operator/pause', ALICE, { reason: 'x' });
    assert.equal(op.status, 503);
    assert.match(op.body.error, /maintenance/);
    assert.equal(orch.posts.length, 0, 'nothing forwarded to the orchestrator');
    assert.equal((await post('/api/chat/channels', CAROL, { name: 'ops' })).status, 503);
    assert.equal((await post('/api/chat/channels/general/delete', CAROL, {})).status, 503);
    assert.equal((await post('/api/chat/channels/general/messages', BOB, { text: 'still talking' })).status, 201);
    fs.rmSync(maintenanceFile);
    assert.equal((await post('/api/operator/pause', ALICE, { reason: 'x' })).status, 200);
  });

  it('every page loads the maintenance banner script', async () => {
    const { get } = await start();
    for (const p of ['/', '/graph', '/admin', '/chat']) assert.match((await get(p)).text, /<script type="module" src="\/maint.js"><\/script>/, p);
    assert.equal((await get('/maint.js')).status, 200);
    assert.equal((await get('/maint.mjs')).status, 200);
  });
});
