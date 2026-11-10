import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { Bus } from '../bus.mjs';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function fakeFetch(calls) {
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const result = body.method === 'tools/call' ? { content: [{ type: 'text', text: 'ok' }] } : {};
    return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      headers: { 'mcp-session-id': 's1' },
    });
  };
}
const registerArgs = (calls) => calls.find((c) => c.params?.name === 'comm_register').params.arguments;

describe('Bus registration', () => {
  it('defaults to general only', async () => {
    const calls = [];
    fakeFetch(calls);
    await new Bus('http://x/mcp', 'a', { warn() {} }).send('general', 'hi');
    assert.deepEqual(registerArgs(calls), { name: 'a', channels: ['general'] });
  });

  it('registers general plus extra channels, deduped', async () => {
    const calls = [];
    fakeFetch(calls);
    const bus = new Bus('http://x/mcp', 'swarm-operator', { warn() {} }, ['swarm', 'dept-core', 'general', 'swarm']);
    await bus.send('swarm', 'hi');
    assert.deepEqual(registerArgs(calls).channels, ['general', 'swarm', 'dept-core']);
  });
});

describe('Bus robustness', () => {
  it('invalid channels warn once and are not registered', async () => {
    const calls = [];
    fakeFetch(calls);
    const warns = [];
    const bus = new Bus('http://x/mcp', 'a', { warn: (m) => warns.push(m) }, ['swarm', '#bad', 'Bad', 'dept-core']);
    await bus.send('swarm', 'hi');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /#bad, Bad/);
    assert.deepEqual(registerArgs(calls).channels, ['general', 'swarm', 'dept-core']);
    assert.equal(bus.hasChannel('swarm'), true);
    assert.equal(bus.hasChannel('dept-gone'), false);
  });

  it('a failed registration backs off, retries after the window, and success resets', async () => {
    const calls = [];
    let fail = true;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      if (fail) throw new Error('down');
      return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'ok' }] } }), { headers: { 'mcp-session-id': 's1' } });
    };
    const clock = { t: 1000, now() { return this.t; } };
    const warns = [];
    const bus = new Bus('http://x/mcp', 'a', { warn: (m) => warns.push(m) }, [], { now: () => clock.now(), backoffMs: 100, maxBackoffMs: 300 });
    await bus.send('general', '1');
    assert.equal(calls.length, 1);
    await bus.send('general', '2');
    await bus.send('general', '3');
    assert.equal(calls.length, 1, 'no fetch inside the window');
    clock.t += 100;
    await bus.send('general', '4');
    assert.equal(calls.length, 2, 'retried after the window');
    clock.t += 100;
    await bus.send('general', '5');
    assert.equal(calls.length, 2, 'window doubled to 200');
    clock.t += 100;
    fail = false;
    await bus.send('general', '6');
    assert.ok(calls.length > 3, 'connected');
    assert.equal(bus.backoffMs, 100, 'success resets the backoff');
    const before = calls.length;
    await bus.send('general', '7');
    assert.equal(calls.length, before + 1, 'plain send, no reconnect');
  });
});

describe('Bus direct, inbox, agents', () => {
  it('direct sends to one agent; inbox and agents parse JSON, null on failure', async () => {
    const calls = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      const name = body.params?.name;
      const text = name === 'comm_inbox' ? '[{"id":1}]' : name === 'comm_agents' ? '[{"name":"a"}]' : 'ok';
      return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } }), { headers: { 'mcp-session-id': 's1' } });
    };
    const bus = new Bus('http://x/mcp', 'a', { warn() {} });
    await bus.direct('me-core', 'hi');
    assert.deepEqual(calls.find((c) => c.params?.name === 'comm_send').params.arguments, { to: 'me-core', content: 'hi' });
    assert.deepEqual(await bus.inbox(), [{ id: 1 }]);
    assert.deepEqual(calls.find((c) => c.params?.name === 'comm_inbox').params.arguments, { unread_only: false, limit: 100 });
    assert.deepEqual(await bus.agents(), [{ name: 'a' }]);
    globalThis.fetch = async () => { throw new Error('down'); };
    bus.session = null;
    assert.equal(await new Bus('http://x/mcp', 'b', { warn() {} }).inbox(), null);
  });

  it('inbox, agents and getState return null on non-JSON output and warn once', async () => {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'not json' }] } }), { headers: { 'mcp-session-id': 's1' } });
    };
    const warns = [];
    const bus = new Bus('http://x/mcp', 'a', { warn: (m) => warns.push(m) });
    assert.equal(await bus.inbox(), null);
    assert.equal(await bus.agents(), null);
    assert.equal(await bus.getState('ns', 'k'), null);
    assert.equal(await bus.inbox(), null);
    assert.equal(warns.filter((w) => /non-JSON/.test(w)).length, 1);
  });
});

