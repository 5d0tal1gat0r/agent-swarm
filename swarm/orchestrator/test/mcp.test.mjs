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

const SWARM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('orchestrator MCP endpoint', () => {
  let server, base, store, dir;
  const token = {};

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-mcp-'));
    const tokensFile = path.join(dir, 'managers.json');
    const departments = parseDepartments(parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8')));
    const policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
    token.manager = addManager(tokensFile, { name: 'a-core', member: 'a', departments: ['core'] });
    token.intake = addManager(tokensFile, { name: 'owner-intake', member: 'owner', departments: [], roles: ['intake'] });
    store = openStore();
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    store.createTask({ id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'one', department: 'core', priority: 'p1', size: 'S', paths: ['swarm/orchestrator/src/x.mjs'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 } });
    ({ server } = createServer({ store, departments, policy, tokensFile, log: { error() {} } }));
    base = `http://127.0.0.1:${(await listen(server, { host: '127.0.0.1', port: 0 })).port}`;
  });

  after(() => {
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const post = async (who, body, raw = false) => {
    const res = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${token[who]}` } : {}) },
      body: raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const call = (who, name, args) => post(who, rpc(1, 'tools/call', { name, arguments: args }));

  it('requires a token', async () => {
    assert.equal((await post(null, rpc(1, 'initialize'))).status, 401);
  });

  it('initialize negotiates the protocol version and advertises tools', async () => {
    const { status, body } = await post('manager', rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    assert.equal(status, 200);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    assert.equal(body.result.protocolVersion, '2025-06-18');
    assert.ok(body.result.capabilities.tools);
    assert.equal(body.result.serverInfo.name, 'swarm-orchestrator');
  });

  it('a notification gets 202 and no body', async () => {
    const res = await post('manager', { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.equal(res.body, null);
  });

  it('tools/list names every tool with an input schema', async () => {
    const { body } = await post('manager', rpc(2, 'tools/list'));
    assert.deepEqual(body.result.tools.map((t) => t.name).sort(), ['swarm_epic_create', 'swarm_queue', 'swarm_status', 'swarm_task_get']);
    assert.ok(body.result.tools.every((t) => t.inputSchema.type === 'object'));
  });

  it('a manager token reads status, a task and a queue', async () => {
    const status = JSON.parse((await call('manager', 'swarm_status', {})).body.result.content[0].text);
    assert.equal(status.tasks, 1);
    assert.equal(status.queued.core, 1);
    const task = await call('manager', 'swarm_task_get', { id: 'T-0001' });
    assert.equal(JSON.parse(task.body.result.content[0].text).task.id, 'T-0001');
    const queue = JSON.parse((await call('manager', 'swarm_queue', { department: 'core' })).body.result.content[0].text);
    assert.equal(queue.tasks.length, 1);
  });

  it('tool errors come back as isError results', async () => {
    const missing = (await call('manager', 'swarm_task_get', { id: 'T-9999' })).body.result;
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /unknown task/);
    const bad = (await call('manager', 'swarm_task_get', { id: 'nope' })).body.result;
    assert.equal(bad.isError, true);
  });

  it('epic create is rejected without the intake role and accepted with it', async () => {
    const denied = (await call('manager', 'swarm_epic_create', { title: 'x', body: 'y' })).body.result;
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /intake/);
    assert.equal(store.epicAges().size, 1);

    const ok = (await call('intake', 'swarm_epic_create', { title: 'From MCP', body: 'y', issue: 12 })).body.result;
    assert.notEqual(ok.isError, true);
    const epic = JSON.parse(ok.content[0].text).epic;
    assert.equal(epic.id, 'E-0002');
    assert.equal(store.getEpic('E-0002').issue, 12);

    const dup = (await call('intake', 'swarm_epic_create', { title: 'Again', body: 'y', issue: 12 })).body.result;
    assert.equal(dup.isError, true);
    assert.match(dup.content[0].text, /already exists/);
  });

  it('an intake-only token cannot read tasks', async () => {
    const r = (await call('intake', 'swarm_status', {})).body.result;
    assert.equal(r.isError, true);
  });

  it('answers malformed JSON-RPC with proper errors', async () => {
    const parse = await post('manager', '{not json', true);
    assert.equal(parse.status, 400);
    assert.equal(parse.body.error.code, -32700);
    assert.equal(parse.body.id, null);

    const notRpc = await post('manager', { hello: 'world' });
    assert.equal(notRpc.body.error.code, -32600);

    const wrongVersion = await post('manager', { jsonrpc: '1.0', id: 3, method: 'tools/list' });
    assert.equal(wrongVersion.body.error.code, -32600);
    assert.equal(wrongVersion.body.id, 3);

    const batch = await post('manager', [rpc(1, 'tools/list')]);
    assert.equal(batch.body.error.code, -32600);

    const unknown = await post('manager', rpc(4, 'resources/list'));
    assert.equal(unknown.body.error.code, -32601);
    assert.equal(unknown.body.id, 4);

    const noName = await post('manager', rpc(5, 'tools/call', {}));
    assert.equal(noName.body.error.code, -32602);
    const noTool = await post('manager', rpc(6, 'tools/call', { name: 'nope' }));
    assert.equal(noTool.body.error.code, -32602);
  });

  it('GET /mcp is 405', async () => {
    const res = await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token.manager}` } });
    assert.equal(res.status, 405);
  });
});
