#!/usr/bin/env node
// Orchestrator CLI: start | doctor | status | task | plan | intake | token add
import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { checkDepartmentModels, loadDepartments, loadPolicy } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { createServer, listen, nextEpicId } from '../src/api.mjs';
import { addManager, readTokens, tokenFileProblems } from '../src/tokens.mjs';
import { Bus } from '../../shared/bus.mjs';
import { SWARM_CHANNEL, allChannels } from '../src/events.mjs';
import { GitHub } from '../src/github.mjs';
import { OPERATOR_ACTIONS, applyAndAnnounce } from '../src/operator.mjs';
import { commitPlan, loadPlanPrompt, planEpic } from '../src/planner.mjs';
import { commandModel } from '../src/model-call.mjs';
import { createReviewLoop } from '../src/review-loop.mjs';
import { createExecutor, evaluate, formatAction, snapshotFrom } from '../src/monitor.mjs';
import { computeMetrics, dailySummary } from '../src/metrics.mjs';
import { revertMainRed } from '../src/revert.mjs';
import { REFRESH_MS, clearPause, createGuard, setPause } from '../src/guard.mjs';
import { DEFAULT_INTERVAL_MINUTES, createIntake, loadMembers, startIntakeLoop } from '../src/intake.mjs';
import { DISPATCH, startDispatcher } from '../src/dispatcher.mjs';
import { createSleepLog } from '../src/sleep.mjs';
import { REPUBLISH_MS, publishLocation } from '../../shared/locate.mjs';
import { createAgentControl } from '../src/agent-control.mjs';
import { createOperatorWorker } from '../src/operator-worker.mjs';

const SWARM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HOME = path.join(os.homedir(), '.swarm');
const DEFAULTS = {
  departments: path.join(SWARM, 'departments.yaml'),
  policy: path.join(SWARM, 'policy.yaml'),
  db: path.join(HOME, 'swarm.db'),
  tokens: path.join(HOME, 'managers.json'),
  host: process.env.SWARM_HOST ?? '127.0.0.1',
  port: Number(process.env.SWARM_PORT ?? 3423),
  members: path.resolve(SWARM, '..', 'autopilot', 'members.json'),
  busUrl: process.env.SWARM_BUS_MCP_URL ?? 'http://127.0.0.1:3422/mcp',
};

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else positional.push(a);
  }
  return { flags, positional };
}

function loadConfig(flags) {
  const departments = loadDepartments(flags.departments ?? DEFAULTS.departments);
  const policy = loadPolicy(flags.policy ?? DEFAULTS.policy);
  checkDepartmentModels(departments, policy);
  return { departments, policy };
}

function ensureHome(file) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
}

function assignmentSummaryForModel(assignment, session) {
  return {
    id: assignment.id, kind: assignment.kind, parentId: assignment.parentId, manager: assignment.manager,
    taskId: assignment.taskId, role: assignment.role, status: assignment.status,
    goal: assignment.goal ?? null, currentTask: assignment.currentTask ?? null,
    sessionSkills: assignment.sessionSkills ?? null, guardrails: assignment.guardrails ?? null,
    model: assignment.model ?? session?.model ?? null, phase: session?.phase ?? null,
    updatedAt: assignment.updatedAt,
  };
}

/** Intake wired to the real GitHub. With --plan-cmd, each new epic is planned right away. */
function buildIntake({ store, departments, policy, flags, bus = null }) {
  const membersFile = flags.members ?? DEFAULTS.members;
  // Re-read on every pass: a removed member loses access on the next pass, and a bad file skips the pass.
  const members = () => loadMembers(membersFile);
  const gh = new GitHub({ repo: departments.repo });
  const planModel = flags['plan-cmd'] ? commandModel(String(flags['plan-cmd']).split(' ')) : null;
  const planEpicNow = planModel && (async (epic) => {
    const { model, plan: planned } = await planEpic({ epic, departments, policy, callModel: planModel, promptText: loadPlanPrompt() });
    const tasks = commitPlan({ store, epic, plan: planned, policy });
    console.log(`[intake] planned ${tasks.length} tasks for ${epic.id} with ${model}`);
  });
  const announce = bus ? (text) => bus.send(SWARM_CHANNEL, `intake: ${text}`) : null;
  return createIntake({ store, gh, members, repo: departments.repo, planEpic: planEpicNow, announce, log: console });
}

