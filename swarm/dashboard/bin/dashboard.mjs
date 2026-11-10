#!/usr/bin/env node
// Server dashboard: `node dashboard/bin/dashboard.mjs`. Settings from the environment
// (deploy/env/dashboard.env.example); the dashboard token is read from a mode-0600 file.
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Bus } from '../../shared/bus.mjs';
import { resolveOrchestrator } from '../../shared/locate.mjs';
import { createDashboard } from '../src/server.mjs';
import { createAgentBridge, createAgentCache } from '../src/agent-cache.mjs';

const env = process.env;
const usersFile = env.DASH_USERS_FILE ?? path.join(os.homedir(), '.swarm', 'dashboard-users.json');

// User admin: dashboard user add <name> --token-file <file> | passwd <name> | remove <name> | list. The password is read
// from stdin (typed without echo on a terminal, or piped), never from a flag.
if (process.argv[2] === 'user') {
  const { listUsers, removeUser, setPassword, setUser } = await import('../src/users.mjs');
  const [, , , cmd, name] = process.argv;
  const flag = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
  const readPassword = async () => {
    if (!process.stdin.isTTY) return (await new Promise((r) => { let d = ''; process.stdin.on('data', (c) => { d += c; }); process.stdin.on('end', () => r(d)); })).split('\n')[0];
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (!/password/i.test(s)) return; rl.output.write(s); };
    const pw = await new Promise((r) => rl.question('password: ', r));
    rl.close();
    process.stdout.write('\n');
    return pw;
  };
  if (cmd === 'add' && name) {
    const tokenFile = flag('--token-file');
    if (!tokenFile) throw new Error('usage: dashboard user add <name> --token-file <file with the member\'s orchestrator token>');
    setUser(usersFile, { name, password: await readPassword(), token: readFileSync(tokenFile, 'utf8').trim() });
    console.log(`user ${name} saved in ${usersFile}`);
  } else if (cmd === 'passwd' && name) {
    setPassword(usersFile, name, await readPassword());
    console.log(`password of ${name} changed (token kept)`);
  } else if (cmd === 'remove' && name) {
    removeUser(usersFile, name);
    console.log(`user ${name} removed`);
  } else if (cmd === 'list') {
    for (const u of listUsers(usersFile)) console.log(`${u.name}\t${u.updatedAt ?? '-'}`);
  } else {
    console.log('usage: dashboard user add <name> --token-file <file> | user passwd <name> | user remove <name> | user list');
    process.exitCode = 2;
  }
  process.exit();
}
const host = env.DASH_HOST ?? '127.0.0.1';
const port = Number(env.DASH_PORT ?? 3424);
const orchUrl = env.SWARM_ORCH_URL ?? 'bus';
const tokenFile = env.DASH_TOKEN_FILE;
const tokenName = env.DASH_TOKEN_NAME ?? 'server-dashboard';
const pollMs = Number(env.DASH_POLL_SECONDS ?? 15) * 1000;

if (!tokenFile) throw new Error('DASH_TOKEN_FILE is not set (see deploy/env/dashboard.env.example)');
const mode = statSync(tokenFile).mode & 0o777;
if (mode & 0o077) throw new Error(`${tokenFile} must not be readable by others (mode ${mode.toString(8)}, want 600)`);
const token = readFileSync(tokenFile, 'utf8').trim();
const bus = env.SWARM_BUS_MCP_URL ? new Bus(env.SWARM_BUS_MCP_URL, 'swarm-dashboard', console, ['swarm']) : null;

// url "bus": follow the published location, verified with /whoami so the token only goes to the real orchestrator.
const resolveUrl = orchUrl === 'bus'
  ? () => (bus ? resolveOrchestrator(bus, { manager: tokenName, token }) : Promise.resolve(null))
  : () => Promise.resolve(orchUrl.replace(/\/$/, ''));

const watchdogFile = env.DASH_WATCHDOG_FILE ?? path.join(os.homedir(), '.swarm', 'watchdog.json');
const busHealthUrl = env.SWARM_BUS_MCP_URL ? env.SWARM_BUS_MCP_URL.replace(/\/mcp$/, '/health') : null;
const snapshotFile = env.DASH_SNAPSHOT_FILE ?? path.join(os.homedir(), '.swarm', 'dashboard-snapshot.json');
const sessionsFile = env.DASH_SESSIONS_FILE ?? path.join(os.homedir(), '.swarm', 'dashboard-sessions.json');
const chatDir = env.DASH_CHAT_DIR ?? path.join(os.homedir(), '.swarm', 'dashboard-chat');
const maintenanceFile = env.DASH_MAINTENANCE_FILE ?? path.join(os.homedir(), '.swarm', 'dashboard-maintenance.json');
const agentCockpit = env.SWARM_AGENT_COCKPIT === '1';
const agentCache = agentCockpit ? createAgentCache({ file: env.DASH_AGENT_CACHE_FILE ?? path.join(os.homedir(), '.swarm', 'dashboard-agents.json') }) : null;
const agentBridge = agentCockpit ? createAgentBridge({ resolveUrl, serviceToken: token, cache: agentCache, log: console }) : null;
if (agentBridge) agentBridge.start().catch((error) => console.error(`[agents] bridge stopped: ${error.message}`));
const dash = createDashboard({ resolveUrl, token, bus, watchdogFile, busHealthUrl, usersFile, snapshotFile, sessionsFile, chatDir, maintenanceFile, agentCockpit, agentBridge });
await dash.poll();
setInterval(() => dash.poll().catch((err) => console.error(`[dashboard] poll failed: ${err.message}`)), pollMs).unref();
dash.server.listen(port, host, () => console.log(`dashboard on http://${host}:${port} (orchestrator: ${orchUrl}, poll ${pollMs / 1000}s)`));
// Close the bus session on stop: the bridge keeps an abandoned session (and its name) for up to 30 min.
const stop = async () => { agentBridge?.stop(); dash.server.close(); await bus?.close().catch(() => {}); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
