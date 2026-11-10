#!/usr/bin/env node
// autopilot: hands-off worker for the group's repo. See autopilot/README.md.

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CONFIG_PATH, DEFAULTS, loadConfig, template } from '../src/config.mjs';
import { GitHub } from '../src/github.mjs';
import { IMAGE, SANDBOX_DIR } from '../src/sandbox.mjs';
import { Worker } from '../src/worker.mjs';

const exec = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...args] = process.argv.slice(2);
const log = {
  info: (m) => console.log(`${new Date().toISOString()} ${m}`),
  warn: (m) => console.warn(`${new Date().toISOString()} WARN ${m}`),
  error: (m) => console.error(`${new Date().toISOString()} ERROR ${m}`),
};

const commands = {
  async init([login]) {
    if (!login) throw new Error('usage: autopilot init <your-github-login>');
    if (fs.existsSync(CONFIG_PATH)) throw new Error(`${CONFIG_PATH} already exists; edit it instead`);
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(template(login), null, 2) + '\n', { mode: 0o600 });
    console.log(`Wrote ${CONFIG_PATH}. Next: put your tokens in the files it names, then run: autopilot doctor`);
  },

  async 'build-image'() {
    const r = spawnSync('docker', ['build', '-t', IMAGE, SANDBOX_DIR], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('docker build failed');
  },

  async doctor() {
    let failed = false;
    const check = async (name, fn) => {
      try {
        const detail = await fn();
        console.log(`ok    ${name}${detail ? `: ${detail}` : ''}`);
      } catch (err) {
        failed = true;
        console.log(`FAIL  ${name}: ${String(err.stderr || err.message).trim().split('\n')[0]}`);
      }
    };
    let config;
    await check('config', async () => {
      config = loadConfig();
      return `${config.member}, agent ${config.agent}`;
    });
    if (!config) process.exit(1);
    await check('docker', async () => (await exec('docker', ['version', '--format', '{{.Server.Version}}'])).stdout.trim());
    await check('sandbox image', async () => {
      await exec('docker', ['image', 'inspect', config.image]);
      return config.image;
    });
    await check('gh login matches member', async () => {
      const login = (await exec('gh', ['api', 'user', '--jq', '.login'])).stdout.trim();
      if (login.toLowerCase() !== config.member.toLowerCase()) throw new Error(`gh is logged in as ${login}`);
      return login;
    });
    await check('member is in autopilot/members.json', async () => {
      const members = await new GitHub(config.repo).members();
      if (!members.some((m) => m.toLowerCase() === config.member.toLowerCase())) throw new Error('not listed');
    });
    await check('sandbox GitHub token can push to the repo', async () => {
      const token = fs.readFileSync(config.githubTokenFile, 'utf8').trim();
      const { stdout } = await exec('gh', ['api', `repos/${config.repo}`, '--jq', '.permissions.push'], { env: { ...process.env, GH_TOKEN: token } });
      if (stdout.trim() !== 'true') throw new Error('token has no write access to the repo');
    });
    await check('bus reachable', async () => {
      const res = await fetch(config.busMcpUrl.replace(/\/mcp$/, '/health'), { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    });
    process.exit(failed ? 1 : 0);
  },

  async once(flags) {
    const worker = new Worker(loadConfig(), { log });
    const job = await worker.cycle({ dryRun: flags.includes('--dry-run') });
    console.log(job ? JSON.stringify(job) : 'nothing to do');
    await worker.bus.close();
  },

  async run() {
    await new Worker(loadConfig(), { log }).loop();
  },

  /** Owner only: labels and the main protection rule. */
  async 'setup-repo'() {
    const repo = loadOptionalRepo();
    const gh = new GitHub(repo);
    await gh.ensureLabels();
    console.log('labels ok');
    // Auto-merge needs to be allowed on the repo; merged branches are deleted.
    await gh.exec(['api', '-X', 'PATCH', `repos/${repo}`, '-F', 'allow_auto_merge=true', '-F', 'delete_branch_on_merge=true', '--silent']);
    console.log('auto-merge allowed, merged branches deleted');
    // Everyone, the owner included, needs `approvalsRequired` approvals (policy.json) and a green `check`.
    const approvals = (await gh.policy()).approvalsRequired;
    const rule = {
      required_status_checks: { strict: false, contexts: ['check'] },
      enforce_admins: true,
      required_pull_request_reviews: { required_approving_review_count: approvals, dismiss_stale_reviews: true },
      restrictions: null,
      allow_force_pushes: false,
      allow_deletions: false,
    };
    try {
      await gh.exec(['api', '-X', 'PUT', `repos/${repo}/branches/main/protection`, '--input', '-'], { input: JSON.stringify(rule) });
      console.log(`main protection rule ok: ${approvals} approval(s) (owner included), stale approvals dismissed, check "check" required`);
    } catch (err) {
      console.log(`main protection rule NOT applied (${String(err.stderr || err.message).trim()}). Workers still enforce the rule themselves.`);
    }
  },

  /** Linux: install and start a systemd user service. */
  async 'install-service'() {
    if (os.platform() !== 'linux') throw new Error('install-service supports Linux (systemd) only; on macOS/Windows run `autopilot run` in a terminal');
    loadConfig();
    const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, 'autopilot.service'),
      `[Unit]\nDescription=Autopilot worker for ${DEFAULTS.repo}\nAfter=network-online.target\n\n[Service]\nExecStart=${process.execPath} ${path.join(ROOT, 'bin', 'autopilot.mjs')} run\nRestart=on-failure\nRestartSec=30\n\n[Install]\nWantedBy=default.target\n`,
    );
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    spawnSync('systemctl', ['--user', 'enable', '--now', 'autopilot.service'], { stdio: 'inherit' });
    console.log('Started. Logs: journalctl --user -u autopilot -f');
  },
};

function loadOptionalRepo() {
  try {
    return loadConfig().repo;
  } catch {
    return DEFAULTS.repo;
  }
}

const usage = `usage: autopilot <command>
  init <github-login>   write ~/.config/autopilot/config.json
  build-image           build the sandbox Docker image
  doctor                check everything the worker needs
  once [--dry-run]      run one cycle (dry run: only print the chosen job)
  run                   run the worker until stopped
  install-service       Linux: run the worker as a systemd user service
  setup-repo            owner: labels and the main protection rule`;

if (!commands[cmd]) {
  console.log(usage);
  process.exit(cmd ? 1 : 0);
}
commands[cmd](args).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
