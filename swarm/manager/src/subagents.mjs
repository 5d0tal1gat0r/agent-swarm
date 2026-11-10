// Subagent runner for Claude, Codex, Gemini and Antigravity. One CLI process per subagent:
// argument arrays, no shell, prompt on stdin. A model id must pass the regex
// and the policy allow-list before the command is built. Codex has no model
// on the allow-list yet (owner pick), so Codex refuses to run until one is added.
//
// Host runtime only: a subagent here can read the user's home directory, so
// it runs only when the manager config sets allowHostAgents. The container
// runtime is the production path and is not built yet (ARCHITECTURE 28).
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { matchGlob, overlaps, splitGlob } from '../../shared/globs.mjs';
import { git } from './worktree.mjs';
import { parseAgentFile } from './agents-install.mjs';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { validate } from '../../protocol/validate.mjs';

export const KINDS = ['claude', 'codex', 'gemini', 'antigravity'];
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertModel(kind, model, allowedModels) {
  if (!KINDS.includes(kind)) throw new Error(`unknown agent kind: ${kind}`);
  if (typeof model !== 'string' || !MODEL_RE.test(model)) throw new Error(`malformed model id: ${JSON.stringify(model)}`);
  if (!(allowedModels[kind] ?? []).includes(model)) throw new Error(`${kind} model not on the allow-list: ${model}`);
}

/**
 * The CLI command for one subagent. Prompt goes on stdin, never in argv.
 * readOnly (planning call, ARCHITECTURE 29) swaps the write mode for the CLI's read-only mode.
 */
export function buildAgentCommand({ kind, model, worktree, readOnly = false }) {
  if (!path.isAbsolute(worktree)) throw new Error('worktree must be an absolute path');
  if (kind === 'claude') {
    return { cmd: 'claude', cwd: worktree, args: ['-p', '--model', model, '--output-format', 'json', '--permission-mode', readOnly ? 'plan' : 'acceptEdits', '--add-dir', worktree] };
  }
  if (kind === 'codex') {
    return { cmd: 'codex', cwd: worktree, args: ['exec', '-m', model, '-s', readOnly ? 'read-only' : 'workspace-write', '-C', worktree, '--skip-git-repo-check', '--ephemeral', '--json'] };
  }
  if (kind === 'gemini') {
    // --skip-trust: without it gemini overrides auto_edit to default and will not write. It also loads
    // .gemini settings from the worktree, which the repo can supply (ARCHITECTURE 28). Host runtime only.
    return { cmd: 'gemini', cwd: worktree, args: ['-m', model, '--approval-mode', readOnly ? 'plan' : 'auto_edit', '--skip-trust', '-o', 'json', '-p', 'Follow the instructions on stdin.'] };
  }
  if (kind === 'antigravity') {
    // Google's Antigravity CLI (agy), the successor of the Gemini CLI login. It reads a plain
    // prompt only from argv, so the prompt goes on stdin as one stream-json message (agentStdin).
    // Headless mode denies shell commands; accept-edits lets it write files. Host runtime only.
    return { cmd: 'agy', cwd: worktree, args: ['--model', model, '--mode', readOnly ? 'plan' : 'accept-edits', '--input-format', 'stream-json', '--output-format', 'stream-json', '-p='] };
  }
  throw new Error(`unknown agent kind: ${kind}`);
}

/** What goes on the CLI's stdin: the prompt itself, or for agy one stream-json user message. */
export function agentStdin(kind, prompt) {
  if (kind === 'antigravity') return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
  return prompt;
}

/** Where each CLI keeps its login inside the sandbox image (HOME=/home/agent). */
export const AUTH_IN_CONTAINER = {
  claude: '/home/agent/.claude/.credentials.json',
  codex: '/home/agent/.codex/auth.json',
  gemini: '/home/agent/.gemini/oauth_creds.json',
};

/** Default host locations of those logins. The manager config can override each. */
export function defaultAuthFiles(home = os.homedir()) {
  return {
    claude: path.join(home, '.claude', '.credentials.json'),
    codex: path.join(home, '.codex', 'auth.json'),
    gemini: path.join(home, '.gemini', 'oauth_creds.json'),
  };
}

/**
 * Container run args for one subagent (the command is appended by the caller).
 * Mounts: the worktree at /work (rw) and this CLI's auth file only (ro).
 * Nothing from the host environment is passed in, so no GitHub token can reach the container.
 */
