import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { createAgentControl } from '../src/agent-control.mjs';
import { createServer, createSseWriter, listen, startAgentFeedStream } from '../src/api.mjs';
import { parseDepartments, parsePolicy } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { addManager, readTokens } from '../src/tokens.mjs';

const SWARM = path.resolve(import.meta.dirname, '..', '..');
const AT = '2026-11-05T10:00:00.000Z';

describe('agent cockpit API', () => {
  let server;
  let base;
  let store;
  let dir;
  let tokensFile;
  let departments;
  let policy;
  const token = {};

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-api-'));
    tokensFile = path.join(dir, 'managers.json');
    departments = parseDepartments(parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8')));
    policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
    token.owner = addManager(tokensFile, { name: 'owner', member: 'owner', departments: ['core'], roles: ['owner', 'manager'] });
    token.alice = addManager(tokensFile, { name: 'alice-core', member: 'alice', departments: ['core'], roles: ['manager'] });
    token.bob = addManager(tokensFile, { name: 'bob-core', member: 'bob', departments: ['core'], roles: ['manager'] });
    token.dash = addManager(tokensFile, { name: 'dashboard', member: 'screen', departments: [], roles: ['dashboard'] });
    store = openStore({ clock: { now: () => Date.parse(AT) } });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'body' });
    store.createTask({
      id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'Task', department: 'core', priority: 'p1', size: 'S',
      paths: ['swarm/orchestrator/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 1000, minutes: 30 },
    });
    store.upsertAgentAssignment({
      id: 'orchestrator', kind: 'orchestrator', parentId: null, manager: null, taskId: null, role: null, status: 'running',
    });
    store.upsertAgentAssignment({
      id: 'agent-T-0001-implementer-a1b2c3d4', kind: 'subagent', parentId: 'alice-core', manager: 'alice-core',
      taskId: 'T-0001', role: 'implementer', status: 'running', goal: 'Ship the cockpit', currentTask: 'Add detail route',
      sessionSkills: { roles: ['implementer'], note: 'Keep it focused.' }, guardrails: { allowedPaths: ['swarm/**'], instructions: 'Preserve audit history.' },
    });
    store.startAgentSession({
      id: 'run-T-0001-1-a1b2c3d4', assignmentId: 'agent-T-0001-implementer-a1b2c3d4', agentKind: 'codex',
      model: 'gpt-5.6-luna', status: 'running', phase: 'implement', inputTokens: 0, outputTokens: 0, lastEventSeq: 0,
    });
    store.appendAgentEvents('run-T-0001-1-a1b2c3d4', [{
      managerSeq: 1, sessionId: 'run-T-0001-1-a1b2c3d4', assignmentId: 'agent-T-0001-implementer-a1b2c3d4',
      parentId: 'alice-core', manager: 'alice-core', taskId: 'T-0001', at: AT, type: 'status', phase: 'implement',
      summary: 'Writing the route tests', data: { command: 'node --test' },
    }]);
    const agentControl = createAgentControl({ store, policy, departments, tokens: readTokens(tokensFile) });
    const operatorWorker = {
      enabled: true,
      confirmAction: async (id) => store.resolveOperatorAction(id, { status: 'applied', actor: 'owner', reason: 'ok', result: {}, idempotencyKey: `confirm-${id}` }),
      cancelAction: async (id) => store.resolveOperatorAction(id, { status: 'cancelled', actor: 'owner', reason: 'no', idempotencyKey: `cancel-${id}` }),
    };
    const made = createServer({
      store, departments, policy, tokensFile,
      ops: { agentControl, operatorWorker, info: () => ({ features: { operatorPrompt: true } }) },
      log: { error() {} },
    });
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
  }).then(async (response) => ({ status: response.status, body: await response.json() }));

  it('serves common hierarchy/feed summaries to signed-in roles only', async () => {
    assert.equal((await call(null, 'GET', '/agents')).status, 401);
    for (const who of ['owner', 'alice', 'bob', 'dash']) {
      const hierarchy = await call(who, 'GET', '/agents');
      assert.equal(hierarchy.status, 200, who);
      assert.equal(hierarchy.body.assignments.length, 2);
      assert.ok(!JSON.stringify(hierarchy.body).includes('currentTask'));
      const feed = await call(who, 'GET', '/agents/feed?after=0&limit=50');
      assert.equal(feed.status, 200, who);
      assert.ok(feed.body.items.some((item) => item.kind === 'agent-event'));
      assert.ok(!JSON.stringify(feed.body).includes('node --test'), 'event detail stays out of common feed');
    }
  });

  it('keeps event detail and conversation text owner/owning-manager only', async () => {
    for (const who of ['owner', 'alice']) {
      const detail = await call(who, 'GET', '/agents/assignments/agent-T-0001-implementer-a1b2c3d4');
      assert.equal(detail.status, 200);
      assert.equal(detail.body.assignment.goal, 'Ship the cockpit');
      assert.equal(detail.body.session.model, 'gpt-5.6-luna');
      assert.equal((await call(who, 'GET', '/agents/assignments/agent-T-0001-implementer-a1b2c3d4/events')).status, 200);
    }
    for (const who of ['bob', 'dash']) {
      assert.equal((await call(who, 'GET', '/agents/assignments/agent-T-0001-implementer-a1b2c3d4')).status, 403);
      assert.equal((await call(who, 'GET', '/agents/assignments/agent-T-0001-implementer-a1b2c3d4/events')).status, 403);
    }
    store.appendAgentMessage({ target: 'agent-T-0001-implementer-a1b2c3d4', actor: 'alice', role: 'user', text: 'Private instruction' });
    assert.equal((await call('alice', 'GET', '/agents/conversations/agent-T-0001-implementer-a1b2c3d4/messages')).body.messages[0].text, 'Private instruction');
    assert.equal((await call('bob', 'GET', '/agents/conversations/agent-T-0001-implementer-a1b2c3d4/messages')).status, 403);
  });

  it('queues orchestrator turns and assignment directives with strict permissions', async () => {
    const orchestrator = await call('owner', 'POST', '/operator/agents/orchestrator/prompt', {
      text: 'What is active?', idempotencyKey: 'prompt-orchestrator-a1b2c3d4',
    });
    assert.equal(orchestrator.status, 202);
    assert.equal(orchestrator.body.turn.status, 'queued');
    const managerPrompt = await call('alice', 'POST', '/operator/agents/orchestrator/prompt', {
      text: 'Manager status request', idempotencyKey: 'prompt-orchestrator-b1c2d3e4',
    });
    assert.equal(managerPrompt.status, 202);
    assert.equal(managerPrompt.body.turn.status, 'queued');

    const direct = await call('alice', 'POST', '/operator/agents/agent-T-0001-implementer-a1b2c3d4/prompt', {
      text: 'Check the retry path', idempotencyKey: 'prompt-agent-a1b2c3d4', reason: 'Clarify work',
    });
    assert.equal(direct.status, 202);
    assert.equal(direct.body.directive.status, 'queued');
    assert.equal((await call('bob', 'POST', '/operator/agents/agent-T-0001-implementer-a1b2c3d4/prompt', {
      text: 'Not yours', idempotencyKey: 'prompt-agent-b1c2d3e4', reason: 'No access',
    })).status, 403);
    const oldSession = await call('owner', 'POST', '/operator/agents/run-T-0001-1-a1b2c3d4/prompt', {
      text: 'Race', idempotencyKey: 'prompt-agent-c1d2e3f4', reason: 'Target test',
    });
    assert.equal(oldSession.status, 409);
    assert.equal(oldSession.body.assignmentId, 'agent-T-0001-implementer-a1b2c3d4');
  });

  it('validates context changes and owner-only dangerous commands', async () => {
    const narrowed = await call('alice', 'POST', '/operator/agents/agent-T-0001-implementer-a1b2c3d4/context', {
      idempotencyKey: 'context-narrow', reason: 'Narrow the edit',
      context: { guardrails: { allowedPaths: ['swarm/orchestrator/src/**'] } },
    });
    assert.equal(narrowed.status, 202);
    assert.equal((await call('alice', 'POST', '/operator/agents/agent-T-0001-implementer-a1b2c3d4/interrupt', {
      idempotencyKey: 'interrupt-alice', reason: 'Stop now',
    })).status, 403);
    assert.equal((await call('owner', 'POST', '/operator/agents/agent-T-0001-implementer-a1b2c3d4/interrupt', {
      idempotencyKey: 'interrupt-owner', reason: 'Stop now',
    })).status, 202);
  });

  it('serves private audit history filtered to the requested assignment or task', async () => {
    const audit = await call('alice', 'GET', '/agents/audit?assignment=agent-T-0001-implementer-a1b2c3d4&limit=50');
    assert.equal(audit.status, 200);
    assert.ok(audit.body.items.some((item) => item.kind === 'directive' && item.reason === 'Narrow the edit'));
    assert.ok(audit.body.items.every((item) => item.assignmentId === 'agent-T-0001-implementer-a1b2c3d4'));
    assert.equal((await call('bob', 'GET', '/agents/audit?assignment=agent-T-0001-implementer-a1b2c3d4')).status, 403);
    const byTask = await call('alice', 'GET', '/agents/audit?task=T-0001&limit=50');
    assert.equal(byTask.status, 200);
    assert.ok(byTask.body.items.every((item) => item.taskId === 'T-0001'));
  });

  it('accepts manager sessions/events and redelivers directives until applied', async () => {
    const list = await call('alice', 'GET', '/managers/alice-core/directives');
    assert.equal(list.status, 200);
    assert.ok(list.body.directives.length >= 2);
    assert.equal((await call('bob', 'GET', '/managers/alice-core/directives')).status, 403);
    const directive = list.body.directives[0];
    assert.equal((await call('alice', 'POST', `/managers/alice-core/directives/${directive.id}/ack`, { status: 'delivered' })).status, 200);
    assert.ok((await call('alice', 'GET', '/managers/alice-core/directives')).body.directives.some((item) => item.id === directive.id));
    assert.equal((await call('alice', 'POST', `/managers/alice-core/directives/${directive.id}/ack`, {
      status: 'applied', result: 'continued', replacementSessionId: 'run-T-0001-2-b1c2d3e4',
    })).status, 200);
  });

  it('creates stable manager and subagent assignments from authenticated runtime reports', async () => {
    const heartbeat = await call('alice', 'POST', '/managers/heartbeat', {
      manager: 'alice-core', agent: 'codex', version: 'test', freeSlots: 1, running: [],
    });
    assert.equal(heartbeat.status, 200);
    assert.equal(store.getAgentAssignment('alice-core').kind, 'manager');
    store.createTask({
      id: 'T-0002', epicId: 'E-0001', repo: 'o/r', title: 'Reported task', department: 'core', priority: 'p1', size: 'S',
      paths: ['swarm/manager/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 1000, minutes: 30 },
    });
    store.lease({ department: 'core', slots: 2, manager: 'alice-core' });
    const session = {
      id: 'run-T-0002-1-a1b2c3d4', assignmentId: 'agent-T-0002-implementer-main', agentKind: 'codex', model: 'gpt-5.6-luna',
      status: 'running', phase: 'implement', startedAt: AT, updatedAt: AT, inputTokens: 0, outputTokens: 0, lastEventSeq: 0,
    };
    assert.equal((await call('alice', 'POST', '/managers/alice-core/agent-sessions', { operation: 'start', session })).status, 200);
    assert.equal(store.getAgentAssignment(session.assignmentId).taskId, 'T-0002');
    const ended = { ...session, status: 'completed', endedAt: AT };
    assert.equal((await call('alice', 'POST', '/managers/alice-core/agent-sessions', { operation: 'finish', session: ended })).status, 200);
  });

  it('replays the unified feed over SSE', async () => {
    const response = await fetch(`${base}/agents/stream?after=0`, { headers: { authorization: `Bearer ${token.dash}` } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /event: (assignment|session|agent-event)/);
    assert.match(text, /id: \d+/);
    await reader.cancel();
  });
});

describe('agent SSE writer', () => {
  it('pings on the configured 25-second timer and closes a reader buffered over 1 MiB', () => {
    class Response extends EventEmitter {
      constructor() { super(); this.frames = []; this.writableEnded = false; }
      writeHead() {}
      write(frame) { this.frames.push(frame); return false; }
      end() { this.writableEnded = true; }
    }
    const response = new Response();
    const writer = createSseWriter(response, { maxBufferedBytes: 1024 * 1024 });
    writer.write(`data: ${'x'.repeat(700_000)}\n\n`);
    writer.write(`data: ${'y'.repeat(400_000)}\n\n`);
    assert.equal(response.writableEnded, true);

    const pingResponse = new Response();
    pingResponse.write = function write(frame) { this.frames.push(frame); return true; };
    const timers = [];
    const stop = startAgentFeedStream({
      store: { agentFeed: () => ({ items: [], lastSeq: 0 }) },
      res: pingResponse,
      after: 0,
      setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; },
      clearIntervalFn: () => {},
    });
    const ping = timers.find((timer) => timer.ms === 25_000);
    assert.ok(ping, '25-second ping timer');
    ping.fn();
    assert.ok(pingResponse.frames.includes(': ping\n\n'));
    stop();
  });
});