function startMonitor({ store, heartbeats, bus, departments, policy, repoRoot, guard, sleep, log = console }) {
  const gh = new GitHub({ repo: departments.repo });
  const executor = createExecutor({
    store,
    emit: (a) => {
      const text = formatAction(a);
      log.log(`[monitor] ${text}`);
      if (bus) Promise.resolve().then(() => bus.send(SWARM_CHANNEL, text)).catch((err) => log.warn?.(`[monitor] ${SWARM_CHANNEL} not sent: ${err.message}`));
      if (a.type === 'alert.main_red' && a.sha) {
        revertMainRed({ store, gh, sha: a.sha, repo: departments.repo, policy })
          .then((r) => log.log(`[monitor] revert: ${JSON.stringify(r)}`))
          .catch((err) => log.error?.(`[monitor] revert failed: ${err.message}`));
      }
    },
    log,
  });
  let main = null;
  let mainAt = 0;
  let summaryDay = null;
  const tick = async () => {
    const now = Date.now();
    sleep.observe(now);
    // Once per UTC day: the daily summary to the swarm channel (the first tick only sets the day).
    const day = new Date(now).toISOString().slice(0, 10);
    if (summaryDay !== null && day !== summaryDay) {
      const text = dailySummary(computeMetrics(store.listTasks(), { now }));
      log.log(`[monitor] ${text}`);
      if (bus) Promise.resolve().then(() => bus.send(SWARM_CHANNEL, text)).catch((err) => log.warn?.(`[monitor] summary not sent: ${err.message}`));
    }
    summaryDay = day;
    if (now - mainAt > 5 * 60_000) {
      mainAt = now;
      try {
        main = await gh.mainHealth();
        guard.setMain(main);
      } catch (err) {
        log.warn?.(`[monitor] main health unavailable: ${err.message}`);
      }
    }
    let repoFiles = null;
    try {
      repoFiles = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
    } catch {
      repoFiles = null;
    }
    const snapshot = snapshotFrom({ store, heartbeats, now, maxAttempts: policy.limits.maxAttempts, departments, main, paused: guard.pause(), repoFiles, sleeps: sleep.intervals() });
    executor.apply(evaluate(snapshot), now);
  };
  const timer = setInterval(() => tick().catch((err) => log.error?.(`[monitor] tick failed: ${err.message}`)), 60_000);
  timer.unref();
}

