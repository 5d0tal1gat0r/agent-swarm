#!/usr/bin/env node
// Department manager CLI: init | doctor | once [--dry-run] | run
import { execFile } from 'node:child_process';
import { accessSync, constants, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_FILE, readConfig, writeConfig } from '../src/config.mjs';
import { OrchestratorClient } from '../src/client.mjs';
import { createDaemon } from '../src/daemon.mjs';
import { commandAgent, commandChecks } from '../src/agents.mjs';
import { markStopping, runTask } from '../src/task-runner.mjs';
import { cleanupFinishedWorktrees } from '../src/worktree.mjs';
import { ghOpenPr } from '../src/pr.mjs';
import { assertLadder, ladderFor } from '../src/ladder.mjs';
import { subagentAgent } from '../src/subagents.mjs';
import { revertAgent, revertShaOf } from '../src/revert-agent.mjs';
import { installAgents } from '../src/agents-install.mjs';
import { loadDepartments, loadPolicy } from '../../orchestrator/src/config.mjs';
import { Bus } from '../../shared/bus.mjs';
import { createWaker } from '../src/wake.mjs';
import { resolveOrchestrator } from '../../shared/locate.mjs';
import { lintSpecs, readSpec } from '../src/specs.mjs';
import { createDirectiveJournal } from '../src/directives.mjs';
import { createAgentEventNormalizer, createAgentEventSpool } from '../src/agent-events.mjs';

const run = promisify(execFile);
const VERSION = '0.1.0';
const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (!args[i].startsWith('--')) continue;
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) flags[args[i].slice(2)] = true;
    else { flags[args[i].slice(2)] = next; i += 1; }
  }
  return flags;
}

function repoPolicy(cfg) {
  return loadPolicy(path.join(cfg.repoDir, 'swarm', 'policy.yaml'));
}

// Each of the manager's departments keeps its own `concurrency` cap from departments.yaml.
function departmentConcurrency(cfg) {
  const doc = loadDepartments(path.join(cfg.repoDir, 'swarm', 'departments.yaml'));
  const caps = {};
  for (const id of cfg.departments) {
    if (!doc.departments[id]) throw new Error(`unknown department ${id} (not in departments.yaml)`);
    caps[id] = doc.departments[id].concurrency;
  }
  return caps;
}

// url "bus": the orchestrator's address comes from bus shared state, verified by /whoami
// (ARCHITECTURE 43), so the orchestrator can move to another machine without touching managers.
async function orchestratorUrl(cfg, bus) {
  if (cfg.url !== 'bus') return cfg.url;
  if (!cfg.busUrl) throw new Error('url "bus" needs a bus URL (manager init --bus-url)');
  // A one-off lookup (doctor, once) gets its own name and closes its session, so it never holds the manager's name.
  const own = bus ?? new Bus(cfg.busUrl, `${cfg.name}-lookup`, console);
  const url = await resolveOrchestrator(own, { manager: cfg.name, token: cfg.token }).finally(() => (bus ? null : own.close().catch(() => {})));
  if (!url) throw new Error('no verified orchestrator location on the bus (is the orchestrator running?)');
  return url;
}

function buildDaemon(cfg) {
  const client = new OrchestratorClient({ url: cfg.url, token: cfg.token });
  const directiveJournal = createDirectiveJournal({
    file: path.join(cfg.stateDir, 'agent-directives.json'), manager: cfg.name, client,
  });
  const eventSpool = createAgentEventSpool({
    dir: path.join(cfg.stateDir, 'agent-events'),
    sendBatch: (events) => client.agentEvents(cfg.name, events[0].sessionId, events),
  });
  let eventFlush = null;
  const eventNormalizer = (identity) => createAgentEventNormalizer({
    ...identity, manager: cfg.name,
    emit: (event) => {
      eventSpool.append(event);
      if (!eventFlush) {
        eventFlush = Promise.resolve().then(() => eventSpool.flush())
          .catch((error) => console.warn(`[telemetry] flush failed: ${error.message}`))
          .finally(() => { eventFlush = null; });
      }
    },
  });
  const policy = repoPolicy(cfg);
  const ladder = assertLadder(ladderFor(cfg.agent, cfg.ladder), policy.models[cfg.agent]);
  const caps = departmentConcurrency(cfg);
  const concurrency = Math.min(cfg.concurrency ?? 1, Object.values(caps).reduce((a, b) => a + b, 0));
  // The spec handed to subagents is the one of the task's own department.
  const subagentFor = new Map();
  const agentFor = (department) => {
    if (!subagentFor.has(department)) {
      subagentFor.set(department, subagentAgent({
        kind: cfg.agent, allowedModels: policy.models, agentsDir: path.join(cfg.repoDir, 'swarm', 'agents'),
        runtime: cfg.subagentRuntime, image: cfg.subagentImage ?? 'swarm-subagent:1', containerRuntime: cfg.containerRuntime ?? 'podman',
        authFiles: cfg.subagentAuth ?? null, allowHostAgents: cfg.subagentRuntime === 'host',
        departmentSpec: readSpec(path.join(cfg.repoDir, 'swarm', 'managers'), department),
        eventNormalizer,
      }));
    }
    return subagentFor.get(department);
  };
  const agent = cfg.subagentRuntime
    ? (args) => agentFor(args.task.department)(args)
    : cfg.agentCommand ? commandAgent({
      runtime: cfg.runtime, image: cfg.image, command: cfg.agentCommand, stateDir: cfg.stateDir,
      managerName: cfg.name, uid: process.getuid?.(), gid: process.getgid?.(),
    })
    : null;
  const runOne = (task) => runTask({
    task, client, manager: cfg.name, identity: cfg.identity, stateDir: cfg.stateDir, repoDir: cfg.repoDir,
    agent: revertShaOf(task) ? revertAgent : agent, checks: commandChecks(cfg.checks), openPr: ghOpenPr, ladder,
    directiveJournal,
    sessionReporter: (body) => client.agentSession(cfg.name, body), agentKind: cfg.agent,
    log: console,
  });
  const daemon = createDaemon({
    client,
    manager: cfg.name,
    agentKind: cfg.agent,
    departments: cfg.departments,
    departmentConcurrency: caps,
    runTask: runOne,
    concurrency,
    version: VERSION,
    slotDir: path.join(os.homedir(), '.swarm', 'slots'),
    maxMachineSlots: 3,
    cleanup: ({ skip }) => cleanupFinishedWorktrees({ repoDir: cfg.repoDir, stateDir: cfg.stateDir, client, skip }),
    directiveJournal,
  });
  daemon.client = client; // run re-points it when the orchestrator moves
  return daemon;
}