export function buildSubagentRunArgs({ runtime, name, image, worktree, kind, authFile, uid, gid, memory = '2g', cpus = '2' }) {
  if (!['podman', 'docker'].includes(runtime)) throw new Error(`unknown container runtime: ${runtime}`);
  if (!path.isAbsolute(worktree)) throw new Error('worktree must be an absolute path');
  if (path.basename(worktree) === '.git' || worktree.includes(`${path.sep}.git${path.sep}`)) throw new Error('refusing to mount a .git directory');
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) throw new Error(`no worktree at ${worktree}`);
  const inside = AUTH_IN_CONTAINER[kind];
  if (!inside) throw new Error(`no sandbox auth path for ${kind}`);
  if (!authFile || !path.isAbsolute(authFile) || !existsSync(authFile) || !lstatSync(authFile).isFile()) {
    throw new Error(`auth file for ${kind} not found (set subagentAuth.${kind} in the manager config)`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(name)) throw new Error(`bad container name: ${name}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(image)) throw new Error(`bad image name: ${image}`);
  const args = [
    'run', '--rm', '-i', '--name', name,
    '--memory', memory, '--cpus', cpus, '--pids-limit', '512',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${uid}:${gid}`,
    '-v', `${worktree}:/work:rw`,
    '-v', `${authFile}:${inside}:ro`,
    '-w', '/work',
  ];
  if (runtime === 'podman') args.splice(1, 0, '--userns=keep-id');
  args.push(image);
  return args;
}

/**
 * Windows: npm installs the CLIs as .cmd shims, which spawn cannot run without
 * a shell (Node 22). Under cmd.exe, arguments split on spaces and some
 * characters are special, so refuse those and quote the rest. The prompt
 * never reaches argv, so no user text lands here.
 */
export function windowsShellArgs(args) {
  return args.map((a) => {
    if (/["%!&|<>^\r\n]/.test(a)) throw new Error(`argument not safe for cmd.exe: ${JSON.stringify(a)}`);
    return /[\s()]/.test(a) ? `"${a}"` : a;
  });
}

/** Runs one subagent to completion. Resolves with the reply text, rejects on any failure. */
export async function runSubagent({ kind, model, worktree, prompt, allowedModels, allowHostAgents = false, runtime = 'host', image = null, containerRuntime = 'podman', authFiles = null, uid = process.getuid?.(), gid = process.getgid?.(), timeoutMs = 30 * 60_000, maxBytes = 4 * 1024 * 1024, spawnFn = spawn, readOnly = false, platform = process.platform, onEvent = null, control = null }) {
  assertModel(kind, model, allowedModels);
  let cmd;
  let args;
  let cwd;
  let containerName = null;
  if (runtime === 'container') {
    if (!image) throw new Error('container runtime needs an image (subagentImage in the manager config)');
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) throw new Error('container runtime needs numeric uid and gid (POSIX host)');
    containerName =`swarm-sub-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const run = buildSubagentRunArgs({ runtime: containerRuntime, name: containerName, image, worktree, kind, authFile: (authFiles ?? defaultAuthFiles())[kind], uid, gid });
    const inner = buildAgentCommand({ kind, model, worktree: '/work', readOnly });
    cmd = containerRuntime;
    args = [...run, inner.cmd, ...inner.args];
    cwd = undefined;
  } else if (runtime === 'host') {
    if (!allowHostAgents) throw new Error('subagents run on the host only when allowHostAgents is set; use runtime container for production');
    ({ cmd, args, cwd } = buildAgentCommand({ kind, model, worktree, readOnly }));
  } else {
    throw new Error(`unknown subagent runtime: ${runtime}`);
  }
  return new Promise((resolve, reject) => {
    const notify = (method, value) => {
      try { onEvent?.[method]?.(value); } catch { /* telemetry is best effort here; its spool reports errors */ }
    };
    let finishNotified = false;
    const notifyFinish = (value) => {
      if (finishNotified) return;
      finishNotified = true;
      notify('finish', value);
    };
    const child = platform === 'win32'
      ? spawnFn(cmd, windowsShellArgs(args), { cwd, shell: true, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawnFn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let signalTimer = null;
    if (control) {
      control.children ??= new Set();
      control.children.add(child);
      control.interrupt ??= () => {
        control.interrupted = true;
        for (const process of control.children) process.kill('SIGINT');
        signalTimer ??= setTimeout(() => { for (const process of control.children) process.kill('SIGTERM'); }, 5_000);
        signalTimer.unref?.();
      };
      control.stop ??= () => {
        control.stopped = true;
        for (const process of control.children) process.kill('SIGTERM');
      };
    }
    let out = '';
    let err = '';
    let size = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (containerName) spawnFn(containerRuntime, ['rm', '-f', containerName], { stdio: 'ignore' }).on?.('error', () => {});
      notifyFinish({ code: null, interrupted: true, error: `${kind} subagent timed out` });
      reject(new Error(`${kind} subagent timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => {
      notify('stdout', chunk);
      size += chunk.length;
      if (size > maxBytes) {
        clearTimeout(timer);
        child.kill('SIGKILL');
        reject(new Error(`${kind} subagent reply too large`));
        return;
      }
      out += chunk;
    });
    child.stderr.on('data', (chunk) => { notify('stderr', chunk); err = (err + chunk).slice(-4000); }); // keep the tail: errors come last
    child.on('error', (e) => { clearTimeout(timer); notifyFinish({ code: null, error: e.message }); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (signalTimer) clearTimeout(signalTimer);
      control?.children?.delete(child);
      notifyFinish({ code, reply: out, error: code === 0 ? null : err.trim().slice(-300) });
      if (control?.interrupted || control?.stopped) reject(new Error(control.stopped ? 'SIGTERM: stop directive' : 'SIGINT: interrupt directive'));
      else if (code === 0) resolve({ kind, model, reply: out });
      else reject(new Error(`${kind} subagent exit ${code}: ${err.trim().slice(-300)}`));
    });
    child.stdin.end(agentStdin(kind, prompt));
  });
}