async function start(flags) {
  const { departments, policy } = loadConfig(flags);
  const dbFile = flags.db ?? DEFAULTS.db;
  const tokensFile = flags.tokens ?? DEFAULTS.tokens;
  ensureHome(dbFile);
  const problems = tokenFileProblems(tokensFile);
  if (problems.length) throw new Error(problems.join('; '));
  const store = openStore({ path: dbFile, leaseMinutes: policy.limits.leaseMinutes, maxAttempts: policy.limits.maxAttempts, maxReviewRounds: policy.limits.maxReviewRounds });
  store.upsertAgentAssignment({
    id: 'orchestrator', kind: 'orchestrator', parentId: null, manager: null, taskId: null,
    role: null, status: 'running',
  });
  const bus = flags['no-bus'] ? null : new Bus(flags['bus-url'] ?? DEFAULTS.busUrl, 'swarm-orchestrator', console, allChannels(Object.keys(departments.departments)));
  const host = flags.host ?? DEFAULTS.host;
  const port = Number(flags.port ?? DEFAULTS.port);
  // Kill switch and main-red stop: cached flags, refreshed from bus state every few seconds (a failed read keeps the last value).
  const guard = createGuard({ bus, log: console, store, policy });
  await guard.refresh();
  setInterval(() => guard.refresh().catch((err) => console.error(`[guard] refresh failed: ${err.message}`)), REFRESH_MS).unref();
  // Owner administration from the dashboard: the API calls these.
  const startedAt = new Date().toISOString();
  let version = 'unknown';
  try { version = execFileSync('git', ['-C', SWARM, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {}
  const planCmd = flags['plan-cmd'] ? commandModel(String(flags['plan-cmd']).split(' ')) : null;
  const operatorCmd = flags['operator-cmd'] ? commandModel(String(flags['operator-cmd']).split(' ')) : null;
  const adminIntake = buildIntake({ store, departments, policy, flags, bus });
  const ops = {
    plan: planCmd && (async (epicId, { dryRun }) => {
      const epic = store.getEpic(epicId);
      const { model, plan: planned } = await planEpic({ epic, departments, policy, callModel: planCmd, promptText: loadPlanPrompt() });
      if (dryRun) return { model, written: false, tasks: planned.map((t) => ({ key: t.key, title: t.title, department: t.department, size: t.size, priority: t.priority, paths: t.paths, dependsOn: t.dependsOn })) };
      const tasks = commitPlan({ store, epic, plan: planned, policy });
      return { model, written: true, tasks: tasks.map((t) => ({ id: t.id, title: t.title, department: t.department, status: t.status })) };
    }),
    intakeOnce: async () => {
      const r = await adminIntake.intakeOnce();
      return { created: r.created.map((e) => ({ id: e.id, issue: e.issue, title: e.title })), skipped: r.skipped.length, errors: r.errors.map(String) };
    },
    backup: () => {
      const dir = path.join(path.dirname(dbFile), 'backups');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const out = path.join(dir, `manual-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
      store.backup(out);
      return out;
    },
    info: () => ({
      version, startedAt, uptimeSeconds: Math.round((Date.now() - Date.parse(startedAt)) / 1000), node: process.versions.node,
      features: { review: Boolean(flags['review-cmd']), intake: !flags['no-intake'], dispatch: !flags['no-dispatch'], planCmd: Boolean(planCmd), operatorPrompt: Boolean(operatorCmd), bus: Boolean(bus) },
    }),
  };
  ops.agentControl = createAgentControl({ store, policy, departments, tokens: readTokens(tokensFile) });
  const contextFor = (target) => {
    const assignment = target === 'orchestrator' ? store.getAgentAssignment('orchestrator') : store.getAgentAssignment(target);
    const task = assignment.taskId ? store.getTask(assignment.taskId) : null;
    return {
      model: policy.reviewModel.default,
      agent: assignmentSummaryForModel(assignment, store.latestAgentSession(assignment.id)),
      snapshot: {
        tasks: store.listTasks().map(({ history, ...item }) => item),
        epics: store.listEpics(),
        agents: store.listAgentAssignments().map((item) => assignmentSummaryForModel(item, store.latestAgentSession(item.id))),
      },
      histories: task ? store.history(task.id).slice(-20) : [],
    };
  };
  const applyOperatorAction = async (action, meta) => {
    if (action.kind === 'create_epic') {
      return store.createEpic({ id: nextEpicId(store), repo: departments.repo, title: action.payload.title, body: action.payload.body, status: 'open', source: 'human', issue: null });
    }
    if (action.kind === 'plan_epic') {
      if (!ops.plan) throw new Error('planning is disabled');
      return ops.plan(action.payload.epicId, { dryRun: action.payload.dryRun });
    }
    if (action.kind === 'replan_task') return store.replan(action.payload.taskId, `${meta.reason} (by ${meta.actor})`);
    const target = action.kind === 'prompt_subagent' ? action.payload.targetAssignmentOrStableName : action.payload.target;
    const assignment = store.getAgentAssignment(target);
    const kind = action.kind === 'request_status' ? 'status' : 'prompt';
    const payload = kind === 'prompt' ? { text: action.payload.text } : {};
    return store.createAgentDirective({
      idempotencyKey: `operator-${action.id}`, target: assignment.id, taskId: assignment.taskId,
      kind, payload, actor: meta.actor, reason: meta.reason,
    });
  };
  ops.operatorWorker = createOperatorWorker({
    store, callModel: operatorCmd, contextFor, applyAction: applyOperatorAction, log: console,
  });
  const { server, heartbeats } = createServer({ store, departments, policy, tokensFile, bus, guard, ops, log: console });
  const address = await listen(server, { host, port });
  console.log(`orchestrator listening on ${address.address}:${address.port} (db ${dbFile})`);
  if (operatorCmd) {
    const operatorTimer = setInterval(() => ops.operatorWorker.tick().catch((err) => console.error(`[operator] tick failed: ${err.message}`)), 500);
    operatorTimer.unref();
    console.log('operator conversation worker on');
  } else {
    console.log('operator conversation worker off (start with --operator-cmd "<command>" to enable)');
  }
  // Publish where this orchestrator runs, so managers and the watchdog with url "bus" find it after a move.
  if (bus) {
    const location = { url: flags['public-url'] ?? `http://${host}:${address.port}`, host: os.hostname() };
    const publish = () => publishLocation(bus, location);
    publish();
    setInterval(publish, REPUBLISH_MS).unref();
    console.log(`location ${location.url} published on the bus (swarm/orchestrator)`);
  }
  if (flags['review-cmd']) {
    const loop = createReviewLoop({
      store, gh: new GitHub({ repo: departments.repo }), callModel: commandModel(String(flags['review-cmd']).split(' ')),
      policy, departments, guard, log: console,
    });
    const every = Number(flags['review-poll'] ?? 30) * 1000;
    setInterval(() => loop.tick().catch((err) => console.error(`[review] tick failed: ${err.message}`)), every).unref();
    console.log(`review loop on, every ${every / 1000}s, repo ${departments.repo}`);
  } else {
    console.log('review loop off (start with --review-cmd "<command>" to enable)');
  }
  if (flags['no-intake']) {
    console.log('intake off (--no-intake)');
  } else {
    const intervalMinutes = Number(flags['intake-interval'] ?? policy.intake?.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES);
    if (!(intervalMinutes >= 1)) throw new Error('--intake-interval must be at least 1 (minutes)');
    startIntakeLoop({ intake: buildIntake({ store, departments, policy, flags, bus }), intervalMinutes, log: console });
    console.log(`intake on, every ${intervalMinutes} min, repo ${departments.repo}${flags['plan-cmd'] ? ', auto-plan on' : ', no auto-plan (epics stay open until "orchestrator plan")'}`);
  }
  // Sleep log (ARCHITECTURE 70): a long gap between the minute loops means the machine slept. Leases get the
  // slept time back, and the monitor leaves it out of budgets, stalls and heartbeat silence.
  const sleep = createSleepLog({
    onSleep: (ms) => console.log(`[sleep] ${Math.round(ms / 60_000)} min gap: leases extended for ${store.extendLeases(ms).join(', ') || 'none'}`),
  });
  // Monitor: every minute, evaluate the swarm and act (alerts to the swarm channel, budget stops cancel).
  startMonitor({ store, heartbeats, bus, departments, policy, repoRoot: path.resolve(SWARM, '..'), guard, sleep });
  // Dispatcher: listens for manager messages on the bus and nudges idle managers when their departments have queued work.
  if (flags['no-dispatch']) {
    console.log('dispatch off (--no-dispatch)');
  } else {
    const listenMs = Number(flags['listen-interval'] ?? DISPATCH.listenMs / 1000) * 1000;
    const dispatchMs = Number(flags['dispatch-interval'] ?? DISPATCH.dispatchMs / 1000) * 1000;
    if (!(listenMs >= 1000) || !(dispatchMs >= 10_000)) throw new Error('--listen-interval must be at least 1 and --dispatch-interval at least 10 (seconds)');
    startDispatcher({ store, heartbeats, bus, departments, readManagerTokens: () => readTokens(tokensFile), log: console, listenMs, dispatchMs, guard });
    console.log(`dispatch on, pass every ${dispatchMs / 1000}s${bus ? `, bus inbox every ${listenMs / 1000}s` : ', no bus listener (--no-bus)'}`);
  }
  // Leases of managers that stopped heartbeating expire here (attempt spent, task retried).
  const expiry = setInterval(() => {
    sleep.observe(Date.now());
    for (const id of store.expireLeases()) console.log(`[lease] expired ${id}`);
  }, 60_000);
  expiry.unref();
  // Close the bus session on stop: the bridge keeps an abandoned session (and the name swarm-orchestrator) for up to 30 min.
  const stop = async () => { server.close(); await bus?.close().catch(() => {}); store.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function doctor(flags) {
  const lines = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      lines.push(`ok    ${name}${detail ? `: ${detail}` : ''}`);
    } catch (err) {
      lines.push(`FAIL  ${name}: ${err.message}`);
    }
  };
  check('node >= 22.13', () => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 13)) throw new Error(`node ${process.versions.node}`);
    return process.versions.node;
  });
  let config;
  check('departments.yaml and policy.yaml load, models allow-listed', () => {
    config = loadConfig(flags);
    return `${Object.keys(config.departments.departments).length} departments`;
  });
  check('node:sqlite opens a store', () => {
    const s = openStore({ path: ':memory:' });
    s.close();
    return 'in-memory';
  });
  check('manager tokens file mode', () => {
    const p = tokenFileProblems(flags.tokens ?? DEFAULTS.tokens);
    if (p.length) throw new Error(p.join('; '));
    return flags.tokens ?? DEFAULTS.tokens;
  });
  check('database path writable', () => {
    const f = flags.db ?? DEFAULTS.db;
    ensureHome(f);
    const probe = new DatabaseSync(f);
    probe.close();
    return f;
  });
  if (!flags['offline']) {
    let up = false;
    try {
      up = (await fetch(String(flags['bus-url'] ?? DEFAULTS.busUrl).replace(/\/mcp$/, '/health'), { signal: AbortSignal.timeout(4000) })).ok;
    } catch {}
    lines.push(`${up ? 'ok   ' : 'warn '} bus reachable (${flags['bus-url'] ?? DEFAULTS.busUrl})`);
  }
  console.log(lines.join('\n'));
  if (lines.some((l) => l.startsWith('FAIL'))) process.exitCode = 1;
}

function status(flags) {
  const { departments } = loadConfig(flags);
  const dbFile = flags.db ?? DEFAULTS.db;
  if (!existsSync(dbFile)) {
    console.log(`no database yet at ${dbFile}`);
    return;
  }
  const store = openStore({ path: dbFile });
  const tasks = store.listTasks();
  const byStatus = {};
  for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  console.log(`tasks: ${tasks.length}`, JSON.stringify(byStatus));
  for (const id of Object.keys(departments.departments)) {
    console.log(`${id}: queued ${store.queueOf(id).length}`);
  }
  store.close();
}

function tokenAdd(flags, positional) {
  const [name] = positional;
  if (!name) throw new Error('usage: token add <name> --member <login> --departments core,runtime [--intake | --dashboard | --owner]');
  const member = flags.member;
  if (!member) throw new Error('--member <github login> is required');
  const departments = flags.departments ? String(flags.departments).split(',').filter(Boolean) : [];
  const roles = flags.intake ? ['intake'] : flags.dashboard ? ['dashboard'] : flags.owner ? ['manager', 'owner'] : ['manager'];
  const tokensFile = flags.tokens ?? DEFAULTS.tokens;
  ensureHome(tokensFile);
  const token = addManager(tokensFile, { name, member, departments, roles });
  console.log(`created ${name} (${roles.join(',')}) bound to [${departments.join(', ')}]`);
  console.log('token (shown once, store it on the manager host):');
  console.log(token);
  console.log(`tokens file: ${tokensFile} (${Object.keys(readTokens(tokensFile).managers).length} managers)`);
}

const [cmd, ...rest] = process.argv.slice(2);
const { flags, positional } = parseFlags(rest);
async function task(flags, positional) {
  const [action, id] = positional;
  if (!OPERATOR_ACTIONS.includes(action) || !id) {
    throw new Error(`usage: task <${OPERATOR_ACTIONS.join('|')}> <task id> --reason "<why>"`);
  }
  const { departments, policy } = loadConfig(flags);
  const store = openStore({ path: flags.db ?? DEFAULTS.db, leaseMinutes: policy.limits.leaseMinutes, maxAttempts: policy.limits.maxAttempts, maxReviewRounds: policy.limits.maxReviewRounds });
  // A distinct identity, so the operator's posts are not mistaken for the running orchestrator.
  const bus = flags['no-bus'] ? null : new Bus(flags['bus-url'] ?? DEFAULTS.busUrl, 'swarm-operator', console, allChannels(Object.keys(departments.departments)));
  try {
    const t = await applyAndAnnounce(store, bus, { action, id, reason: flags.reason }, { log: console });
    console.log(`${id}: ${t.status} (${action}: ${flags.reason})`);
  } finally {
    store.close();
    await bus?.close().catch(() => {});
  }
}

async function plan(flags, positional) {
  const [epicId] = positional;
  if (!epicId) throw new Error('usage: plan <epic id> [--dry-run] --plan-cmd "<command>"');
  if (!flags['plan-cmd']) throw new Error('plan needs --plan-cmd "<command>" (the model command; reads the prompt on stdin)');
  const { departments, policy } = loadConfig(flags);
  const store = openStore({ path: flags.db ?? DEFAULTS.db, leaseMinutes: policy.limits.leaseMinutes, maxAttempts: policy.limits.maxAttempts, maxReviewRounds: policy.limits.maxReviewRounds });
  try {
    const epic = store.getEpic(epicId);
    const { model, plan: planned } = await planEpic({
      epic, departments, policy, callModel: commandModel(String(flags['plan-cmd']).split(' ')), promptText: loadPlanPrompt(),
    });
    if (flags['dry-run']) {
      for (const s of planned) console.log(`${s.key}\t${s.department} ${s.kind}\t${s.size} ${s.priority}\t${s.paths.join(',')}\tafter: ${s.dependsOn.join(',') || '-'}`);
      console.log(`dry run: ${planned.length} tasks from ${model}, nothing written`);
      return;
    }
    const tasks = commitPlan({ store, epic, plan: planned, policy });
    for (const t of tasks) console.log(`${t.id}\t${t.status}\t${t.department}\t${t.title}`);
    console.log(`planned ${tasks.length} tasks for ${epic.id} with ${model}`);
  } finally {
    store.close();
  }
}

async function intake(flags) {
  if (!flags.once) throw new Error('usage: intake --once [--plan-cmd "<command>"] [--members <file>]');
  const { departments, policy } = loadConfig(flags);
  const dbFile = flags.db ?? DEFAULTS.db;
  ensureHome(dbFile);
  const store = openStore({ path: dbFile, leaseMinutes: policy.limits.leaseMinutes, maxAttempts: policy.limits.maxAttempts, maxReviewRounds: policy.limits.maxReviewRounds });
  try {
    const result = await buildIntake({ store, departments, policy, flags }).intakeOnce();
    console.log(`intake: ${result.created.length} created, ${result.skipped.length} skipped, ${result.errors.length} errors`);
    for (const e of result.created) console.log(`${e.id}\t#${e.issue}\t${e.title}`);
    if (result.errors.length) process.exitCode = 1;
  } finally {
    store.close();
  }
}

async function backup(flags) {
  const out = flags.out;
  if (!out || out === true) throw new Error('usage: backup --out <file>  (VACUUM INTO: refuses to overwrite)');
  const { policy } = loadConfig(flags);
  const store = openStore({ path: flags.db ?? DEFAULTS.db, leaseMinutes: policy.limits.leaseMinutes, maxAttempts: policy.limits.maxAttempts, maxReviewRounds: policy.limits.maxReviewRounds });
  try {
    store.backup(String(out));
    console.log(`backup written: ${out}`);
  } finally {
    store.close();
  }
}

/** pause [--reason <text>] / resume: set or clear bus state swarm/paused. The running orchestrator sees it within ~10 s. */
async function pauseResume(flags, on) {
  const { departments } = loadConfig(flags);
  const bus = new Bus(flags['bus-url'] ?? DEFAULTS.busUrl, 'swarm-operator', console, allChannels(Object.keys(departments.departments)));
  try {
    if (on) await setPause(bus, { reason: flags.reason === true ? null : flags.reason });
    else await clearPause(bus);
    console.log(on ? `swarm paused${flags.reason && flags.reason !== true ? `: ${flags.reason}` : ''}` : 'swarm resumed');
    await bus.send(SWARM_CHANNEL, on ? `PAUSED by operator: ${flags.reason && flags.reason !== true ? flags.reason : 'no reason given'}` : 'RESUMED by operator');
  } finally {
    await bus.close().catch(() => {});
  }
}

const commands = {
  pause: () => pauseResume(flags, true),
  resume: () => pauseResume(flags, false),
  backup: () => backup(flags),
  intake: () => intake(flags),
  start: () => start(flags),
  plan: () => plan(flags, positional),
  task: () => task(flags, positional),
  doctor: () => doctor(flags),
  status: () => status(flags),
  token: () => {
    if (positional[0] !== 'add') throw new Error('usage: token add <name> ...');
    return tokenAdd(flags, positional.slice(1));
  },
};
if (!commands[cmd]) {
  console.log(`usage: orchestrator <start|doctor|status|task|plan|intake|backup|pause|resume|token add> [flags]
  start    [--no-intake] [--intake-interval <min>] [--plan-cmd "<cmd>"] [--operator-cmd "<cmd>"] [--no-bus] [--review-cmd "<cmd>"]
           [--no-dispatch] [--dispatch-interval <s>] [--listen-interval <s>] [--public-url <url>] ...
  pause    [--reason "<text>"]   stop all leasing, dispatch and merging (bus state swarm/paused); resume clears it
  intake   --once [--plan-cmd "<cmd>"] [--members <file>]   epics from open issues labelled "epic" (members only)`);
  process.exit(cmd ? 1 : 0);
}
Promise.resolve(commands[cmd]()).catch((err) => {
  console.error(`orchestrator ${cmd}: ${err.message}`);
  process.exit(1);
});
