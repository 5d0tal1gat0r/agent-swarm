// Laptop-local worker config (never committed): ~/.config/autopilot/config.json

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_PATH = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'autopilot',
  'config.json',
);
export const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  'autopilot',
);

/**
 * Model per agent and job kind (build, review, fix). Defaults keep routine
 * work on mid-tier and small models so the account's usage lasts longer.
 * `null` means the agent's own default. Codex has no default: its model ids
 * are the user's choice (see autopilot/README.md, "Models").
 */
export const DEFAULT_MODELS = {
  claude: { build: 'claude-sonnet-5-5', review: 'claude-sonnet-5-5', fix: 'claude-haiku-5-5' },
  gemini: { build: 'gemini-3-flash-preview', review: 'gemini-3-flash-preview', fix: 'gemini-2.5-flash-lite' },
  codex: {},
};
export const AGENTS = Object.keys(DEFAULT_MODELS);
export const MODEL_KINDS = ['build', 'review', 'fix'];

export const DEFAULTS = {
  repo: 'example-org/agent-coordination',
  agent: 'claude',
  busMcpUrl: 'http://127.0.0.1:3422/mcp',
  image: 'autopilot-sandbox:1',
  maxJobsPerDay: 20,
  maxMinutesPerJob: 45,
  pollSeconds: 60,
  models: {},
};

export function template(member) {
  const dir = path.dirname(CONFIG_PATH);
  return {
    member,
    agent: 'claude',
    githubTokenFile: path.join(dir, 'github-token'),
    claudeTokenFile: path.join(dir, 'claude-token'),
    codexAuthFile: path.join(os.homedir(), '.codex', 'auth.json'),
    geminiAuthFile: path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    maxJobsPerDay: DEFAULTS.maxJobsPerDay,
    maxMinutesPerJob: DEFAULTS.maxMinutesPerJob,
  };
}

/**
 * Models for one agent: the defaults, overridden by `models.<agent>` in the
 * user's config. Returns { kind: modelId | null }.
 */
export function resolveModels(agent, userModels = {}) {
  return { ...(DEFAULT_MODELS[agent] ?? {}), ...(userModels[agent] ?? {}) };
}

/** Loads and validates the config. Throws with a readable message. */
export function loadConfig(file = CONFIG_PATH) {
  if (!fs.existsSync(file)) throw new Error(`no config at ${file}; run: autopilot init <your-github-login>`);
  const user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = { ...DEFAULTS, ...user };
  const problems = [];
  if (!config.member) problems.push('member (your GitHub login) is missing');
  if (!AGENTS.includes(config.agent)) problems.push(`agent must be one of: ${AGENTS.join(', ')}`);
  const userModels = config.models ?? {};
  if (typeof userModels !== 'object' || Array.isArray(userModels)) problems.push('models must be an object');
  else {
    for (const [agent, kinds] of Object.entries(userModels)) {
      if (!AGENTS.includes(agent)) problems.push(`models.${agent} is not a known agent`);
      else if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) problems.push(`models.${agent} must be an object`);
      else {
        for (const kind of Object.keys(kinds)) {
          if (!MODEL_KINDS.includes(kind)) problems.push(`models.${agent}.${kind} is not a job kind (use: ${MODEL_KINDS.join(', ')})`);
        }
      }
    }
  }
  config.models = resolveModels(config.agent, typeof userModels === 'object' ? userModels : {});
  for (const [kind, model] of Object.entries(config.models)) {
    // Must start with a letter or digit: a leading dash would pass as a CLI flag.
    if (model !== null && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model))) {
      problems.push(`models.${config.agent}.${kind} is not a model id: ${JSON.stringify(model)}`);
    }
  }
  if (!config.githubTokenFile || !fs.existsSync(config.githubTokenFile)) problems.push(`githubTokenFile not found: ${config.githubTokenFile}`);
  if (config.agent === 'claude' && !fs.existsSync(config.claudeTokenFile ?? '')) problems.push(`claudeTokenFile not found: ${config.claudeTokenFile}`);
  if (config.agent === 'codex' && !fs.existsSync(config.codexAuthFile ?? '')) problems.push(`codexAuthFile not found: ${config.codexAuthFile}`);
  if (config.agent === 'gemini' && !fs.existsSync(config.geminiAuthFile ?? '')) problems.push(`geminiAuthFile not found: ${config.geminiAuthFile}`);
  if (problems.length) throw new Error(`config ${file}:\n  - ${problems.join('\n  - ')}`);
  return config;
}