/**
 * Billable tokens from a Claude `--output-format json` reply: input + output +
 * cache creation. Cache reads are left out: they repeat the context each turn.
 * Returns null when the reply has no usage block (the caller decides what to do).
 */
export function claudeTokens(replyText) {
  let data;
  try {
    data = JSON.parse(replyText);
  } catch {
    return null;
  }
  const u = data?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (k) => (Number.isFinite(u[k]) ? u[k] : 0);
  return n('input_tokens') + n('output_tokens') + n('cache_creation_input_tokens');
}

/**
 * Billable tokens from a `codex exec --json` reply (JSON Lines). Each
 * `turn.completed` event carries a usage block; this sums them all as
 * (input_tokens - cached_input_tokens) + output_tokens.
 * In Codex output, cached_input_tokens is a subset of input_tokens, so it is
 * subtracted (cache reads repeat context, as with Claude). reasoning_output_tokens
 * is a subset of output_tokens, so it is not added again.
 * Returns null when no turn.completed usage block is found.
 */
export function codexTokens(replyText) {
  let total = 0;
  let found = false;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  for (const line of String(replyText ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (ev?.type !== 'turn.completed') continue;
    const u = ev.usage;
    if (!u || typeof u !== 'object') continue;
    total += Math.max(0, n(u.input_tokens) - n(u.cached_input_tokens)) + n(u.output_tokens);
    found = true;
  }
  return found ? total : null;
}

/**
 * Billable tokens from a Gemini -o json reply: input (prompt) + output (candidates)
 * across models in the stats block. Handles stats.models, stats.tokens,
 * flattened stats.input_tokens / stats.output_tokens, and usageMetadata.
 * Returns null when the reply has no stats/usage block or invalid JSON.
 */
export function geminiTokens(replyText) {
  let data;
  try {
    data = JSON.parse(replyText);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;

  const n = (k) => (Number.isFinite(k) ? k : 0);

  const stats = data.stats;
  if (stats && typeof stats === 'object') {
    if (stats.models && typeof stats.models === 'object') {
      const models = Object.values(stats.models);
      if (models.length > 0) {
        let total = 0;
        let found = false;
        for (const m of models) {
          if (m?.tokens && typeof m.tokens === 'object') {
            total += n(m.tokens.prompt ?? m.tokens.input ?? m.tokens.input_tokens) +
                     n(m.tokens.candidates ?? m.tokens.output ?? m.tokens.output_tokens);
            found = true;
          } else if (m && typeof m === 'object' && (Number.isFinite(m.input_tokens) || Number.isFinite(m.output_tokens))) {
            total += n(m.input_tokens) + n(m.output_tokens);
            found = true;
          }
        }
        if (found) return total;
      }
    }

    if (stats.tokens && typeof stats.tokens === 'object') {
      return n(stats.tokens.prompt ?? stats.tokens.input ?? stats.tokens.input_tokens) +
             n(stats.tokens.candidates ?? stats.tokens.output ?? stats.tokens.output_tokens);
    }

    if (Number.isFinite(stats.input_tokens) || Number.isFinite(stats.output_tokens)) {
      return n(stats.input_tokens) + n(stats.output_tokens);
    }

    if (Number.isFinite(stats.total_tokens)) {
      return stats.total_tokens;
    }

    return 0;
  }

  const um = data.usageMetadata ?? data.usage_metadata;
  if (um && typeof um === 'object') {
    return n(um.promptTokenCount ?? um.prompt_token_count ?? um.input_tokens) +
           n(um.candidatesTokenCount ?? um.candidates_token_count ?? um.output_tokens);
  }

  return null;
}

/** Role body without frontmatter, used as the subagent's instructions. */
export function roleBody(agentsDir, role) {
  return parseAgentFile(readFileSync(path.join(agentsDir, `${role}.md`), 'utf8')).body;
}

export function buildRolePrompt(body, { prompt, paths }) {
  return [body, '## Your subtask', prompt, '## Assigned paths', ...paths.map((p) => `- ${p}`)].join('\n\n');
}

/** Changed files in the worktree, from git status (includes untracked files). */
export async function changedFiles(worktree) {
  const out = await git(worktree, ['status', '--porcelain', '-uall']);
  return out.split('\n').filter(Boolean).map((line) => {
    // git() trims stdout, so only the first line may lack its leading space: ' M a' on later lines,
    // 'M a' on the first. Strip optional spaces, the status code, then the separator (E-0003 T-0003).
    const p = line.replace(/^\s*\S+\s+/, '');
    return p.includes(' -> ') ? p.split(' -> ')[1] : p;
  });
}

/** Status lines (code + path) of the worktree, or null when it cannot be read. */
async function snapshot(worktree) {
  try {
    return new Set((await git(worktree, ['status', '--porcelain', '-uall'])).split('\n').filter(Boolean));
  } catch { return null; }
}

/** Undo what a planning call wrote: untracked files it added are removed, tracked ones reset to HEAD. */
async function undoPlanningEdits(worktree, before, after) {
  for (const line of after) {
    if (before.has(line)) continue;
    const file = line.replace(/^\S+\s+/, '').split(' -> ').pop();
    if (line.startsWith('??')) rmSync(path.join(worktree, file), { force: true, recursive: true });
    else await git(worktree, ['checkout', 'HEAD', '--', file]);
  }
}

/**
 * Runs a plan of disjoint subtasks in parallel, then checks that every changed
 * file belongs to the subtask that owns its paths.
 * plan: [{ role, paths: glob[], prompt }]. roles: { [role]: { model, body } }.
 * runner(args) runs one subagent (default: runSubagent bound to the config).
 */
export async function runPlan({ plan, roles, worktree, runner }) {
  if (!Array.isArray(plan) || plan.length === 0) throw new Error('plan must be a non-empty array');
  for (const item of plan) {
    if (!roles[item.role]) throw new Error(`unknown role in plan: ${item.role}`);
    if (!Array.isArray(item.paths) || item.paths.length === 0) throw new Error(`subtask ${item.role} needs paths`);
  }
  for (let i = 0; i < plan.length; i += 1) {
    for (let j = i + 1; j < plan.length; j += 1) {
      const clash = plan[i].paths.some((p) => plan[j].paths.some((q) => overlaps(p, q)));
      if (clash) throw new Error(`subtasks overlap: ${plan[i].role} and ${plan[j].role}`);
    }
  }
  const results = await Promise.all(plan.map((item) => runner({
    kind: roles[item.role].kind,
    model: roles[item.role].model,
    worktree,
    prompt: buildRolePrompt(roles[item.role].body, item),
  })));
  const changed = await changedFiles(worktree);
  for (const file of changed) {
    const owner = plan.find((item) => item.paths.some((g) => matchGlob(g, file)));
    if (!owner) throw new Error(`file changed outside every subtask: ${file}`);
  }
  return { results, changed };
}

/**
 * Agent adapter for the task runner (same contract as commandAgent). Two steps:
 * 1. A planning call on the ladder model asks for a subtasks plan (ARCHITECTURE 11, 29).
 * 2. A valid plan with 2+ disjoint subtasks runs through runPlan, in parallel. Anything
 *    else (unparseable or invalid plan, plan outside task.paths, overlapping plan, one
 *    subtask, planning call failed) falls back to the single implementer, with a log line.
 *    A change outside every subtask makes runPlan throw, so the task fails.
 * Evidence is the same placeholder as commandAgent: exit 0 means met (judged in M4).
 */
export function subagentAgent({ kind, allowedModels, agentsDir, allowHostAgents = false, runtime = 'host', image = null, containerRuntime = 'podman', authFiles = null, uid, gid, runner = runSubagent, log = console, departmentSpec = null, eventNormalizer = null }) {
  // The department spec (swarm/managers/<dept>.md) goes into every prompt.
  const rules = departmentSpec ? `\n\n## Department rules\n\n${departmentSpec.trim()}` : '';
  return async ({ task, worktree, findings = [], model, continuation = null, initialEvidence = null, control = null, assignmentId: requestedAssignmentId = null, sessionId: requestedSessionId = null }) => {
    if (!model) throw new Error('subagentAgent needs a model from the escalation ladder');
    const run = (args) => runner({ ...args, control: args.control ?? control, allowedModels, allowHostAgents, runtime, image, containerRuntime, authFiles, uid, gid });
    const evidenceFor = (detail) => task.acceptance.map((criterion) => ({ criterion, met: true, detail }));
    const assignmentId = continuation?.assignmentId ?? requestedAssignmentId ?? `agent-${task.id}-implementer-main`;
    const sessionId = continuation?.sessionId ?? requestedSessionId;
    const telemetry = eventNormalizer && sessionId ? eventNormalizer({ kind, assignmentId, sessionId, taskId: task.id }) : null;

    if (continuation) {
      let diffSummary = 'No diff summary available.';
      try { diffSummary = (await git(worktree, ['diff', '--stat', 'HEAD'])).slice(0, 4000) || 'No file changes yet.'; } catch { /* keep bounded fallback */ }
      const instructions = continuation.directives.map((directive) => {
        if (directive.kind === 'prompt') return `Prompt: ${directive.payload?.text ?? ''}`;
        if (directive.kind === 'context') return `Context override: ${JSON.stringify(directive.payload?.context ?? {})}`;
        return `${directive.kind}: ${JSON.stringify(directive.payload ?? {})}`;
      });
      const prompt = [
        roleBody(agentsDir, 'implementer'),
        '## Continuation checkpoint',
        `Task ${task.id}: ${task.title}`,
        continuation.priorSummary,
        'Current diff summary:', diffSummary,
        'New dashboard directives:', ...instructions.map((line) => `- ${line}`),
        'Continue in the same worktree. Preserve correct existing work and apply these instructions before checks.',
        rules,
      ].join('\n\n');
      const done = await run({ kind, model, worktree, prompt, control, onEvent: telemetry });
      const tokens = tokensFor(kind, done?.reply ?? '');
      return {
        tokens, subtasks: 1, evidence: initialEvidence ?? evidenceFor(`${kind} ${model} continuation exit 0`),
        assignmentId, sessionId: continuation.sessionId, agentKind: kind, model,
      };
    }

    // Step 1: plan. A failed planning call is not fatal: the single implementer still works.
    let tokens = 0;
    let plan = null;
    const roleNames = listRoles(agentsDir);
    const before = await snapshot(worktree);
    try {
      const planned = await run({ kind, model, worktree, readOnly: true, prompt: buildPlanningPrompt(task, roleNames, departmentSpec) });
      // The read-only flag is the first guard; this is the second. Planning edits are never credited to the implementer.
      const after = before ? await snapshot(worktree) : null;
      if (before && (!after || after.size !== before.size || [...after].some((l) => !before.has(l)))) {
        if (after) {
          try { await undoPlanningEdits(worktree, before, after); } catch (e) { log.warn?.(`[task] ${task.id} could not restore worktree after planning: ${String(e.message ?? e).slice(0, 200)}`); }
        }
        throw new Error('planning call changed files');
      }
      tokens += tokensFor(kind, planned?.reply ?? '');
      const parsed = parsePlanReply(planned?.reply ?? '');
      const checked = parsed.ok ? checkSubtasks(parsed.plan, { allowedPaths: task.paths, roleNames }) : parsed;
      if (checked.ok) plan = checked.plan;
      else log.warn?.(`[task] ${task.id} plan not used, single implementer: ${checked.reason}`);
    } catch (err) {
      log.warn?.(`[task] ${task.id} planning call failed, single implementer: ${String(err.message ?? err).slice(0, 200)}`);
    }
    if (plan && plan.length === 1) {
      log.info?.(`[task] ${task.id} plan has one subtask, single implementer`);
      plan = null;
    }

    // Step 2b: multi-subtask path.
    if (plan) {
      const roles = {};
      for (const item of plan) roles[item.role] = { kind, model, body: roleBody(agentsDir, item.role) };
      const withFindings = plan.map((item) => ({
        ...item,
        prompt: (findings.length ? `${item.prompt}\n\nReview findings to fix:\n${findings.map((f) => `- ${f}`).join('\n')}` : item.prompt) + rules,
      }));
      telemetry?.host('phase.changed', { summary: `Running ${plan.length} parallel subtasks`, phase: 'implement' });
      const { results } = await runPlan({ plan: withFindings, roles, worktree, runner: run });
      telemetry?.finish({ code: 0 });
      for (const r of results) tokens += tokensFor(kind, r?.reply ?? '');
      return { tokens, subtasks: plan.length, evidence: evidenceFor(`${kind} ${model} exit 0 (${plan.length} subtasks)`), assignmentId, agentKind: kind, model };
    }

    // Step 2a: single implementer, the prompt as before.
    const body = roleBody(agentsDir, 'implementer');
    const prompt = [
      `Task ${task.id}: ${task.title}`,
      'Acceptance criteria:', ...task.acceptance.map((c) => `- ${c}`),
      'Paths you may change:', ...task.paths.map((p) => `- ${p}`),
      ...(findings.length ? ['Review findings to fix:', ...findings.map((f) => `- ${f}`)] : []),
    ].join('\n');
    const done = await run({ kind, model, worktree, prompt: `${body}\n\n## Task\n${prompt}${rules}`, control, onEvent: telemetry });
    tokens += tokensFor(kind, done?.reply ?? '');
    return { tokens, subtasks: 1, evidence: evidenceFor(`${kind} ${model} exit 0 (single implementer)`), assignmentId, agentKind: kind, model };
  };
}

/**
 * The final result of an agy stream-json reply: the last `{"event":"result"}` line, or null.
 */
export function antigravityResult(replyText) {
  let result = null;
  for (const line of String(replyText ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const ev = JSON.parse(trimmed);
      if (ev?.event === 'result' && ev.result && typeof ev.result === 'object') result = ev.result;
    } catch { /* not JSON */ }
  }
  return result;
}

/**
 * Billable tokens from an agy reply: input + output + thinking of the final result.
 * Cache reads are left out, as for the other CLIs. Returns null without a usage block.
 */
export function antigravityTokens(replyText) {
  const u = antigravityResult(replyText)?.usage;
  if (!u || typeof u !== 'object') return null;
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return n(u.input_tokens) + n(u.output_tokens) + n(u.thinking_tokens);
}

/** Billable tokens in one reply; 0 when the reply has no usage block. */
export function tokensFor(kind, reply) {
  if (kind === 'claude') return claudeTokens(reply ?? '') ?? 0;
  if (kind === 'gemini') return geminiTokens(reply ?? '') ?? 0;
  if (kind === 'codex') return codexTokens(reply ?? '') ?? 0;
  if (kind === 'antigravity') return antigravityTokens(reply ?? '') ?? 0;
  return 0;
}

/** Role names available in agentsDir (file names without .md). */
export function listRoles(agentsDir) {
  return readdirSync(agentsDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
}

export function buildPlanningPrompt(task, roleNames, departmentSpec = null) {
  return [
    'You plan the work for one task. Do not edit any file and do not run any command.',
    `Task ${task.id}: ${task.title}`,
    'Acceptance criteria:', ...task.acceptance.map((c) => `- ${c}`),
    'Paths the task may change:', ...task.paths.map((p) => `- ${p}`),
    `Available roles: ${roleNames.join(', ')}`,
    'Split the task into subtasks that run in parallel. Each subtask has a role, a list of path globs and a prompt.',
    'Rules: subtask paths must not overlap each other and must stay inside the task paths. Every file the task names must belong to exactly one subtask. Use one subtask if the work cannot be split safely.',
    'Reply with ONLY a JSON object like {"subtasks":[{"role":"implementer","paths":["src/**"],"prompt":"..."}]}.',
    ...(departmentSpec ? ['', '## Department rules', '', departmentSpec.trim()] : []),
  ].join('\n');
}

/** Text of a CLI reply: unwraps the JSON envelope of claude (`result`), gemini (`response`) and agy (final result). */
function replyText(reply) {
  const agy = antigravityResult(reply);
  if (typeof agy?.response === 'string') return agy.response;
  try {
    const data = JSON.parse(reply);
    if (typeof data?.result === 'string') return data.result;
    if (typeof data?.response === 'string') return data.response;
  } catch { /* plain text */ }
  return reply;
}

/** First balanced {...} objects in text, string-aware. */
function* jsonObjects(text) {
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < text.length; i += 1) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i += 1;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { yield text.slice(start, i + 1); break; }
      }
    }
  }
}

