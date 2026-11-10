import fs from 'node:fs';
import path from 'node:path';

const ASSIGNMENT_KEYS = new Set(['id', 'kind', 'parentId', 'manager', 'taskId', 'role', 'status', 'createdAt', 'updatedAt', 'endedAt']);
const SESSION_KEYS = new Set(['id', 'assignmentId', 'agentKind', 'model', 'status', 'phase', 'startedAt', 'updatedAt', 'endedAt', 'inputTokens', 'outputTokens', 'lastEventSeq']);
const FEED_KINDS = new Set(['assignment', 'session', 'agent-event', 'directive', 'operator-turn', 'operator-action', 'message']);
const PRIVILEGED = new Set(['goal', 'currentTask', 'sessionSkills', 'guardrails', 'text', 'command', 'content', 'prompt', 'reasoning']);

function assertKeys(value, allowed) {
  for (const key of Object.keys(value ?? {})) if (!allowed.has(key)) throw new Error(`privileged field ${key} is not cacheable`);
}

function assertSafeFeed(item) {
  if (!FEED_KINDS.has(item.kind)) throw new Error(`feed kind ${item.kind} is not cacheable`);
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (PRIVILEGED.has(key)) throw new Error(`privileged field ${key} is not cacheable`);
      walk(child);
    }
  };
  walk(item.data);
}

export function createAgentCache({ file = null, maxItems = 2000, clock = Date } = {}) {
  let state = { summary: { assignments: [], sessions: [] }, feed: [], lastSeq: 0, updatedAt: null };
  const persist = () => {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
  };
  const load = () => {
    if (file) {
      try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (value && Array.isArray(value.feed) && value.summary) state = value;
      } catch { /* empty cache */ }
    }
    return structuredClone(state);
  };
  const replaceSummary = (summary) => {
    if (!Array.isArray(summary?.assignments) || !Array.isArray(summary?.sessions)) throw new Error('invalid agent summary');
    summary.assignments.forEach((item) => assertKeys(item, ASSIGNMENT_KEYS));
    summary.sessions.forEach((item) => assertKeys(item, SESSION_KEYS));
    state.summary = structuredClone(summary);
    state.updatedAt = clock.now();
    persist();
    return snapshot();
  };
  const appendFeed = (items) => {
    for (const item of items) {
      assertSafeFeed(item);
      if (!Number.isInteger(item.seq) || item.seq <= state.lastSeq) continue;
      state.feed.push(structuredClone(item));
      state.lastSeq = item.seq;
    }
    if (state.feed.length > maxItems) state.feed.splice(0, state.feed.length - maxItems);
    state.updatedAt = clock.now();
    persist();
    return snapshot();
  };
  const snapshot = () => structuredClone(state);
  load();
  return { load, replaceSummary, appendFeed, snapshot };
}

export function createAgentBridge({ resolveUrl, serviceToken, fetchFn = fetch, cache, clock = Date, log = console }) {
  const listeners = new Set();
  let running = null;
  let stopped = false;
  const publish = (item) => { for (const listener of listeners) listener(item); };
  const refresh = async () => {
    const url = await resolveUrl();
    if (!url) throw new Error('orchestrator offline');
    const headers = { authorization: `Bearer ${serviceToken}` };
    const [summaryResponse, feedResponse] = await Promise.all([
      fetchFn(`${url}/agents`, { headers, signal: AbortSignal.timeout(5000) }),
      fetchFn(`${url}/agents/feed?after=${cache.snapshot().lastSeq}&limit=500`, { headers, signal: AbortSignal.timeout(5000) }),
    ]);
    if (!summaryResponse.ok || !feedResponse.ok) throw new Error(`agent bridge upstream ${summaryResponse.status}/${feedResponse.status}`);
    cache.replaceSummary(await summaryResponse.json());
    const page = await feedResponse.json();
    cache.appendFeed(page.items ?? []);
    for (const item of page.items ?? []) publish(item);
    return cache.snapshot();
  };
  const start = (pollMs = 1000) => {
    if (running) return running;
    stopped = false;
    const loop = async () => {
      while (!stopped) {
        try { await refresh(); } catch (error) { log.warn?.(`[agents] bridge: ${error.message}`); }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    };
    running = loop().finally(() => { running = null; });
    return running;
  };
  return {
    refresh, start, stop() { stopped = true; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => cache.snapshot(),
  };
}
