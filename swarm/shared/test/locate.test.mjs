import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { LOCATION, lookupLocation, publishLocation, resolveOrchestrator, verifyOrchestrator, whoamiProof } from '../locate.mjs';

const TOKEN = 'secret-token';
const HASH = createHash('sha256').update(TOKEN, 'utf8').digest('hex');

function fakeBus() {
  const state = new Map();
  return {
    state,
    setState: async (ns, key, value) => state.set(`${ns}/${key}`, value),
    getState: async (ns, key) => state.get(`${ns}/${key}`) ?? null,
  };
}

// An orchestrator that knows the hash (real) or not (impostor). Records every request.
function server({ knowsHash = true } = {}) {
  const seen = [];
  const fetchFn = async (url, init) => {
    seen.push({ url, headers: init.headers, body: init.body });
    const { manager, nonce } = JSON.parse(init.body);
    if (manager !== 'me-core') return new Response('{}', { status: 404 });
    return Response.json({ proof: whoamiProof(knowsHash ? HASH : 'f'.repeat(64), nonce) });
  };
  return { fetchFn, seen };
}

describe('orchestrator location on the bus', () => {
  it('publishes and looks up the URL; rejects garbage values', async () => {
    const bus = fakeBus();
    await publishLocation(bus, { url: 'http://192.0.2.1:3423', host: 'pc' });
    const loc = await lookupLocation(bus);
    assert.equal(loc.url, 'http://192.0.2.1:3423');
    assert.equal(loc.host, 'pc');
    for (const bad of ['not json', '{"url":"file:///etc/passwd"}', '{"url":"http://a b"}', '{}']) {
      bus.state.set(`${LOCATION.namespace}/${LOCATION.key}`, bad);
      assert.equal(await lookupLocation(bus), null, bad);
    }
  });

  it('verifies the real orchestrator without sending the token', async () => {
    const { fetchFn, seen } = server();
    assert.equal(await verifyOrchestrator('http://x:1', { manager: 'me-core', token: TOKEN, fetchFn }), true);
    assert.ok(!JSON.stringify(seen).includes(TOKEN), 'token never leaves the manager');
    assert.equal(seen[0].headers.authorization, undefined);
  });

  it('rejects an impostor, an unknown manager and a dead host', async () => {
    assert.equal(await verifyOrchestrator('http://x:1', { manager: 'me-core', token: TOKEN, fetchFn: server({ knowsHash: false }).fetchFn }), false);
    assert.equal(await verifyOrchestrator('http://x:1', { manager: 'other', token: TOKEN, fetchFn: server().fetchFn }), false);
    assert.equal(await verifyOrchestrator('http://x:1', { manager: 'me-core', token: TOKEN, fetchFn: async () => { throw new Error('down'); } }), false);
  });

  it('resolveOrchestrator returns the URL only when it verifies', async () => {
    const bus = fakeBus();
    assert.equal(await resolveOrchestrator(bus, { manager: 'me-core', token: TOKEN, fetchFn: server().fetchFn }), null);
    await publishLocation(bus, { url: 'http://192.0.2.1:3423/', host: 'pc' });
    assert.equal(await resolveOrchestrator(bus, { manager: 'me-core', token: TOKEN, fetchFn: server().fetchFn }), 'http://192.0.2.1:3423');
    assert.equal(await resolveOrchestrator(bus, { manager: 'me-core', token: TOKEN, fetchFn: server({ knowsHash: false }).fetchFn }), null);
  });
});