function requireAgent(cfg) {
  if (!cfg.agentCommand && !cfg.subagentRuntime) throw new Error('set agentCommand (manager init --agent-command "...") before running tasks');
}

async function init(flags) {
  const required = ['url', 'name', 'member', 'department', 'token-file', 'repo-dir', 'checks'];
  const missing = required.filter((k) => !flags[k]);
  if (missing.length) throw new Error(`missing flags: ${missing.map((m) => `--${m}`).join(', ')}`);
  if (flags.url === 'bus' && !flags['bus-url']) throw new Error('--url bus needs --bus-url');
  const departments = String(flags.department).split(',').map((d) => d.trim()).filter(Boolean);
  if (departments.length === 0) throw new Error('--department needs at least one department id');
  const token = readFileSync(flags['token-file'], 'utf8').trim();
  if (!token) throw new Error(`${flags['token-file']} is empty`);
  const stateDir = flags['state-dir'] ?? path.join(os.homedir(), '.swarm', 'state');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeConfig({
    url: flags.url,
    token,
    name: flags.name,
    member: flags.member,
    agent: flags.agent ?? 'claude',
    departments,
    repoDir: path.resolve(flags['repo-dir']),
    stateDir,
    runtime: flags.runtime ?? 'docker',
    image: flags.image ?? null,
    agentCommand: flags['agent-command'] ? String(flags['agent-command']).split(' ') : null,
    pollSeconds: Number(flags.poll ?? 30),
    busUrl: flags['bus-url'] ? String(flags['bus-url']) : null,
    concurrency: Number(flags.concurrency ?? 1),
    subagentRuntime: flags['subagent-runtime'] ? String(flags['subagent-runtime']) : (flags['allow-host-agents'] === true ? 'host' : null),
    identity: { name: `swarm-${flags.name}`, email: flags['identity-email'] ?? `swarm-${flags.name}@users.noreply.github.com` },
    checks: String(flags.checks).split(' '),
  }, CONFIG_FILE);
  console.log(`wrote ${CONFIG_FILE} (mode 0600)`);
}