/** Extracts and schema-validates the plan from a planning reply (bare JSON, fenced block, or prose around it). */
export function parsePlanReply(reply) {
  const text = replyText(String(reply ?? ''));
  const candidates = [text.trim()];
  for (const m of text.matchAll(/```[A-Za-z]*\s*\n([\s\S]*?)```/g)) candidates.push(m[1]);
  for (const obj of jsonObjects(text)) candidates.push(obj);
  let lastErrors = null;
  for (const c of candidates) {
    let data;
    try { data = JSON.parse(c); } catch { continue; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue;
    const { ok, errors } = validate('subtasks', data);
    if (ok) return { ok: true, plan: data.subtasks };
    lastErrors = errors;
  }
  return { ok: false, reason: lastErrors ? `plan invalid: ${lastErrors.join('; ')}` : 'no JSON plan found in the planning reply' };
}

/** Does glob `outer` match every path that glob `inner` matches? Conservative: false when unsure. */
export function globCovers(outer, inner) {
  try {
    return coverSegments(splitGlob(outer), splitGlob(inner));
  } catch {
    return false;
  }
}

function coverSegments(a, g) {
  if (a.length === 0) return g.length === 0;
  if (a[0] === '**') return coverSegments(a.slice(1), g) || (g.length > 0 && coverSegments(a, g.slice(1)));
  if (g.length === 0 || g[0] === '**') return false;
  const [x, y] = [a[0], g[0]];
  const ok = x === y || x === '*' || (!y.includes('*') && new RegExp(`^${x.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`).test(y));
  return ok && coverSegments(a.slice(1), g.slice(1));
}

/** Policy checks on a schema-valid plan: known roles, paths inside the task paths, no overlap. */
export function checkSubtasks(plan, { allowedPaths, roleNames }) {
  for (const item of plan) {
    if (!roleNames.includes(item.role)) return { ok: false, reason: `unknown role: ${item.role}` };
    for (const g of item.paths) {
      let valid = true;
      try { splitGlob(g); } catch { valid = false; }
      if (!valid) return { ok: false, reason: `bad path glob in subtask ${item.role}: ${g}` };
      if (!allowedPaths.some((a) => globCovers(a, g))) return { ok: false, reason: `subtask path outside task paths: ${g}` };
    }
  }
  for (let i = 0; i < plan.length; i += 1) {
    for (let j = i + 1; j < plan.length; j += 1) {
      if (plan[i].paths.some((p) => plan[j].paths.some((q) => overlaps(p, q)))) {
        return { ok: false, reason: `subtasks overlap: ${plan[i].role} and ${plan[j].role}` };
      }
    }
  }
  // A file the task names (a path without wildcards) must belong to a subtask: a file no subtask owns
  // fails runPlan the moment an implementer needs it (E-0003 T-0003 escalated three times on
  // swarm/protocol/validate.mjs). A glob such as src/** may still be split into parts.
  for (const t of allowedPaths.filter((p) => !/[*?[{]/.test(p))) {
    if (!plan.some((item) => item.paths.some((g) => globCovers(g, t)))) return { ok: false, reason: `task file not given to any subtask: ${t}` };
  }
  return { ok: true, plan };
}
