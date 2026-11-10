// Runs one agent command in a throwaway container with one worktree mounted.
// Forked from autopilot/src/sandbox.mjs at 795a216. Differences:
//  - the worktree is mounted read-write at /work; the repo's .git is NOT mounted
//    (the host does all git writes, so the container needs no git);
//  - no GitHub token: the env file may only hold agent credentials;
//  - --user uid:gid keeps files written in /work owned by the host user;
//    podman also gets --userns=keep-id.
import { spawn } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const FORBIDDEN_ENV = ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_PAT'];

export function assertNoGithubToken(env) {
  const bad = Object.keys(env).filter((k) => FORBIDDEN_ENV.includes(k));
  if (bad.length) throw new Error(`containers must not receive GitHub tokens: ${bad.join(', ')}`);
}

/** Writes KEY=value lines, mode 0600. Values may not contain newlines. */
export function writeEnvFile(file, env) {
  assertNoGithubToken(env);
  const lines = Object.entries(env).map(([k, v]) => {
    const value = String(v);
    if (/[\r\n]/.test(value)) throw new Error(`env value for ${k} contains a newline`);
    return `${k}=${value}`;
  });
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function buildRunArgs({ runtime = 'docker', name, worktreeDir, envFile, image, uid, gid, memory = '4g', cpus = '2', jobDir = null }) {
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('sandbox needs numeric uid and gid (POSIX host)');
  if (!path.isAbsolute(worktreeDir)) throw new Error('worktree path must be absolute');
  if (!existsSync(worktreeDir) || !statSync(worktreeDir).isDirectory()) throw new Error(`no worktree at ${worktreeDir}`);
  if (path.basename(worktreeDir) === '.git' || worktreeDir.includes(`${path.sep}.git${path.sep}`)) {
    throw new Error('refusing to mount a .git directory');
  }
  const args = [
    'run', '--rm', '--name', name,
    '--memory', memory, '--cpus', cpus, '--pids-limit', '1024',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${uid}:${gid}`,
    '--env-file', envFile,
    '-v', `${worktreeDir}:/work:rw`,
    '-w', '/work',
  ];
  if (runtime === 'podman') args.splice(1, 0, '--userns=keep-id');
  if (jobDir) args.push('-v', `${jobDir}:/job:ro`);
  args.push(image);
  return args;
}

/** Runs the container, streaming output to logFile. Kills it after timeoutMs. */
export function runContainer(args, { runtime = 'docker', name, logFile, timeoutMs, spawnFn = spawn }) {
  return new Promise((resolve) => {
    mkdirSync(path.dirname(logFile), { recursive: true });
    const log = createWriteStream(logFile, { flags: 'a' });
    const child = spawnFn(runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout?.pipe(log, { end: false });
    child.stderr?.pipe(log, { end: false });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log.write(`\n[swarm] time limit reached, stopping ${name}\n`);
      spawnFn(runtime, ['kill', name], { stdio: 'ignore' });
      child.kill('SIGTERM');
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      log.end();
      resolve({ ok: code === 0 && !timedOut, code, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      log.end();
      resolve({ ok: false, code: null, timedOut: false, error: err.message });
    });
  });
}