describe('Bus channelHistory', () => {
  it('reads a channel through comm_channel history; null on non-array or failure', async () => {
    const calls = [];
    let text = '[{"id":1,"content":"WARN x"}]';
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } }), { headers: { 'mcp-session-id': 's1' } });
    };
    const bus = new Bus('http://x/mcp', 'a', { warn() {} }, ['swarm']);
    assert.deepEqual(await bus.channelHistory('swarm', 20), [{ id: 1, content: 'WARN x' }]);
    assert.deepEqual(calls.find((c) => c.params?.name === 'comm_channel').params.arguments, { action: 'history', channel: 'swarm', limit: 20 });
    text = '{"error":"no"}';
    assert.equal(await bus.channelHistory('swarm'), null);
  });
});

describe('Bus concurrent first calls', () => {
  it('share one connect and register once', async () => {
    const calls = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body);
      await new Promise((r) => setTimeout(r, 5));
      return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: '[]' }] } }), { headers: { 'mcp-session-id': 's1' } });
    };
    const bus = new Bus('http://x/mcp', 'swarm-dashboard', { warn() {} }, ['swarm']);
    await Promise.all([bus.agents(), bus.channelHistory('swarm'), bus.getState('swarm', 'orchestrator')]);
    assert.equal(calls.filter((c) => c.params?.name === 'comm_register').length, 1);
    assert.equal(calls.filter((c) => c.method === 'initialize').length, 1);
  });
});

describe('Bus name held by an abandoned session', () => {
  it('registers a suffixed name and keeps working', async () => {
    const names = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      let result = { content: [{ type: 'text', text: '[]' }] };
      if (body.params?.name === 'comm_register') {
        names.push(body.params.arguments.name);
        if (body.params.arguments.name === 'swarm-dashboard') result = { isError: true, content: [{ type: 'text', text: 'Agent name "swarm-dashboard" is already registered and active.' }] };
      }
      return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'mcp-session-id': 's1' } });
    };
    const warns = [];
    const bus = new Bus('http://x/mcp', 'swarm-dashboard', { warn: (m) => warns.push(m) }, ['swarm']);
    assert.deepEqual(await bus.agents(), []);
    assert.equal(names[0], 'swarm-dashboard');
    assert.match(names[1], /^swarm-dashboard-[0-9a-f]{1,4}$/);
    assert.equal(bus.registeredAs, names[1]);
    assert.match(warns[0], /held by an abandoned session/);
  });
});

describe('Bus listChannels and stateList', () => {
  it('list channels (not shadowed by the channel names) and a namespace of shared state', async () => {
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const name = body.params?.name;
      const text = name === 'comm_channel' ? '[{"id":"c1","name":"swarm"}]' : name === 'comm_state' ? '[{"namespace":"swarm","key":"k"}]' : 'ok';
      return new Response(body.id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text }] } }), { headers: { 'mcp-session-id': 's1' } });
    };
    const bus = new Bus('http://x/mcp', 'a', { warn() {} }, ['swarm']);
    assert.deepEqual(bus.channels, ['general', 'swarm'], 'the registered channel names stay a property');
    assert.deepEqual(await bus.listChannels(), [{ id: 'c1', name: 'swarm' }]);
    assert.deepEqual(await bus.stateList('swarm'), [{ namespace: 'swarm', key: 'k' }]);
  });
});
