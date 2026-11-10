// Runs one job in a throwaway Docker container (autopilot/sandbox). The only
// things that reach the container are the job directory (prompt, MCP config,
// optional Codex auth copy) and an env file with the member's tokens.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SANDBOX_DIR = path.join(ROOT, 'sandbox');
export const IMAGE = 'autopilot-sandbox:1';

/** Single-pass {{name}} substitution, so values containing "{{x}}" stay literal. */
export function renderPrompt(kind, vars) {
  const template = fs.readFileSync(path.join(ROOT, 'prompts', `${kind}.md`), 'utf8');
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? String(vars[key]) : m));
}

export const agentName = (config, kind) => `${config.member.toLowerCase()}-${config.agent}-${kind}`;

/** Model id for a job kind, or '' to let the agent pick its default. */
export const modelFor = (config, kind) => config.models?.[kind] ?? '';

/** Writes the job directory and the 0600 env file. Returns their paths. */
export function prepareJob(job, config, prompt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-job-'));
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { 'agent-comm': { type: 'http', url: config.busMcpUrl } } }, null, 2),
  );
  if (config.agent === 'codex') fs.copyFileSync(config.codexAuthFile, path.join(dir, 'codex-auth.json'));
  if (config.agent === 'gemini') fs.copyFileSync(config.geminiAuthFile, path.join(dir, 'gemini-auth.json'));
  // The container user (uid 1001) must read the job files.
  for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644);
  fs.chmodSync(dir, 0o755);

  const env = {
    REPO: config.repo,
    MEMBER: config.member,
    AGENT: config.agent,
    JOB_KIND: job.kind,
    MODEL: modelFor(config, job.kind),
    PR: job.pr ?? '',
    BUS_MCP_URL: config.busMcpUrl,
    GH_TOKEN: readSecret(config.githubTokenFile),
  };
  if (config.agent === 'claude') env.CLAUDE_CODE_OAUTH_TOKEN = readSecret(config.claudeTokenFile);
  const envFile = path.join(os.tmpdir(), `autopilot-env-${path.basename(dir)}`);
  fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  return { dir, envFile };
}

function readSecret(file) {
  const value = fs.readFileSync(file, 'utf8').trim();
  if (!value || value.includes('\n')) throw new Error(`secret file ${file} must hold exactly one line`);
  return value;
}

export function buildDockerArgs({ name, dir, envFile, image = IMAGE, memory = '4g', cpus = '2' }) {
  return [
    'run', '--rm', '--name', name,
    '--memory', memory, '--cpus', cpus, '--pids-limit', '1024',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--env-file', envFile,
    '-v', `${dir}:/job:ro`,
    image,
  ];
}

/**
 * Runs the container, streaming its output to `logFile`. Kills it after
 * `timeoutMs`. `spawnFn` is injectable for tests.
 */
export function runContainer(args, { name, logFile, timeoutMs, spawnFn = spawn }) {
  return new Promise((resolve) => {
    const log = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawnFn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log.write(`\n[autopilot] time limit reached, stopping ${name}\n`);
      spawnFn('docker', ['kill', name], { stdio: 'ignore' });
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ ok: code === 0 && !timedOut, code, timedOut });
    });
  });
}

/** Full job: render prompt, prepare files, run container, clean up secrets. */
export async function runJob(job, config, vars, { logFile, spawnFn } = {}) {
  const prompt = renderPrompt(job.kind, { ...vars, member: config.member, repo: config.repo, agentName: agentName(config, job.kind) });
  const { dir, envFile } = prepareJob(job, config, prompt);
  const name = `autopilot-${job.kind}-${job.pr ?? job.issue}-${Date.now()}`;
  try {
    return await runContainer(buildDockerArgs({ name, dir, envFile, image: config.image }), {
      name,
      logFile,
      timeoutMs: config.maxMinutesPerJob * 60_000,
      spawnFn,
    });
  } finally {
    fs.rmSync(envFile, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