async function doctor() {
  const lines = [];
  const step = async (name, fn) => {
    try { lines.push(`ok    ${name}: ${await fn()}`); } catch (err) { lines.push(`FAIL  ${name}: ${err.message}`); }
  };
  let cfg = null;
  await step('config (mode 0600, complete)', async () => { cfg = readConfig(); return CONFIG_FILE; });
  if (cfg) {
    await step('git', async () => (await run('git', ['--version'])).stdout.trim());
    await step('container runtime', async () => (await run(cfg.runtime, ['--version'])).stdout.trim());
    await step('gh logged in', async () => { await run('gh', ['auth', 'status']); return 'yes'; });
    await step('repo dir is a git clone', async () => {
      await run('git', ['-C', cfg.repoDir, 'rev-parse', '--git-dir']);
      return cfg.repoDir;
    });
    for (const id of cfg.departments) {
      await step(`department spec ${id} (swarm/managers)`, async () => {
        const departments = loadDepartments(path.join(cfg.repoDir, 'swarm', 'departments.yaml'));
        if (!departments.departments[id]) throw new Error(`${id} is not in departments.yaml`);
        const mine = { departments: { [id]: departments.departments[id] } };
        const problems = lintSpecs({ managersDir: path.join(cfg.repoDir, 'swarm', 'managers'), departments: mine });
        if (problems.length) throw new Error(problems.join('; '));
        return `managers/${id}.md`;
      });
    }
    await step('state dir writable', async () => {
      mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
      accessSync(cfg.stateDir, constants.W_OK);
      return cfg.stateDir;
    });
    const client = new OrchestratorClient({ url: cfg.url === 'bus' ? 'http://unresolved' : cfg.url, token: cfg.token });
    await step('orchestrator reachable', async () => {
      if (cfg.url === 'bus') client.base = await orchestratorUrl(cfg);
      const health = await client.health();
      if (!health.ok) throw new Error('health did not return ok');
      return cfg.url === 'bus' ? `${client.base} (from the bus, verified)` : cfg.url;
    });
    for (const id of cfg.departments) {
      await step(`token accepted (queue read ${id})`, async () => `${(await client.queue(id)).length} queued in ${id}`);
    }
  }
  console.log(lines.join('\n'));
  if (lines.some((line) => line.startsWith('FAIL'))) process.exitCode = 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (cmd === 'init') return init(flags);
  if (cmd === 'doctor') return doctor();
  if (cmd === 'agents') {
    const [sub] = rest;
    if (sub !== 'install') throw new Error('usage: manager agents install [--to <dir>]');
    const cfg = readConfig();
    const to = parseFlags(rest.slice(1)).to ?? path.join(cfg.repoDir, '.claude', 'agents');
    const names = installAgents({ srcDir: path.join(cfg.repoDir, 'swarm', 'agents'), destDir: to, allowedModels: repoPolicy(cfg).models.claude });
    console.log(`installed ${names.length} agents to ${to}: ${names.join(' ')}`);
    return undefined;
  }
  if (cmd === 'once') {
    const cfg = readConfig();
    cfg.url = await orchestratorUrl(cfg);
    const daemon = buildDaemon(cfg);
    if (flags['dry-run']) {
      const [next] = await daemon.dryRun();
      console.log(next ? `would lease: ${JSON.stringify(next)}` : 'would lease: nothing (queue empty)');
      return undefined;
    }
    requireAgent(cfg);
    console.log(JSON.stringify(await daemon.runOnce()));
    return undefined;
  }
  if (cmd === 'run') {
    const cfg = readConfig();
    requireAgent(cfg);
    let stopping = false;
    // A restart (deploy, swarmctl stop) kills running subagents too; their tasks are released, not failed.
    process.on('SIGINT', () => { stopping = true; markStopping(); });
    process.on('SIGTERM', () => { stopping = true; markStopping(); });
    const bus = cfg.busUrl ? new Bus(cfg.busUrl, cfg.name, console) : null;
    const byBus = cfg.url === 'bus';
    while (byBus && !stopping) {
      try {
        cfg.url = await orchestratorUrl(cfg, bus);
        console.log(`orchestrator at ${cfg.url} (from the bus, verified)`);
        break;
      } catch (err) {
        console.error(err.message);
        await sleep(cfg.pollSeconds);
      }
    }
    const daemon = buildDaemon(cfg);
    // With a bus URL: say "ready" when idle, and wake early on the orchestrator's dispatch messages.
    const waker = bus ? createWaker({ bus, sleepMs: (ms) => new Promise((r) => setTimeout(r, ms)) }) : null;
    let wasBusy = true; // announce ready on the first idle tick
    while (!stopping) {
      try {
        const { started } = await daemon.tick();
        if (started.length > 0) {
          wasBusy = true;
          continue;
        }
        if (waker) {
          try {
            if (wasBusy && daemon.running.size === 0) await waker.ready(daemon.concurrency);
            wasBusy = daemon.running.size > 0;
            await waker.wait(cfg.pollSeconds);
          } catch (err) {
            console.error(`bus wake failed: ${err.message}`);
            await sleep(cfg.pollSeconds);
          }
        } else {
          wasBusy = daemon.running.size > 0;
          await sleep(cfg.pollSeconds);
        }
      } catch (err) {
        console.error(`tick failed: ${err.message}`);
        // No HTTP status: the orchestrator did not answer. With url "bus", look for a new location.
        if (byBus && err.status === undefined) {
          const moved = await orchestratorUrl({ ...cfg, url: 'bus' }, bus).catch(() => null);
          if (moved && moved !== daemon.client.base) {
            console.log(`orchestrator moved to ${moved}`);
            daemon.client.base = moved;
          }
        }
        await sleep(cfg.pollSeconds);
      }
    }
    await bus?.close().catch(() => {}); // free the manager's bus name for the next start
    return undefined;
  }
  console.log('usage: manager <init|doctor|once [--dry-run]|run> [flags]');
  process.exitCode = cmd ? 1 : 0;
  return undefined;
}

main().catch((err) => {
  console.error(`manager: ${err.message}`);
  process.exitCode = 1;
});
