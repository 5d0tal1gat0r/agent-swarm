// Task API over HTTP + JSON. Every request is authenticated with a manager
// bearer token, and every body is validated against protocol/api/*.schema.json
// before the store sees it. Standby managers may lease a department only while
// its host has been silent for heartbeatStaleMinutes.
import { createServer as createHttpServer } from 'node:http';
import { validate } from '../../protocol/validate.mjs';
import { authenticate, readTokens } from './tokens.mjs';
import { SWARM_CHANNEL, publishEvents } from './events.mjs';
import { DEFAULT_MAX_OPEN_PRS, clearPause, openPrsOf, setPause } from './guard.mjs';
import { createMcp, RPC } from './mcp.mjs';
import { DASHBOARD_CSP, DASHBOARD_HTML, computeMetrics } from './metrics.mjs';
import { whoamiProof } from '../../shared/locate.mjs';
import { managersFrom, planDispatch } from './dispatcher.mjs';
import { OPERATOR_ACTIONS, applyAndAnnounce } from './operator.mjs';
import { createJobs, createToken, listTokens, revokeToken } from './admin.mjs';
import { canActOnManager, canActOnTask, leaseBlock, readPauses, reasonOf, writePause } from './controls.mjs';
import { departmentInfoOf } from './config.mjs';
import { overlaps } from '../../shared/globs.mjs';
import { ownerOf } from './router.mjs';

const MAX_BODY = 1024 * 1024;
const READ_ROLES = ['manager', 'dashboard'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body is not valid JSON');
  }
}

function checked(schema, body) {
  const { ok, errors } = validate(schema, body);
  if (!ok) throw new HttpError(400, `invalid ${schema}: ${errors.join('; ')}`);
  return body;
}

function storeError(err) {
  if (err instanceof HttpError) return err;
  if (Number.isInteger(err?.status) && err.status >= 400 && err.status <= 599) return new HttpError(err.status, err.message);
  const msg = err.message ?? String(err);
  if (/^unknown (task|epic)/.test(msg)) return new HttpError(404, msg);
  if (/already exists|forbidden transition|not leased by|cannot report|must cover|version changed|slots must|tokens must|is not a plain string|is not on the/.test(msg)) {
    return new HttpError(409, msg);
  }
  return new HttpError(500, 'internal error');
}

function integerParam(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, `invalid numeric parameter ${value}`);
  return parsed;
}

/** A bounded SSE writer. A client that remains backpressured beyond the cap is disconnected. */
export function createSseWriter(res, { maxBufferedBytes = 1024 * 1024 } = {}) {
  let buffered = 0;
  let closed = false;
  res.on?.('drain', () => { buffered = 0; });
  const close = () => {
    if (closed) return;
    closed = true;
    if (!res.writableEnded) res.end();
  };
  const write = (frame) => {
    if (closed || res.writableEnded) return false;
    const bytes = Buffer.byteLength(frame, 'utf8');
    const accepted = res.write(frame);
    buffered = accepted ? 0 : buffered + bytes;
    if (buffered > maxBufferedBytes) close();
    return !closed;
  };
  return { write, close, get closed() { return closed; } };
}

/** Streams the reconnectable common agent feed. Detail stays behind separate routes. */
export function startAgentFeedStream({
  store, res, after = 0, taskId, assignmentId,
  setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  pollMs = 250, pingMs = 25_000,
}) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  });
  const writer = createSseWriter(res);
  let cursor = after;
  const poll = () => {
    if (writer.closed) return;
    const page = store.agentFeed({ after: cursor, taskId, assignmentId, limit: 500 });
    for (const item of page.items) {
      if (!writer.write(`id: ${item.seq}\nevent: ${item.kind}\ndata: ${JSON.stringify(item)}\n\n`)) break;
      cursor = item.seq;
    }
  };
  poll();
  const pollTimer = setIntervalFn(poll, pollMs);
  const pingTimer = setIntervalFn(() => writer.write(': ping\n\n'), pingMs);
  pollTimer.unref?.();
  pingTimer.unref?.();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(pollTimer);
    clearIntervalFn(pingTimer);
    writer.close();
  };
  res.on?.('close', stop);
  return stop;
}

/**
 * The checked changes of an amend request. Paths: 1-40 repo-relative paths or globs, each owned by the
 * task's department or matching a contract glob. Acceptance: 1-20 statements of up to 300 characters.
 * dropDependsOn: ids the task depends on today. Anything else is a 400.
 */
