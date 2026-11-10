// Where the orchestrator runs (ARCHITECTURE 43). The orchestrator publishes its URL in bus
// shared state at start and every 10 min. Managers and the watchdog configured with url "bus"
// read it, so moving the orchestrator to another machine needs no change on theirs.
// Bus state is writable by any bus member, so a manager never sends its token to a looked-up
// URL before that URL proves it holds the manager's token hash: POST /whoami returns
// HMAC-SHA256(key = sha256(token) hex, nonce), which only the real orchestrator can compute.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const LOCATION = { namespace: 'swarm', key: 'orchestrator' };
export const REPUBLISH_MS = 10 * 60_000;

export function publishLocation(bus, { url, host }) {
  return bus.setState(LOCATION.namespace, LOCATION.key, JSON.stringify({ url, host, at: new Date().toISOString() }));
}

/** { url, host, at } or null. Only http(s) URLs are accepted. */
export async function lookupLocation(bus) {
  const value = await bus.getState(LOCATION.namespace, LOCATION.key);
  if (!value) return null;
  try {
    const loc = JSON.parse(value);
    return typeof loc?.url === 'string' && /^https?:\/\/[^\s/]+$/.test(loc.url.replace(/\/$/, '')) ? loc : null;
  } catch {
    return null;
  }
}

/** Orchestrator side: the proof for a nonce, given the manager's stored token hash. */
export function whoamiProof(tokenHash, nonce) {
  return createHmac('sha256', tokenHash).update(String(nonce)).digest('hex');
}

/** Manager side: true when `url` answers /whoami with the right proof. The token itself is never sent. */
export async function verifyOrchestrator(url, { manager, token, fetchFn = fetch }) {
  const nonce = randomBytes(16).toString('hex');
  try {
    const res = await fetchFn(`${url.replace(/\/$/, '')}/whoami`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manager, nonce }), signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const { proof } = await res.json();
    const want = Buffer.from(whoamiProof(createHash('sha256').update(token, 'utf8').digest('hex'), nonce), 'hex');
    const got = Buffer.from(typeof proof === 'string' ? proof : '', 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}

/** Manager side: the looked-up URL when it verifies, else null. */
export async function resolveOrchestrator(bus, creds) {
  const loc = await lookupLocation(bus);
  if (!loc) return null;
  return (await verifyOrchestrator(loc.url, creds)) ? loc.url.replace(/\/$/, '') : null;
}
