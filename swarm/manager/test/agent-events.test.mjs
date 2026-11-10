import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createAgentEventNormalizer, createAgentEventSpool, redactAgentEvent } from '../src/agent-events.mjs';
import { OrchestratorClient } from '../src/client.mjs';

const HERE = import.meta.dirname;
const fixture = (name) => fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-events-')); dirs.push(dir); return dir; };
const base = { assignmentId: 'agent-T-0001-implementer-a1b2c3d4', sessionId: 'run-T-0001-1-a1b2c3d4', taskId: 'T-0001', manager: 'alice-core' };
const clock = { now: () => Date.parse('2026-11-05T10:00:00.000Z') };

describe('agent event normalizer', () => {
  it('parses chunk-split Codex JSONL into structured events and tokens', () => {
    const events = [];
    const normalizer = createAgentEventNormalizer({ kind: 'codex', ...base, clock, emit: (event) => events.push(event) });
    const data = [
      '{"type":"turn.started"}\n',
      '{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}\n',
      '{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":0}}\n',
      '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":3,"output_tokens":2}}\n',
    ].join('');
    normalizer.stdout(data.slice(0, 43));
    normalizer.stdout(data.slice(43));
    normalizer.finish({ code: 0 });
    assert.deepEqual(events.map((event) => event.type), ['session.started', 'phase.changed', 'command.started', 'command.completed', 'tokens', 'session.completed']);
    assert.deepEqual(events.find((event) => event.type === 'tokens').data, { inputTokens: 7, outputTokens: 2 });
    assert.equal(events.at(-1).managerSeq, events.length);
  });

  it('parses Antigravity stream events but emits only coarse final events for Claude and Gemini', () => {
    const agy = [];
    const normalizer = createAgentEventNormalizer({ kind: 'antigravity', ...base, clock, emit: (event) => agy.push(event) });
    const input = fixture('antigravity-stream.jsonl');
    normalizer.stdout(input.slice(0, 71));
    normalizer.stdout(input.slice(71));
    normalizer.finish({ code: 0 });
    assert.ok(agy.some((event) => event.type === 'tool.started'));
    assert.ok(agy.some((event) => event.type === 'tool.completed'));
    assert.deepEqual(agy.find((event) => event.type === 'tokens').data, { inputTokens: 100, outputTokens: 25 });

    for (const [kind, name] of [['claude', 'claude-result.json'], ['gemini', 'gemini-result.json']]) {
      const events = [];
      const coarse = createAgentEventNormalizer({ kind, ...base, clock, emit: (event) => events.push(event) });
      coarse.stdout(fixture(name));
      coarse.finish({ code: 0, reply: fixture(name) });
      assert.deepEqual(events.map((event) => event.type), ['session.started', 'tokens', 'session.completed']);
      assert.ok(!events.some((event) => event.type.startsWith('tool.') || event.type.startsWith('file.')));
    }
  });

  it('uses host events as authoritative and callback failures do not corrupt sequencing', () => {
    const events = [];
    const normalizer = createAgentEventNormalizer({ kind: 'gemini', ...base, clock, emit: (event) => {
      if (event.type === 'status') throw new Error('spool down');
      events.push(event);
    } });
    assert.doesNotThrow(() => normalizer.host('status', { summary: 'Checking', phase: 'test' }));
    normalizer.host('test.result', { summary: 'Tests passed', passed: 12, failed: 0 });
    assert.equal(events.at(-1).type, 'test.result');
    assert.equal(events.at(-1).managerSeq, 3);
  });
});

describe('event redaction', () => {
  it('removes secrets, auth, environment and content while retaining safe bounded detail', () => {
    const safe = redactAgentEvent({
      managerSeq: 1, sessionId: base.sessionId, assignmentId: base.assignmentId, parentId: 'alice-core', manager: base.manager,
      taskId: base.taskId, at: '2026-11-05T10:00:00.000Z', type: 'status', phase: 'implement', summary: 'working',
      data: { token: 'secret', authorization: 'Bearer x', env: { HOME: '/x' }, content: 'private prompt', path: '/home/alice/repo/src/a.mjs', safe: 'ok', huge: 'x'.repeat(10_000) },
    });
    const text = JSON.stringify(safe);
    assert.ok(!text.includes('Bearer x') && !text.includes('private prompt') && !text.includes('/home/alice'));
    assert.equal(safe.data.safe, 'ok');
    assert.ok(Buffer.byteLength(JSON.stringify(safe.data)) <= 4096);
  });
});