export function amendChanges(body, task, departments) {
  const out = {};
  if (body.paths !== undefined) {
    const paths = Array.isArray(body.paths) ? body.paths.map((p) => String(p).trim()).filter(Boolean) : null;
    if (!paths || !paths.length || paths.length > 40) throw new HttpError(400, 'paths: 1 to 40 entries');
    for (const p of paths) {
      if (p.length > 200 || p.startsWith('/') || p.split('/').includes('..') || !/^[A-Za-z0-9._*?{}\[\],/-]+$/.test(p)) throw new HttpError(400, `bad path: ${p.slice(0, 80)}`);
      const contract = departments.contracts.some((g) => overlaps(g, p));
      if (!contract && ownerOf(departments, p) !== task.department) throw new HttpError(400, `${p} is not in ${task.department}'s paths or a contract`);
    }
    out.paths = [...new Set(paths)];
  }
  if (body.acceptance !== undefined) {
    const acc = Array.isArray(body.acceptance) ? body.acceptance.map((a) => String(a).trim()).filter(Boolean) : null;
    if (!acc || !acc.length || acc.length > 20 || acc.some((a) => a.length > 300)) throw new HttpError(400, 'acceptance: 1 to 20 statements of up to 300 characters');
    out.acceptance = acc;
  }
  if (body.dropDependsOn !== undefined) {
    if (!Array.isArray(body.dropDependsOn) || body.dropDependsOn.some((d) => !task.dependsOn.includes(d))) throw new HttpError(400, 'dropDependsOn: ids this task depends on');
    out.dropDependsOn = body.dropDependsOn;
  }
  return out;
}

/** Next free epic id: E-0001, E-0002, ... */
export function nextEpicId(store) {
  let n = store.epicAges().size + 1;
  while (store.epicAges().has(`E-${String(n).padStart(4, '0')}`)) n += 1;
  return `E-${String(n).padStart(4, '0')}`;
}

