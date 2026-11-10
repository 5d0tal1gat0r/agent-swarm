// Manager config (~/.swarm/manager.json, mode 0600). The token lives here, so
// the file must not be readable by others.
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_FILE = path.join(os.homedir(), '.swarm', 'manager.json');

export function readConfig(file = CONFIG_FILE) {
  if (!existsSync(file)) throw new Error(`no manager config at ${file}; run: manager init`);
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${file} must be mode 0600 (is ${mode.toString(8)})`);
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  for (const key of ['url', 'token', 'name', 'member', 'repoDir', 'stateDir', 'identity', 'checks']) {
    if (cfg[key] === undefined) throw new Error(`manager config is missing ${key}`);
  }
  // Old configs have one `department`; new ones a `departments` list.
  if (cfg.departments === undefined && cfg.department !== undefined) cfg.departments = [cfg.department];
  delete cfg.department;
  if (!Array.isArray(cfg.departments) || cfg.departments.length === 0 || !cfg.departments.every((d) => typeof d === 'string' && d)) {
    throw new Error('manager config is missing departments (a non-empty list of department ids)');
  }
  if (!Array.isArray(cfg.checks) || cfg.checks.length === 0) throw new Error('checks must be a non-empty argument array');
  return { agent: 'claude', pollSeconds: 30, runtime: 'docker', image: null, agentCommand: null, ...cfg };
}

export function writeConfig(cfg, file = CONFIG_FILE) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}