describe('durable event spool', () => {
  const event = (seq, type = 'status', extra = '') => ({
    managerSeq: seq, sessionId: base.sessionId, assignmentId: base.assignmentId, parentId: base.manager, manager: base.manager,
    taskId: base.taskId, at: '2026-11-05T10:00:00.000Z', type, phase: 'implement', summary: `${type} ${seq}`,
    data: { detail: extra },
  });

  it('replays after disconnect/restart, sends oldest-first bounded batches, and accepts duplicate acknowledgements', async () => {
    const dir = temp();
    let fail = true;
    const batches = [];
    const sendBatch = async (events) => {
      batches.push(events);
      if (fail) throw new Error('offline');
      return { accepted: events.map((item) => item.managerSeq) };
    };
    const first = createAgentEventSpool({ dir, sendBatch, clock });
    for (let seq = 1; seq <= 205; seq += 1) first.append(event(seq, 'status', 'x'.repeat(2000)));
    await assert.rejects(first.flush(), /offline/);
    first.close();
    fail = false;
    const restarted = createAgentEventSpool({ dir, sendBatch, clock });
    await restarted.flush();
    assert.ok(batches.slice(1).every((batch) => batch.length <= 100 && Buffer.byteLength(JSON.stringify({ events: batch })) <= 256 * 1024));
    assert.deepEqual(batches.slice(1).flat().map((item) => item.managerSeq), Array.from({ length: 205 }, (_, i) => i + 1));
    await restarted.flush();
    restarted.close();
    assert.equal(fs.statSync(path.join(dir, 'agent-events.json')).mode & 0o777, 0o600);
  });

  it('collapses overflow to events.dropped without dropping terminal, test, handoff or directive events', () => {
    const dir = temp();
    const spool = createAgentEventSpool({ dir, maxBytes: 4500, sendBatch: async () => ({ accepted: [] }), clock });
    const protectedTypes = ['test.result', 'handoff', 'directive.applied', 'session.completed'];
    for (let seq = 1; seq <= 20; seq += 1) spool.append(event(seq, 'status', 'x'.repeat(600)));
    protectedTypes.forEach((type, i) => spool.append(event(100 + i, type, 'important')));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agent-events.json'), 'utf8'));
    assert.ok(saved.some((item) => item.type === 'events.dropped'));
    for (const type of protectedTypes) assert.ok(saved.some((item) => item.type === type), type);
    spool.close();
  });
});

describe('manager agent API client', () => {
  it('calls session, event, directive poll and acknowledgement routes', async () => {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
      return new Response(JSON.stringify(url.includes('directives?') ? { directives: [] } : { ok: true }), { status: 200 });
    };
    const client = new OrchestratorClient({ url: 'http://orchestrator', token: 't', fetchFn });
    await client.agentSession('alice-core', { operation: 'start', session: { id: 'run' } });
    await client.agentEvents('alice-core', 'run', [eventShape(1)]);
    await client.directives('alice-core', { after: 'directive-1' });
    await client.ackDirective('alice-core', 'directive-2', { status: 'applied', result: 'ok' });
    assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
      ['POST', '/managers/alice-core/agent-sessions'], ['POST', '/managers/alice-core/agent-events/run'],
      ['GET', '/managers/alice-core/directives'], ['POST', '/managers/alice-core/directives/directive-2/ack'],
    ]);
  });
});

function eventShape(managerSeq) {
  return { managerSeq, sessionId: base.sessionId, assignmentId: base.assignmentId, parentId: base.manager, manager: base.manager, taskId: base.taskId, at: '2026-11-05T10:00:00.000Z', type: 'status', phase: null, summary: 'ok', data: {} };
}
