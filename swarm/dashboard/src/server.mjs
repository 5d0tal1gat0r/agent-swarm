// Server dashboard (ARCHITECTURE 47). Runs on the server. Every pollMs it finds the
// orchestrator (bus location, verified with /whoami, or a fixed URL), reads GET /snapshot
// with its read-only dashboard token, and reads the swarm bus channel for alerts. Viewers
// sign in with a name and password (users file); the session's member token is checked once against
// the orchestrator's GET /me and then remembered (hash only) so the last snapshot stays readable while the orchestrator
// is offline. The page itself is static (static/), with a CSP that allows only 'self'.
// Control actions (ARCHITECTURE 49) are proxied to POST /operator/... with the
// viewer's own token, so the orchestrator checks the viewer's role; the dashboard token
// (read-only) is never used for a write.
// Chat (ARCHITECTURE 72): /chat and /api/chat/* use the session only, never the orchestrator; creating and
// deleting a channel needs the owner role (last known roles while the orchestrator is offline).
// Maintenance (ARCHITECTURE 77): a flag file (written by swarmctl upgrade/restart or by hand) shows on every page
// through /health and refuses writes with 503; chat posting stays open.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { MIN_PASSWORD, changePassword, checkLogin, markNotificationsRead, readNotifications, readUsers, updateNotificationPreferences } from './users.mjs';
import { ChatError, createChatStore } from './chat.mjs';
import { chatNotification, deriveSnapshotNotifications, filterNotifications } from './notifications.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/render.mjs': ['render.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/graph': ['graph.html', 'text/html; charset=utf-8'],
  '/graph.js': ['graph.js', 'text/javascript; charset=utf-8'],
  '/graph.mjs': ['graph.mjs', 'text/javascript; charset=utf-8'],
  '/graph-card.mjs': ['graph-card.mjs', 'text/javascript; charset=utf-8'],
  '/bars.mjs': ['bars.mjs', 'text/javascript; charset=utf-8'],
  '/fix.mjs': ['fix.mjs', 'text/javascript; charset=utf-8'],
  '/chat': ['chat.html', 'text/html; charset=utf-8'],
  '/chat.js': ['chat.js', 'text/javascript; charset=utf-8'],
  '/chat-render.mjs': ['chat-render.mjs', 'text/javascript; charset=utf-8'],
  '/agents': ['agents.html', 'text/html; charset=utf-8'],
  '/agents.js': ['agents.js', 'text/javascript; charset=utf-8'],
  '/agents-render.mjs': ['agents-render.mjs', 'text/javascript; charset=utf-8'],
  '/maint.js': ['maint.js', 'text/javascript; charset=utf-8'],
  '/maint.mjs': ['maint.mjs', 'text/javascript; charset=utf-8'],
};
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEADERS = { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' };
export const VIEWER_TTL_MS = 12 * 3600_000;
const MAX_ALERTS = 50;
// Graph page (ARCHITECTURE 55): bus conversations and shared state, refreshed less often than the snapshot.
export const GRAPH_EVERY_MS = 60_000;
export const GRAPH_NAMESPACES = ['swarm', 'control', 'locks', 'tasks', 'default'];
const GRAPH_MESSAGES = 100;
const MAX_ACTION_BODY = 4096;
// A chat message is up to 2000 characters; escaped or 4-byte characters need up to ~12 KiB of JSON.
const MAX_CHAT_BODY = 16 * 1024;
const TOO_LARGE = Symbol('too large');
export const SESSION_COOKIE = 'swarm_sid';
// Sessions (ARCHITECTURE 71): end after SESSION_TTL_MS without use, and at the latest SESSION_MAX_MS after sign-in.
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
export const SESSION_MAX_MS = 30 * 24 * 3600_000;
const SESSION_RENEW_MS = 3600_000;
export const LOGIN_MAX_FAILURES = 5;
export const LOGIN_WINDOW_MS = 10 * 60_000;
export const OPERATOR_PATH = /^\/api\/operator\/(tasks\/[A-Za-z0-9-]{1,40}\/(resolve|replan|cancel|amend)|pause|resume|departments\/[a-z][a-z0-9-]{0,58}\/(pause|resume)|managers\/[a-z][a-z0-9-]{0,63}\/(pause|resume)|epics|epics\/E-[0-9]{1,8}\/plan|intake|backup|tokens|tokens\/[a-z][a-z0-9-]{0,63}\/revoke)$/;
// Owner reads proxied with the viewer's token: the token list and job status.
export const OPERATOR_GET_PATH = /^\/api\/operator\/(tokens|jobs\/[0-9a-f]{12})$/;
export const CHAT_PING_MS = 25_000;
// A maintenance flag older than this shows as overrun (a failed or forgotten upgrade).
export const MAINTENANCE_OVERRUN_MS = 30 * 60_000;
// The owner check waits this long for the orchestrator, then uses the roles last seen for the viewer.
export const OWNER_CHECK_MS = 1500;
// Open chat streams per session (one per tab); more get 429.
export const MAX_STREAMS = 5;
const NOTIFICATION_BUFFER = 100;
const STREAM_BUFFER = 1024 * 1024;
const CHAT_PATH = /^\/api\/chat\/channels(?:\/([a-z][a-z0-9-]{0,23})(\/messages|\/delete)?)?$/;
const FORWARD = ['reason', 'title', 'body', 'dryRun', 'name', 'member', 'departments', 'role', 'paths', 'acceptance', 'dropDependsOn'];
export const AGENT_DETAIL_PATH = /^\/api\/agents\/(audit|assignments\/[A-Za-z0-9_-]{1,160}(?:\/events)?|conversations\/(?:orchestrator|[A-Za-z0-9_-]{1,160})\/messages)$/;
export const AGENT_WRITE_PATH = /^\/api\/operator\/(agents\/(?:orchestrator|[A-Za-z0-9_-]{1,160})\/(prompt|context|status|pause|resume|replan|interrupt|stop)|agent-actions\/[A-Za-z0-9_-]{1,160}\/(confirm|cancel))$/;
const AGENT_FORWARD = ['text', 'idempotencyKey', 'reason', 'context'];

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * resolveUrl(): orchestrator base URL or null. token: dashboard-role token.
 * bus: { channelHistory(channel, limit), agents() } or null.
 */
export function createDashboard({ resolveUrl, token, bus = null, fetchFn = fetch, clock = Date, log = console, watchdogFile = null, busHealthUrl = null, usersFile = null, snapshotFile = null, sessionsFile = null, chatDir = null, maintenanceFile = null, agentCockpit = false, agentBridge = null }) {
  const state = { snapshot: null, fetchedAt: null, online: false, offlineSince: clock.now(), error: null, url: null, alerts: [] };
  // The last snapshot survives a restart of the dashboard while the orchestrator is offline (ARCHITECTURE 67).
  if (snapshotFile) {
    try { Object.assign(state, (({ snapshot, fetchedAt }) => ({ snapshot, fetchedAt }))(JSON.parse(readFileSync(snapshotFile, 'utf8')))); } catch { /* no saved snapshot yet */ }
  }
  const saveSnapshot = () => {
    if (!snapshotFile) return;
    try {
      writeFileSync(`${snapshotFile}.tmp`, JSON.stringify({ snapshot: state.snapshot, fetchedAt: state.fetchedAt }), { mode: 0o600 });
      renameSync(`${snapshotFile}.tmp`, snapshotFile);
    } catch (err) {
      log.warn?.(`[dashboard] could not save the snapshot: ${err.message}`);
    }
  };
  const viewers = new Map(); // sha256(token) -> { name, member, roles, until }
  const chat = chatDir ? createChatStore({ dir: chatDir, clock }) : null;
  const streams = new Map(); // session key -> open chat streams
  const notificationStreams = new Map(); // session key -> count
  const notificationEvents = [];
  /** { reason, since, overrun } while the flag file exists, else null. Read on each call: swarmctl writes it from outside. */
  const maintenance = () => {
    if (!maintenanceFile || !existsSync(maintenanceFile)) return null;
    let flag = {};
    try { flag = JSON.parse(readFileSync(maintenanceFile, 'utf8')); } catch { /* unreadable still means on */ }
    let since = Date.parse(flag?.since);
    if (!Number.isFinite(since)) { try { since = statSync(maintenanceFile).mtimeMs; } catch { since = clock.now(); } }
    const reason = typeof flag?.reason === 'string' && flag.reason.trim() ? flag.reason.trim().slice(0, 200) : 'maintenance';
    return { reason, since: new Date(since).toISOString(), overrun: clock.now() - since > MAINTENANCE_OVERRUN_MS };
  };
  const inMaintenance = (send) => {
    const m = maintenance();
    if (m) send(503, { error: `dashboard maintenance: ${m.reason}` });
    return Boolean(m);
  };
  const names = new Map(); // bus agent id -> name

  const pushNotifications = (events) => {
    for (const item of events ?? []) {
      if (!item?.id || notificationEvents.some((known) => known.id === item.id)) continue;
      notificationEvents.push(item);
      if (notificationEvents.length > NOTIFICATION_BUFFER) notificationEvents.splice(0, notificationEvents.length - NOTIFICATION_BUFFER);
      for (const stream of [...notificationListeners]) stream(item);
    }
  };
  const notificationListeners = new Set();
  chat?.subscribe((entry) => { if (entry.type === 'message') emitChatNotification(entry.message); });

  const get = async (url, bearer) => {
    const res = await fetchFn(url, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(5000) });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  };

  async function pollOrchestrator() {
    const previous = { ...(state.snapshot ?? {}), online: state.online };
    try {
      const url = await resolveUrl();
      if (!url) throw new Error('no verified orchestrator location');
      const r = await get(`${url}/snapshot`, token);
      if (r.status !== 200) throw new Error(`snapshot returned ${r.status}`);
      Object.assign(state, { snapshot: r.body, fetchedAt: clock.now(), online: true, offlineSince: null, error: null, url });
      pushNotifications(deriveSnapshotNotifications(previous, { ...r.body, online: true }, { now: new Date(clock.now()).toISOString() }));
      saveSnapshot();
    } catch (err) {
      if (state.online || state.offlineSince === null) state.offlineSince = clock.now();
      Object.assign(state, { online: false, error: String(err.message ?? err).slice(0, 200) });
      pushNotifications(deriveSnapshotNotifications(previous, { ...(state.snapshot ?? {}), online: false }, { now: new Date(clock.now()).toISOString() }));
    }
  }

  async function pollAlerts() {
    if (!bus) return;
    const agents = (await bus.agents()) ?? [];
    for (const a of agents) names.set(a.id, a.name);
    const msgs = await bus.channelHistory('swarm', MAX_ALERTS);
    if (!msgs) return;
    state.alerts = [...msgs].sort((a, b) => b.id - a.id).slice(0, MAX_ALERTS)
      .map((m) => ({ id: m.id, at: `${String(m.created_at).replace(' ', 'T')}${/Z$/.test(m.created_at) ? '' : 'Z'}`, from: names.get(m.from_agent) ?? String(m.from_agent).slice(0, 8), content: String(m.content).slice(0, 500) }));
  }

  // Service health beside the orchestrator's own: the watchdog's last state (it runs on this
  // machine and writes a small JSON file) and the bus /health.
  async function pollHealth() {
    const health = { watchdog: null, bus: null };
    if (watchdogFile) {
      try { health.watchdog = JSON.parse(readFileSync(watchdogFile, 'utf8')); } catch { health.watchdog = null; }
    }
    if (busHealthUrl) {
      try { health.bus = (await fetchFn(busHealthUrl, { signal: AbortSignal.timeout(4000) })).ok ? 'ok' : 'down'; } catch { health.bus = 'down'; }
    }
    state.health = health;
  }

  async function pollGraph() {
    if (!bus || (state.graphAt && clock.now() - state.graphAt < GRAPH_EVERY_MS)) return;
    const [agents, channels] = await Promise.all([bus.agents({ includeOffline: true }), bus.listChannels()]);
    if (!agents || !channels) return;
    const messages = {};
    for (const ch of channels) messages[ch.name] = ((await bus.channelHistory(ch.name, GRAPH_MESSAGES)) ?? [])
      .map((m) => ({ id: m.id, from_agent: m.from_agent, content: String(m.content).slice(0, 500), created_at: m.created_at }));
    const st = [];
    for (const ns of GRAPH_NAMESPACES) st.push(...((await bus.stateList(ns)) ?? []));
    state.graph = { agents, channels, messages, state: st };
    state.graphAt = clock.now();
  }

  async function poll() {
    await Promise.all([pollOrchestrator(), pollAlerts().catch((err) => log.warn?.(`[dashboard] alerts: ${err.message}`)), pollHealth(), pollGraph().catch((err) => log.warn?.(`[dashboard] graph: ${err.message}`))]);
  }

  // Password sessions (ARCHITECTURE 54, 71): an HttpOnly cookie maps to the signed-in user. The user's own token
  // is read from the users file on each request, so a removed user is signed out at once. Sessions are saved
  // to sessionsFile by the hash of their id (the raw id is never stored), so a restart signs nobody out.
  const sessions = new Map(); // sha256(sid) -> { user, until, created, renewed }
  if (sessionsFile) {
    try {
      for (const [key, s] of Object.entries(JSON.parse(readFileSync(sessionsFile, 'utf8')).sessions ?? {})) {
        if (s.until > clock.now() && s.created + SESSION_MAX_MS > clock.now()) sessions.set(key, s);
      }
    } catch { /* no saved sessions yet */ }
  }
  const saveSessions = () => {
    if (!sessionsFile) return;
    try {
      writeFileSync(`${sessionsFile}.tmp`, JSON.stringify({ sessions: Object.fromEntries(sessions) }), { mode: 0o600 });
      renameSync(`${sessionsFile}.tmp`, sessionsFile);
    } catch (err) {
      log.warn?.(`[dashboard] could not save sessions: ${err.message}`);
    }
  };
  const endSession = (key) => { if (sessions.delete(key)) saveSessions(); };
  const cookieOf = (req) => Object.fromEntries(String(req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((kv) => kv.length === 2));
  const sessionOf = (req) => {
    const sid = cookieOf(req)[SESSION_COOKIE];
    if (!sid) return null;
    const key = sha(sid);
    const s = sessions.get(key);
    if (!s) return null;
    const now = clock.now();
    if (s.until <= now || s.created + SESSION_MAX_MS <= now) { endSession(key); return null; }
    let token = null;
    try { token = usersFile ? readUsers(usersFile).users[s.user]?.token ?? null : null; } catch { token = null; }
    if (!token) { endSession(key); return null; }
    // Use keeps a session alive: the idle limit restarts, written at most once an hour.
    if (now - s.renewed >= SESSION_RENEW_MS) {
      Object.assign(s, { until: now + SESSION_TTL_MS, renewed: now });
      saveSessions();
    }
    return { sid: key, user: s.user, token, until: s.until };
  };
  const bearerOf = (req) => sessionOf(req)?.token ?? null;
  const failures = new Map(); // ip -> [timestamps]
  const limited = (ip) => (failures.get(ip) ?? []).filter((t) => clock.now() - t < LOGIN_WINDOW_MS).length >= LOGIN_MAX_FAILURES;

  /**
   * { name, member, roles } of the viewer, or null. Checked against the orchestrator, remembered by hash for VIEWER_TTL_MS.
   * While the orchestrator is offline a password session is enough to read (ARCHITECTURE 67): the sign-in was checked
   * here, writes are refused anyway, and the roles are the last known ones (none for a viewer never checked).
   */
  async function viewer(req) {
    const session = sessionOf(req);
    if (!session) return null;
    const key = sha(session.token);
    const known = viewers.get(key);
    if (known && known.until > clock.now()) return known;
    if (!state.url || !state.online) return known ?? { name: session.user, member: null, roles: [] };
    const bearer = session.token;
    try {
      const r = await get(`${state.url}/me`, bearer);
      if (r.status !== 200 || !r.body?.name) return null;
      const record = { name: r.body.name, member: r.body.member ?? null, roles: Array.isArray(r.body.roles) ? r.body.roles : [], until: clock.now() + VIEWER_TTL_MS };
      viewers.set(key, record);
      return record;
    } catch {
      return null;
    }
  }

  // null for bad JSON; TOO_LARGE when the body passes `max` bytes.
  async function readBody(req, max = MAX_ACTION_BODY) {
    let size = 0;
    const chunks = [];
    for await (const c of req) {
      size += c.length;
      if (size > max) return TOO_LARGE;
      chunks.push(c);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return null; }
  }

  // Chat routes (ARCHITECTURE 72). The author is the session's user; the client never names it.
  async function handleChat(req, res, url, send) {
    if (!chat) return send(404, { error: 'not found' });
    const session = sessionOf(req);
    if (!session) return send(401, { error: 'sign in' });
    // A slow or just-gone orchestrator must not hold up the page: after OWNER_CHECK_MS use the last roles seen.
    const isOwner = async () => {
      let timer;
      const known = new Promise((r) => { timer = setTimeout(() => r(viewers.get(sha(session.token)) ?? null), OWNER_CHECK_MS); });
      const who = await Promise.race([viewer(req), known]).finally(() => clearTimeout(timer));
      return (who?.roles ?? []).includes('owner');
    };
    try {
      if (req.method === 'GET' && url.pathname === '/api/chat/stream') {
        if ((streams.get(session.sid) ?? 0) >= MAX_STREAMS) return send(429, { error: `at most ${MAX_STREAMS} open chat tabs` });
        return chatStream(req, res, session.sid, Number(url.searchParams.get('after')) || 0);
      }
      const m = CHAT_PATH.exec(url.pathname);
      if (!m) return send(404, { error: 'not found' });
      const [, name, action] = m;
      if (req.method === 'GET' && !name) return send(200, { channels: chat.channels(), admin: await isOwner(), me: session.user, lastId: chat.lastId() });
      if (req.method === 'GET' && action === '/messages') {
        const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : null;
        const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
        return send(200, chat.history(name, { before, limit }));
      }
      if (req.method !== 'POST') return send(404, { error: 'not found' });
      const body = await readBody(req, MAX_CHAT_BODY);
      if (body === TOO_LARGE) return send(413, { error: 'message too long' });
      if (!body || typeof body !== 'object') return send(400, { error: 'invalid JSON body' });
      if (action === '/messages') return send(201, chat.post(name, session.user, body.text));
      if (!name) {
        if (!(await isOwner())) return send(403, { error: 'only owners create channels' });
        if (inMaintenance(send)) return;
        return send(201, chat.create(body.name, session.user));
      }
      if (action === '/delete') {
        if (!(await isOwner())) return send(403, { error: 'only owners delete channels' });
        if (inMaintenance(send)) return;
        chat.remove(name, session.user);
        return send(200, { ok: true });
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      if (err instanceof ChatError) return send(err.status, { error: err.message });
      throw err;
    }
  }

  // One SSE stream per open chat page: missed messages after `after`, then live events and a keep-alive comment.
  function chatStream(req, res, sid, after) {
    streams.set(sid, (streams.get(sid) ?? 0) + 1);
    let off = () => {};
    let ping = null;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(ping);
      off();
      if (streams.get(sid) > 1) streams.set(sid, streams.get(sid) - 1); else streams.delete(sid);
    };
    res.on('close', stop);
    req.socket.setTimeout(0);
    res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    res.write(': connected\n\n'); // flushes the headers so the page sees the stream open
    // Checked before every frame: sign-out, a password change or `user remove` ends the stream, and so does a
    // client that stopped reading (more than STREAM_BUFFER bytes waiting).
    const live = () => {
      if (!stopped && sessionOf(req) && res.writableLength <= STREAM_BUFFER) return true;
      stop();
      res.end();
      return false;
    };
    const write = (e) => {
      if (!live()) return;
      const data = e.type === 'message' ? e.message : e.type === 'channel-created' ? e.channel : { name: e.name };
      res.write(`${e.type === 'message' ? `id: ${e.message.id}\n` : ''}event: ${e.type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    for (const message of chat.since(after)) write({ type: 'message', message });
    if (stopped) return;
    off = chat.subscribe(write);
    ping = setInterval(() => { if (live()) res.write(': ping\n\n'); }, CHAT_PING_MS);
  }

  function notificationStream(req, res, session, after) {
    const count = notificationStreams.get(session.sid) ?? 0;
    if (count >= MAX_STREAMS) return { status: 429, body: { error: `at most ${MAX_STREAMS} open notification tabs` } };
    notificationStreams.set(session.sid, count + 1);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      notificationListeners.delete(listener);
      const current = notificationStreams.get(session.sid) ?? 1;
      if (current > 1) notificationStreams.set(session.sid, current - 1); else notificationStreams.delete(session.sid);
    };
    const live = () => {
      if (!stopped && sessionOf(req) && res.writableLength <= STREAM_BUFFER) return true;
      stop();
      if (!res.writableEnded) res.end();
      return false;
    };
    const who = { name: session.user, member: session.user };
    const prefs = () => { try { return readNotifications(usersFile, session.user); } catch { return {}; } };
    const write = (item) => {
      if (!live() || !filterNotifications([item], who, prefs()).length) return;
      const frame = `id: ${item.id}\nevent: notification\ndata: ${JSON.stringify(item)}\n\n`;
      if (Buffer.byteLength(frame) > STREAM_BUFFER || !res.write(frame)) stop();
    };
    const listener = (item) => write(item);
    res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    req.socket.setTimeout(0);
    res.write('event: ready\ndata: {}\n\n');
    const start = notificationEvents.findIndex((item) => item.id === after);
    const replay = start >= 0 ? notificationEvents.slice(start + 1) : notificationEvents;
    for (const item of replay) write(item);
    if (stopped) return;
    notificationListeners.add(listener);
    const ping = setInterval(() => { if (live()) res.write(': ping\n\n'); }, CHAT_PING_MS);
    ping.unref?.();
    req.on('close', () => { clearInterval(ping); stop(); });
  }

  const emitChatNotification = (message) => {
    if (!usersFile) return;
    let users;
    try { users = readUsers(usersFile).users; } catch { return; }
    for (const name of Object.keys(users)) {
      let prefs;
      try { prefs = readNotifications(usersFile, name); } catch { prefs = {}; }
      const item = chatNotification(message, { name, member: name }, prefs);
      if (item) pushNotifications([item]);
    }
  };

  function agentStream(req, res, after) {
    const session = sessionOf(req);
    if (!session || !agentBridge) {
      res.writeHead(session ? 503 : 401, { 'content-type': 'application/json', ...HEADERS });
      return res.end(JSON.stringify({ error: session ? 'agent stream unavailable' : 'sign in' }));
    }
    let stopped = false;
    let buffered = 0;
    let off = () => {};
    let ping = null;
    const write = (item) => {
      if (stopped || !sessionOf(req)) return stop();
      const frame = `id: ${item.seq}\nevent: ${item.kind}\ndata: ${JSON.stringify(item)}\n\n`;
      const accepted = res.write(frame);
      buffered = accepted ? 0 : buffered + Buffer.byteLength(frame);
      if (buffered > STREAM_BUFFER) stop();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(ping);
      off();
      if (!res.writableEnded) res.end();
    };
    res.writeHead(200, { ...HEADERS, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
    res.write(': connected\n\n');
    for (const item of agentBridge.snapshot().feed.filter((entry) => entry.seq > after)) write(item);
    off = agentBridge.subscribe(write);
    ping = setInterval(() => {
      if (!sessionOf(req)) return stop();
      res.write(': ping\n\n');
    }, CHAT_PING_MS);
    ping.unref?.();
    req.on('close', stop);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', ...HEADERS });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204, HEADERS); return res.end(); }
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, orchestrator: state.online, maintenance: maintenance() });
      if (req.method === 'GET' && FILES[url.pathname]) {
        if (url.pathname.startsWith('/agents') && !agentCockpit) return send(404, { error: 'not found' });
        const [file, type] = FILES[url.pathname];
        res.writeHead(200, { 'content-type': type, ...HEADERS });
        return res.end(readFileSync(path.join(STATIC, file)));
      }
      // A POST from another site is refused: the session cookie is SameSite=Strict, and the Origin must be this host.
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return send(403, { error: 'cross-site request refused' });
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const ip = req.socket.remoteAddress ?? '?';
        if (limited(ip)) return send(429, { error: 'too many failed sign-ins; wait 10 minutes' });
        const body = await readBody(req);
        const userToken = usersFile && body ? checkLogin(usersFile, body.user, body.password) : null;
        if (!userToken) {
          failures.set(ip, [...(failures.get(ip) ?? []).filter((t) => clock.now() - t < LOGIN_WINDOW_MS), clock.now()]);
          return send(401, { error: 'wrong user or password' });
        }
        failures.delete(ip);
        const sid = randomBytes(32).toString('hex');
        const now = clock.now();
        sessions.set(sha(sid), { user: String(body.user), until: now + SESSION_TTL_MS, created: now, renewed: now });
        saveSessions();
        res.setHeader('set-cookie', `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_MS / 1000}`);
        return send(200, { user: String(body.user) });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') {
        const s = sessionOf(req);
        if (s) endSession(s.sid);
        res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return send(200, { ok: true });
      }
      // Change your own password (ARCHITECTURE 58): the current one is checked like a sign-in and
      // counts toward the same lockout; on success the user's other sessions end.
      if (req.method === 'POST' && url.pathname === '/api/password') {
        const s = sessionOf(req);
        if (!s) return send(401, { error: 'sign in' });
        const ip = req.socket.remoteAddress ?? '?';
        if (limited(ip)) return send(429, { error: 'too many failed attempts; wait 10 minutes' });
        const body = await readBody(req);
        if (String(body?.next ?? '').length < MIN_PASSWORD) return send(400, { error: `the new password needs at least ${MIN_PASSWORD} characters` });
        if (!changePassword(usersFile, s.user, body?.current, body.next)) {
          failures.set(ip, [...(failures.get(ip) ?? []).filter((t) => clock.now() - t < LOGIN_WINDOW_MS), clock.now()]);
          return send(403, { error: 'current password is wrong' });
        }
        for (const [sid, other] of sessions) if (other.user === s.user && sid !== s.sid) sessions.delete(sid);
        saveSessions();
        return send(200, { ok: true });
      }
      if (url.pathname.startsWith('/api/notifications/')) {
        const session = sessionOf(req);
        if (!session) return send(401, { error: 'sign in' });
        if (req.method === 'GET' && url.pathname === '/api/notifications/stream') {
          const result = notificationStream(req, res, session, url.searchParams.get('after') ?? '');
          return result?.status ? send(result.status, result.body) : result;
        }
        if (req.method === 'GET' && url.pathname === '/api/notifications/preferences') return send(200, readNotifications(usersFile, session.user));
        if (req.method === 'POST' && url.pathname === '/api/notifications/preferences') {
          const body = await readBody(req, MAX_ACTION_BODY);
          if (!body || typeof body !== 'object' || body === TOO_LARGE) return send(body === TOO_LARGE ? 413 : 400, { error: body === TOO_LARGE ? 'body too large' : 'invalid JSON body' });
          try { return send(200, updateNotificationPreferences(usersFile, session.user, body)); } catch (err) { return send(400, { error: err.message }); }
        }
        if (req.method === 'POST' && url.pathname === '/api/notifications/read') {
          const body = await readBody(req, MAX_ACTION_BODY);
          if (!body || typeof body !== 'object' || body === TOO_LARGE) return send(body === TOO_LARGE ? 413 : 400, { error: body === TOO_LARGE ? 'body too large' : 'invalid JSON body' });
          try { return send(200, markNotificationsRead(usersFile, session.user, body.eventId)); } catch (err) { return send(400, { error: err.message }); }
        }
        return send(404, { error: 'not found' });
      }
      if (url.pathname.startsWith('/api/chat/')) return await handleChat(req, res, url, send);
      if (agentCockpit && req.method === 'GET' && url.pathname === '/api/agents') {
        const who = await viewer(req);
        if (!who) return send(401, { error: 'sign in' });
        return send(200, { ...agentBridge?.snapshot(), online: state.online, offlineSince: state.offlineSince, viewer: who.name, viewerRoles: who.roles });
      }
      if (agentCockpit && req.method === 'GET' && url.pathname === '/api/agents/stream') {
        return agentStream(req, res, Number(url.searchParams.get('after')) || 0);
      }
      if (agentCockpit && req.method === 'GET' && AGENT_DETAIL_PATH.test(url.pathname)) {
        const who = await viewer(req);
        if (!who) return send(401, { error: 'sign in' });
        if (!state.online) return send(503, { error: 'orchestrator offline: detail is unavailable' });
        const response = await get(`${state.url}${url.pathname.slice(4)}${url.search}`, bearerOf(req));
        return send(response.status, response.body);
      }
      if (agentCockpit && req.method === 'POST' && AGENT_WRITE_PATH.test(url.pathname)) {
        const who = await viewer(req);
        if (!who) return send(401, { error: 'sign in' });
        if (!state.online) return send(503, { error: 'orchestrator offline: actions wait until it is back' });
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return send(400, { error: 'invalid JSON body' });
        const pick = Object.fromEntries(AGENT_FORWARD.filter((key) => body[key] !== undefined).map((key) => [key, body[key]]));
        const upstream = await fetchFn(`${state.url}${url.pathname.slice(4)}`, {
          method: 'POST', headers: { authorization: `Bearer ${bearerOf(req)}`, 'content-type': 'application/json' },
          body: JSON.stringify(pick), signal: AbortSignal.timeout(10_000),
        });
        return send(upstream.status, await upstream.json().catch(() => ({})));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/operator/')) {
        if (!OPERATOR_PATH.test(url.pathname)) return send(404, { error: 'unknown action' });
        const who = await viewer(req);
        if (!who) return send(401, { error: 'sign in' });
        if (inMaintenance(send)) return;
        if (!state.online) return send(503, { error: 'orchestrator offline: actions wait until it is back' });
        const body = await readBody(req);
        if (!body || typeof body !== 'object') return send(400, { error: 'invalid JSON body' });
        const pick = Object.fromEntries(FORWARD.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
        const res2 = await fetchFn(`${state.url}${url.pathname.slice(4)}`, {
          method: 'POST', headers: { authorization: `Bearer ${bearerOf(req)}`, 'content-type': 'application/json' },
          body: JSON.stringify(pick), signal: AbortSignal.timeout(10_000),
        });
        const out = await res2.json().catch(() => ({}));
        await pollOrchestrator();
        return send(res2.status, out);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
        const who = await viewer(req);
        if (!who) return send(401, { error: 'sign in' });
        if (url.pathname === '/api/snapshot') {
          const { snapshot, fetchedAt, online, offlineSince, error, alerts, health } = state;
          return send(200, { viewer: who.name, viewerMember: who.member, viewerRoles: who.roles, snapshot, fetchedAt, online, offlineSince, error, alerts, health: health ?? null, maintenance: maintenance() });
        }
        if (url.pathname === '/api/graph') {
          return send(200, { bus: state.graph ?? { agents: [], channels: [], messages: {}, state: [] }, snapshot: state.snapshot, graphAt: state.graphAt ?? null, online: state.online });
        }
        if (OPERATOR_GET_PATH.test(url.pathname)) {
          if (!state.online) return send(503, { error: 'orchestrator offline' });
          const r = await get(`${state.url}${url.pathname.slice(4)}`, bearerOf(req));
          return send(r.status, r.body);
        }
        const m = /^\/api\/history\/([A-Za-z0-9-]{1,40})$/.exec(url.pathname);
        if (m) {
          if (!state.online) return send(503, { error: 'orchestrator offline' });
          const r = await get(`${state.url}/tasks/${m[1]}/history`, token);
          return send(r.status, r.body);
        }
      }
      return send(404, { error: 'not found' });
    } catch (err) {
      log.error?.(`[dashboard] ${err.message}`);
      return send(500, { error: 'internal error' });
    }
  }

  return { state, poll, handle, server: createServer(handle) };
}
