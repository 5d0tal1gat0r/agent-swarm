#!/usr/bin/env node
// Server watchdog (ARCHITECTURE 42). One check per run (a systemd timer runs it every 2 min):
// GET <orchestrator>/health, and post to the swarm channel only when the state changes.
// The orchestrator runs on the orchestrator machine, so "down" usually means the machine is off or asleep.
// SWARM_ORCH_URL=bus reads the address the orchestrator published (ARCHITECTURE 43), so a move needs no change here.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bus } from '../shared/bus.mjs';
import { lookupLocation } from '../shared/locate.mjs';

export const STATE_FILE = path.join(os.homedir(), '.swarm', 'watchdog.json');

export async function probe(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Pure: previous state + this check -> { state, message | null }. The first run only records. */
export function transition(prev, up, now) {
  const state = up ? 'up' : 'down';
  if (!prev || prev.state === state) return { state: { state, since: prev?.state === state ? prev.since : now }, message: null };
  const mins = Math.round((now - prev.since) / 60_000);
  const message = up
    ? `watchdog: orchestrator back up (was down ${mins} min)`
    : `watchdog: orchestrator DOWN (up ${mins} min before). Managers idle until it returns; leases expire and retry.`;
  return { state: { state, since: now }, message };
}

function readState(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export async function runOnce({ url, busUrl, file = STATE_FILE, now = Date.now(), fetchImpl = fetch, bus = null }) {
  let b = bus;
  const getBus = () => (b ??= new Bus(busUrl, 'swarm-watchdog', console, ['swarm']));
  if (url === 'bus') url = (await lookupLocation(getBus()))?.url ?? 'http://no-location-on-the-bus';
  const up = await probe(url, fetchImpl);
  const { state, message } = transition(readState(file), up, now);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(state)}\n`);
  if (message) await getBus().send('swarm', `${message} [${url}]`);
  await b?.close?.();
  console.log(`${up ? 'up' : 'down'} ${url}${message ? ` (posted: ${message})` : ''}`);
  return { up, message };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const url = process.env.SWARM_ORCH_URL;
  if (!url) {
    console.error('SWARM_ORCH_URL is not set (see deploy/env/watchdog.env.example)');
    process.exit(2);
  }
  await runOnce({ url, busUrl: process.env.SWARM_BUS_MCP_URL ?? 'http://127.0.0.1:3422/mcp' });
}