export function createApi({ store, departments, policy, tokensFile, clock = { now: () => Date.now() }, bus = null, guard = null, ops = {}, log = console }) {
  const jobs = createJobs({ clock });
  // manager name -> { member, at, agent, version, freeSlots, running }. Persisted in the store, so a restart keeps the original `at`.
  const heartbeats = store.listHeartbeats();
  if (bus) publishEvents(store, bus, { log });

  const staleMs = policy.limits.heartbeatStaleMinutes * 60_000;
  const hostIsSilent = (member) => {
    const latest = [...heartbeats.values()].filter((h) => h.member === member).reduce((m, h) => Math.max(m, h.at), 0);
    return clock.now() - latest > staleMs;
  };

  const createEpic = (body) => store.createEpic({ ...body, id: nextEpicId(store), status: 'open', source: 'human', issue: body.issue ?? null });
  const mcp = createMcp({ store, departments, createEpic, log });

  const assignmentSummary = (assignment) => ({
    id: assignment.id, kind: assignment.kind, parentId: assignment.parentId, manager: assignment.manager,
    taskId: assignment.taskId, role: assignment.role, status: assignment.status,
    createdAt: assignment.createdAt, updatedAt: assignment.updatedAt, endedAt: assignment.endedAt ?? null,
  });
  const sessionSummary = (session) => ({
    id: session.id, assignmentId: session.assignmentId, agentKind: session.agentKind, model: session.model,
    status: session.status, phase: session.phase, startedAt: session.startedAt, updatedAt: session.updatedAt,
    endedAt: session.endedAt ?? null, inputTokens: session.inputTokens, outputTokens: session.outputTokens,
    lastEventSeq: session.lastEventSeq,
  });

  function auth(req, roles = ['manager']) {
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const manager = authenticate(readTokens(tokensFile), bearer);
    if (!manager) throw new HttpError(401, 'missing or unknown token');
    if (!manager.roles.some((r) => roles.includes(r))) throw new HttpError(403, 'token lacks the required role');
    return manager;
  }

  function assertLeaseRights(manager, department) {
    const dept = departments.departments[department];
    if (!dept) throw new HttpError(404, `unknown department ${department}`);
    if (!manager.departments.includes(department)) throw new HttpError(403, `${manager.name} is not bound to ${department}`);
    if (manager.member === dept.host) return;
    if (dept.standby === manager.member && hostIsSilent(dept.host)) return;
    throw new HttpError(403, `${manager.name} may not lease ${department} (host ${dept.host} is online or ${manager.member} is not standby)`);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });
      // Unauthenticated on purpose: proves this server holds the manager's token hash (ARCHITECTURE 43).
      if (req.method === 'POST' && url.pathname === '/whoami') {
        const body = await readJson(req);
        const record = readTokens(tokensFile).managers?.[body.manager];
        if (!record?.hash || typeof body.nonce !== 'string' || !/^[0-9a-f]{16,128}$/.test(body.nonce)) throw new HttpError(404, 'unknown manager');
        return send(200, { proof: whoamiProof(record.hash, body.nonce) });
      }

      if (req.method === 'GET' && url.pathname === '/metrics') {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('referrer-policy', 'no-referrer');
        auth(req, READ_ROLES);
        return send(200, computeMetrics(store.listTasks(), { now: clock.now() }));
      }

      // Read routes for the server dashboard. Token hashes and task history stay out of the snapshot.
      if (req.method === 'GET' && url.pathname === '/me') {
        const me = auth(req, ['manager', 'intake', 'dashboard']);
        return send(200, { name: me.name, member: me.member, roles: me.roles });
      }
      if (req.method === 'GET' && url.pathname === '/snapshot') {
        auth(req, READ_ROLES);
        res.setHeader('cache-control', 'no-store');
        const now = clock.now();
        const tasks = store.listTasks();
        const { presence } = planDispatch({ now, managers: managersFrom(readTokens(tokensFile), heartbeats), queued: new Map() });
        const beats = Object.fromEntries([...heartbeats].map(([name, h]) => [name, h]));
        const tokenRecords = readTokens(tokensFile).managers ?? {};
        return send(200, {
          at: new Date(now).toISOString(),
          tasks: tasks.map(({ history, ...t }) => t),
          epics: store.listEpics(),
          managers: presence.map((p) => ({ ...p, member: tokenRecords[p.name]?.member ?? null, departments: tokenRecords[p.name]?.departments ?? [], lastHeartbeat: beats[p.name]?.at ?? null, freeSlots: beats[p.name]?.freeSlots ?? null, running: beats[p.name]?.running ?? [] })),
          metrics: computeMetrics(tasks, { now }),
          paused: guard?.isPaused?.() ?? false,
          pauses: readPauses(store),
          departments: Object.keys(departments.departments),
          departmentInfo: departmentInfoOf(departments),
          service: ops.info?.() ?? null,
        });
      }
      if (req.method === 'GET' && parts[0] === 'tasks' && parts.length === 3 && parts[2] === 'history') {
        auth(req, READ_ROLES);
        try {
          return send(200, { history: store.history(parts[1]) });
        } catch {
          throw new HttpError(404, `unknown task ${parts[1]}`);
        }
      }

      // Agent cockpit common state. These routes intentionally contain summaries only.
      if (req.method === 'GET' && url.pathname === '/agents') {
        const who = auth(req, ['owner', 'manager', 'dashboard']);
        if (ops.agentControl && !ops.agentControl.canReadSummary(who)) throw new HttpError(403, 'agent summaries are not available to this token');
        return send(200, {
          assignments: store.listAgentAssignments().map(assignmentSummary),
          sessions: store.listAgentSessions().map(sessionSummary),
        });
      }
      if (req.method === 'GET' && url.pathname === '/agents/feed') {
        auth(req, ['owner', 'manager', 'dashboard']);
        return send(200, store.agentFeed({
          after: integerParam(url.searchParams.get('after'), 0),
          limit: integerParam(url.searchParams.get('limit'), 100, { min: 1, max: 500 }),
          taskId: url.searchParams.get('task') ?? undefined,
          assignmentId: url.searchParams.get('assignment') ?? undefined,
        }));
      }
      if (req.method === 'GET' && url.pathname === '/agents/stream') {
        auth(req, ['owner', 'manager', 'dashboard']);
        startAgentFeedStream({
          store, res,
          after: integerParam(url.searchParams.get('after') ?? req.headers['last-event-id'], 0),
          taskId: url.searchParams.get('task') ?? undefined,
          assignmentId: url.searchParams.get('assignment') ?? undefined,
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/agents/audit') {
        const who = auth(req, ['owner', 'manager']);
        const assignmentId = url.searchParams.get('assignment') ?? undefined;
        const taskId = url.searchParams.get('task') ?? undefined;
        if (!assignmentId && !taskId && !who.roles.includes('owner')) throw new HttpError(403, 'an assignment or task filter is required');
        if (assignmentId && !ops.agentControl?.canReadDetail(who, assignmentId)) throw new HttpError(403, `${who.name} may not read ${assignmentId}`);
        if (taskId && !who.roles.includes('owner')) {
          const readable = store.listAgentAssignments({ taskId }).some((item) => ops.agentControl?.canReadDetail(who, item.id));
          if (!readable) throw new HttpError(403, `${who.name} may not read task ${taskId}`);
        }
        return send(200, { items: store.agentAudit({
          assignmentId, taskId,
          limit: integerParam(url.searchParams.get('limit'), 200, { min: 1, max: 500 }),
        }) });
      }
      if (req.method === 'GET' && parts[0] === 'agents' && parts[1] === 'assignments' && parts.length === 3) {
        const who = auth(req, ['owner', 'manager', 'dashboard']);
        if (!ops.agentControl?.canReadDetail(who, parts[2])) throw new HttpError(403, `${who.name} may not read ${parts[2]}`);
        let assignment;
        try { assignment = store.getAgentAssignment(parts[2]); }
        catch { throw new HttpError(404, `unknown agent assignment ${parts[2]}`); }
        return send(200, { assignment, session: store.latestAgentSession(parts[2]) ?? null });
      }
      if (req.method === 'GET' && parts[0] === 'agents' && parts[1] === 'assignments' && parts[3] === 'events' && parts.length === 4) {
        const who = auth(req, ['owner', 'manager', 'dashboard']);
        if (!ops.agentControl?.canReadDetail(who, parts[2])) throw new HttpError(403, `${who.name} may not read ${parts[2]}`);
        return send(200, { events: store.agentEvents(parts[2], {
          before: url.searchParams.has('before') ? integerParam(url.searchParams.get('before'), undefined, { min: 1 }) : undefined,
          limit: integerParam(url.searchParams.get('limit'), 100, { min: 1, max: 500 }),
        }) });
      }
      if (req.method === 'GET' && parts[0] === 'agents' && parts[1] === 'conversations' && parts[3] === 'messages' && parts.length === 4) {
        const who = auth(req, ['owner', 'manager', 'dashboard']);
        const target = parts[2];
        if (target === 'orchestrator') {
          if (!ops.agentControl?.canPromptOrchestrator(who)) throw new HttpError(403, 'orchestrator conversation is owner-only');
        } else if (!ops.agentControl?.canReadDetail(who, target)) {
          throw new HttpError(403, `${who.name} may not read ${target}`);
        }
        return send(200, { messages: store.agentMessages(target, {
          before: url.searchParams.has('before') ? integerParam(url.searchParams.get('before'), undefined, { min: 1 }) : undefined,
          limit: integerParam(url.searchParams.get('limit'), 100, { min: 1, max: 100 }),
        }) });
      }

      if (req.method === 'POST' && parts[0] === 'operator' && parts[1] === 'agents' && parts.length === 4) {
        const who = auth(req, ['owner', 'manager']);
        const target = parts[2];
        const operation = parts[3];
        const body = await readJson(req);
        const key = body.idempotencyKey;
        if (typeof key !== 'string' || key.length < 8 || key.length > 200) throw new HttpError(400, 'idempotencyKey must be 8 to 200 characters');
        if (operation === 'prompt') {
          if (typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text, 'utf8') > 8192) throw new HttpError(400, 'text must be 1 to 8192 bytes');
          const assignment = ops.agentControl.assertDirectiveAllowed(who, target, 'prompt');
          if (target === 'orchestrator') {
            if (!ops.operatorWorker?.enabled) throw new HttpError(501, 'orchestrator prompting is disabled; start with --operator-cmd');
            const message = store.appendAgentMessage({ target, actor: who.name, role: 'user', text: body.text });
            return send(202, { message, turn: store.createOperatorTurn({ target, messageId: message.id }) });
          }
          const directive = store.createAgentDirective({
            idempotencyKey: key, target: assignment.id, taskId: assignment.taskId, kind: 'prompt',
            payload: { text: body.text }, actor: who.name, reason: body.reason ?? null,
          });
          store.appendAgentMessage({ target: assignment.id, actor: who.name, role: 'user', text: body.text, directiveId: directive.id });
          return send(202, { directive });
        }
        if (operation === 'context') {
          checked('api/agent-context.request', body);
          const assignment = ops.agentControl.assertDirectiveAllowed(who, target, 'context');
          const context = ops.agentControl.validateContext(who, target, body.context);
          const directive = store.createAgentDirective({
            idempotencyKey: key, target: assignment.id, taskId: assignment.taskId, kind: 'context',
            payload: { context }, actor: who.name, reason: body.reason,
          });
          return send(202, { directive });
        }
        if (!['status', 'pause', 'resume', 'replan', 'interrupt', 'stop'].includes(operation)) throw new HttpError(404, `unknown agent operation ${operation}`);
        const assignment = ops.agentControl.assertDirectiveAllowed(who, target, operation);
        if (typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 300) throw new HttpError(400, 'a reason of at least 3 characters is required');
        const directive = store.createAgentDirective({
          idempotencyKey: key, target: assignment.id, taskId: assignment.taskId, kind: operation,
          payload: {}, actor: who.name, reason: body.reason,
        });
        return send(202, { directive });
      }

      if (req.method === 'POST' && parts[0] === 'operator' && parts[1] === 'agent-actions' && parts.length === 4) {
        const who = auth(req, ['owner']);
        const body = await readJson(req);
        if (typeof body.reason !== 'string' || body.reason.trim().length < 3) throw new HttpError(400, 'a reason of at least 3 characters is required');
        if (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 8) throw new HttpError(400, 'idempotencyKey is required');
        if (!ops.operatorWorker) throw new HttpError(501, 'operator worker is disabled');
        if (parts[3] === 'confirm') return send(200, { action: await ops.operatorWorker.confirmAction(parts[2], { actor: who.name, reason: body.reason, idempotencyKey: body.idempotencyKey }) });
        if (parts[3] === 'cancel') return send(200, { action: await ops.operatorWorker.cancelAction(parts[2], { actor: who.name, reason: body.reason, idempotencyKey: body.idempotencyKey }) });
        throw new HttpError(404, `unknown agent action ${parts[3]}`);
      }

      if (parts[0] === 'managers' && parts.length >= 3 && ['directives', 'agent-sessions', 'agent-events'].includes(parts[2])) {
        const manager = auth(req, ['manager']);
        if (parts[1] !== manager.name) throw new HttpError(403, 'manager path does not match token');
        if (req.method === 'GET' && parts[2] === 'directives' && parts.length === 3) {
          return send(200, { directives: store.managerDirectives(manager.name, { after: url.searchParams.get('after') ?? undefined }) });
        }
        if (req.method === 'POST' && parts[2] === 'directives' && parts[4] === 'ack' && parts.length === 5) {
          const body = checked('api/agent-directive.request', await readJson(req));
          return send(200, { directive: store.ackAgentDirective(parts[3], { manager: manager.name, ...body }) });
        }
        if (req.method === 'POST' && parts[2] === 'agent-sessions' && parts.length === 3) {
          const body = checked('api/agent-session.request', await readJson(req));
          let assignment;
          try {
            assignment = store.getAgentAssignment(body.session.assignmentId);
          } catch {
            if (body.operation !== 'start') throw new HttpError(404, `unknown agent assignment ${body.session.assignmentId}`);
            const match = /^agent-(T-[0-9]{4,})-([a-z][a-z0-9-]{0,30})-[A-Za-z0-9_-]+$/.exec(body.session.assignmentId);
            if (!match) throw new HttpError(400, 'new assignment id must include its task and role');
            const task = store.getTask(match[1]);
            if (task.holder !== manager.name) throw new HttpError(403, `${manager.name} does not hold ${task.id}`);
            assignment = store.upsertAgentAssignment({
              id: body.session.assignmentId, kind: 'subagent', parentId: manager.name, manager: manager.name,
              taskId: task.id, role: match[2], status: 'running', model: body.session.model,
            });
          }
          if (assignment.manager !== manager.name) throw new HttpError(403, `${manager.name} does not own ${assignment.id}`);
          if (body.operation === 'start') return send(200, { session: store.startAgentSession(body.session) });
          if (body.operation === 'finish') return send(200, { session: store.finishAgentSession(body.session.id, body.session) });
          return send(200, { session: store.getAgentSession(body.session.id) });
        }
        if (req.method === 'POST' && parts[2] === 'agent-events' && parts.length === 4) {
          const body = checked('api/agent-events.request', await readJson(req));
          if (body.events.some((event) => event.manager !== manager.name)) throw new HttpError(403, 'event manager does not match token');
          return send(200, store.appendAgentEvents(parts[3], body.events));
        }
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/dashboard') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': DASHBOARD_CSP, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end(req.method === 'HEAD' ? undefined : DASHBOARD_HTML);
      }

      if (req.method === 'POST' && url.pathname === '/managers/heartbeat') {
        const manager = auth(req);
        const body = checked('api/heartbeat.request', await readJson(req));
        if (body.manager !== manager.name) throw new HttpError(403, 'body manager does not match token');
        const beat = { member: manager.member, at: clock.now(), agent: body.agent, version: body.version, freeSlots: body.freeSlots, running: body.running };
        store.recordHeartbeat({ name: manager.name, ...beat });
        store.upsertAgentAssignment({
          id: manager.name, kind: 'manager', parentId: 'orchestrator', manager: manager.name,
          taskId: null, role: null, status: 'running',
        });
        heartbeats.set(manager.name, beat);
        store.renewLeases({ manager: manager.name, ids: Array.isArray(body.running) ? body.running : [] });
        return send(200, { ok: true });
      }

      if (req.method === 'POST' && url.pathname === '/tasks/lease') {
        const manager = auth(req);
        const body = checked('api/lease.request', await readJson(req));
        if (body.manager !== manager.name) throw new HttpError(403, 'body manager does not match token');
        assertLeaseRights(manager, body.department);
        // Kill switch (ARCHITECTURE 44, risk 5): no task, fix or new lease. Old managers read `tasks` only.
        if (guard?.isPaused()) return send(200, { tasks: [], paused: `swarm paused: ${guard.status().reason ?? 'no reason given'}` });
        // Department or manager paused from the dashboard: no task, no fix.
        const blocked = leaseBlock(store, { manager: manager.name, department: body.department });
        if (blocked) return send(200, { tasks: [], paused: blocked });
        const fixes = store.leaseFixes({ department: body.department, manager: manager.name });
        const room = body.slots - fixes.length;
        // Rate limit (risk 6): a manager at its open-PR cap gets its fixes but no new task, until a PR merges.
        const cap = policy.limits.maxOpenPrsPerManager ?? DEFAULT_MAX_OPEN_PRS;
        if (room > 0 && openPrsOf(store.listTasks(), manager.name) >= cap) {
          return send(200, { tasks: fixes, limited: `manager has ${cap} open PRs (limits.maxOpenPrsPerManager); no new task until one merges` });
        }
        const queued = room > 0
          ? store.lease({ department: body.department, slots: room, manager: manager.name, idempotencyKey: req.headers['idempotency-key'] })
          : [];
        return send(200, { tasks: [...fixes, ...queued] });
      }

      if (req.method === 'GET' && parts[0] === 'departments' && parts[2] === 'queue' && parts.length === 3) {
        auth(req);
        if (!departments.departments[parts[1]]) throw new HttpError(404, `unknown department ${parts[1]}`);
        return send(200, { tasks: store.queueOf(parts[1]) });
      }

      if (parts[0] === 'tasks' && parts.length === 2 && req.method === 'GET') {
        auth(req);
        return send(200, { task: store.getTask(parts[1]) });
      }

      // Operator controls (ARCHITECTURE 48). Every action needs a reason and is announced on swarm.
      // Owner administration (ARCHITECTURE 51): jobs, tokens, plan, intake, backup.
      if (parts[0] === 'operator' && (parts[1] === 'jobs' || parts[1] === 'tokens' || parts[1] === 'intake' || parts[1] === 'backup' || (parts[1] === 'epics' && parts[3] === 'plan'))) {
        const who = auth(req, ['owner']);
        const body = req.method === 'POST' ? await readJson(req) : {};
        const announce = (text) => bus?.send(SWARM_CHANNEL, `operator ${text}`.replace(/\s+/g, ' ').slice(0, 400));
        const reason = reasonOf(body);
        const needReason = () => { if (!reason) throw new HttpError(400, 'a reason of at least 3 characters is required'); };
        const run = (kind, fn) => {
          try {
            return send(202, { job: jobs.start(kind, fn) });
          } catch (err) {
            throw new HttpError(err.status ?? 500, err.message);
          }
        };
        const guarded = (fn) => {
          try {
            return fn();
          } catch (err) {
            throw new HttpError(err.status ?? 500, err.message);
          }
        };
        if (req.method === 'GET' && parts[1] === 'jobs' && parts.length === 3) {
          const job = jobs.get(parts[2]);
          if (!job) throw new HttpError(404, 'unknown job');
          return send(200, { job });
        }
        if (req.method === 'GET' && parts[1] === 'tokens' && parts.length === 2) return send(200, { tokens: listTokens(tokensFile) });
        if (req.method === 'POST' && parts[1] === 'tokens' && parts.length === 2) {
          needReason();
          const raw = guarded(() => createToken(tokensFile, body, Object.keys(departments.departments)));
          announce(`token add ${body.name} (${body.role ?? 'manager'}, ${body.member}) by ${who.name}: ${reason}`);
          return send(201, { name: body.name, token: raw });
        }
        if (req.method === 'POST' && parts[1] === 'tokens' && parts[3] === 'revoke' && parts.length === 4) {
          needReason();
          guarded(() => revokeToken(tokensFile, parts[2]));
          announce(`token revoke ${parts[2]} by ${who.name}: ${reason}`);
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && parts[1] === 'epics' && parts.length === 4) {
          try { store.getEpic(parts[2]); } catch { throw new HttpError(404, `unknown epic ${parts[2]}`); }
          if (!ops.plan) throw new HttpError(501, 'planning is off: start the orchestrator with --plan-cmd');
          const dryRun = body.dryRun !== false;
          if (!dryRun) {
            needReason();
            announce(`plan ${parts[2]} by ${who.name}: ${reason}`);
          }
          return run(`plan:${parts[2]}`, () => ops.plan(parts[2], { dryRun }));
        }
        if (req.method === 'POST' && parts[1] === 'intake' && parts.length === 2) {
          if (!ops.intakeOnce) throw new HttpError(501, 'intake is not available on this orchestrator');
          announce(`intake run by ${who.name}${reason ? `: ${reason}` : ''}`);
          return run('intake', () => ops.intakeOnce());
        }
        if (req.method === 'POST' && parts[1] === 'backup' && parts.length === 2) {
          if (!ops.backup) throw new HttpError(501, 'backup is not available on this orchestrator');
          const file = guarded(() => ops.backup());
          announce(`backup by ${who.name}: ${file}`);
          return send(200, { file });
        }
        throw new HttpError(404, 'unknown admin action');
      }

      if (req.method === 'POST' && parts[0] === 'operator') {
        const who = auth(req, ['manager', 'owner']);
        const body = await readJson(req);
        const announce = (text) => bus?.send(SWARM_CHANNEL, `operator ${text} by ${who.name}`.replace(/\s+/g, ' ').slice(0, 400));
        if (parts[1] === 'epics' && parts.length === 2) {
          const epic = createEpic(checked('api/epic.request', { repo: departments.repo, title: body.title, body: body.body ?? '' }));
          announce(`epic ${epic.id} "${epic.title}"`);
          return send(201, { epic });
        }
        const reason = reasonOf(body);
        if (!reason) throw new HttpError(400, 'a reason of at least 3 characters is required');
        const tokens = readTokens(tokensFile);
        if (parts[1] === 'tasks' && parts.length === 4) {
          const [, , id, action] = parts;
          if (action === 'amend') {
            // Owner only: new paths widen what an agent may change (ARCHITECTURE 63).
            if (!who.roles.includes('owner')) throw new HttpError(403, 'only the owner may amend a task');
            let task;
            try { task = store.getTask(id); } catch { throw new HttpError(404, `unknown task ${id}`); }
            const changes = amendChanges(body, task, departments);
            try {
              const out = store.amend(id, changes, `${reason} (by ${who.name})`);
              announce(`amend ${id}: ${reason}`);
              return send(200, { task: out });
            } catch (err) {
              throw new HttpError(409, err.message);
            }
          }
          if (!OPERATOR_ACTIONS.includes(action)) throw new HttpError(404, `unknown action ${action}`);
          let task;
          try { task = store.getTask(id); } catch { throw new HttpError(404, `unknown task ${id}`); }
          if (!canActOnTask(who, task, tokens)) throw new HttpError(403, `${who.name} may not ${action} ${id} (held by ${task.holder ?? 'nobody'})`);
          try {
            return send(200, { task: await applyAndAnnounce(store, bus, { action, id, reason: `${reason} (by ${who.name})` }, { log }) });
          } catch (err) {
            throw new HttpError(409, err.message);
          }
        }
        if ((parts[1] === 'pause' || parts[1] === 'resume') && parts.length === 2) {
          if (!who.roles.includes('owner')) throw new HttpError(403, 'only the owner may pause or resume the whole swarm');
          if (!bus) throw new HttpError(503, 'no bus: the global pause lives in bus state');
          if (parts[1] === 'pause') await setPause(bus, { reason, by: who.name });
          else await clearPause(bus, { by: who.name });
          announce(`${parts[1]} swarm: ${reason}`);
          return send(200, { ok: true });
        }
        if ((parts[1] === 'departments' || parts[1] === 'managers') && parts.length === 4 && (parts[3] === 'pause' || parts[3] === 'resume')) {
          const [, kind, name, op] = parts;
          if (kind === 'departments') {
            if (!departments.departments[name]) throw new HttpError(404, `unknown department ${name}`);
            if (!who.roles.includes('owner')) throw new HttpError(403, 'only the owner may pause a department');
          } else {
            if (!tokens.managers?.[name]?.roles?.includes('manager')) throw new HttpError(404, `unknown manager ${name}`);
            if (!canActOnManager(who, name, tokens)) throw new HttpError(403, `${who.name} may not ${op} ${name}`);
          }
          const pauses = writePause(store, kind, name, op === 'pause' ? { reason, by: who.name, at: new Date(clock.now()).toISOString() } : null);
          announce(`${op} ${kind === 'departments' ? 'department' : 'manager'} ${name}: ${reason}`);
          return send(200, { pauses });
        }
        throw new HttpError(404, 'unknown operator action');
      }

      if (parts[0] === 'tasks' && parts.length === 3 && req.method === 'POST') {
        const id = parts[1];
        const action = parts[2];
        const manager = auth(req);
        const key = req.headers['idempotency-key'];
        const schemas = { progress: 'api/progress.request', submit: 'api/submit.request', fail: 'api/fail.request', release: 'api/release.request' };
        if (!schemas[action]) throw new HttpError(404, `unknown action ${action}`);
        const body = checked(schemas[action], await readJson(req));
        if (body.manager !== manager.name) throw new HttpError(403, 'body manager does not match token');
        if (action === 'progress') return send(200, { task: store.progress({ id, manager: manager.name, phase: body.phase, note: body.note, tokens: body.tokens, idempotencyKey: key }) });
        if (action === 'submit') return send(200, { task: store.submit({ id, manager: manager.name, pr: body.pr, headSha: body.headSha, evidence: body.evidence, idempotencyKey: key }) });
        if (action === 'fail') return send(200, { task: store.fail({ id, manager: manager.name, reason: body.reason }) });
        return send(200, { task: store.release({ id, manager: manager.name, reason: body.reason }) });
      }

      if (req.method === 'POST' && url.pathname === '/epics') {
        auth(req, ['intake']);
        const body = checked('api/epic.request', await readJson(req));
        return send(201, { epic: createEpic(body) });
      }

      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          throw new HttpError(405, 'the MCP endpoint takes POST');
        }
        const manager = auth(req, ['manager', 'intake']);
        let message;
        try {
          message = await readJson(req);
        } catch (err) {
          if (err instanceof HttpError && err.status === 400) return send(400, { jsonrpc: '2.0', id: null, error: { code: RPC.parse, message: 'parse error' } });
          throw err;
        }
        const reply = mcp.handle(message, manager);
        if (reply === null) { res.writeHead(202); return res.end(); }
        return send(200, reply);
      }

      throw new HttpError(404, 'no such route');
    } catch (err) {
      const e = storeError(err);
      if (e.status === 500) log.error?.(`[api] ${err.stack ?? err}`);
      // Error responses may leave the request body unread: drain it and close.
      res.setHeader('connection', 'close');
      req.resume();
      send(e.status, { error: e.message, ...(err?.assignmentId ? { assignmentId: err.assignmentId } : {}) });
    }
  }

  return { handle, heartbeats };
}

/** Builds an HTTP server. Refuses to bind every interface. */
export function createServer(opts) {
  const api = createApi(opts);
  const server = createHttpServer((req, res) => api.handle(req, res));
  return { server, heartbeats: api.heartbeats };
}

export async function listen(server, { host, port }) {
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    throw new Error(`refusing to bind all interfaces (${host}); use the Tailscale IP`);
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address()));
  });
}
