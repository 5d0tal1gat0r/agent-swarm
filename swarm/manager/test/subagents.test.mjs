import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { agentStdin, antigravityTokens, assertModel, buildAgentCommand, checkSubtasks, buildRolePrompt, changedFiles, roleBody, runPlan, runSubagent, subagentAgent, tokensFor, parsePlanReply, globCovers, windowsShellArgs } from '../src/subagents.mjs';
import { ladderFor, DEFAULT_LADDERS } from '../src/ladder.mjs';
import { git } from '../src/worktree.mjs';
import { loadPolicy } from '../../orchestrator/src/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');
const AGENTS = path.join(SWARM, 'agents');
const allowed = { claude: ['claude-sonnet-5-5', 'claude-haiku-5-5'], codex: [], gemini: ['gemini-2.5-flash-lite'], antigravity: ['gemini-3.8-flash-low'] };
const made = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };

/** Fake child process: records stdin, emits stdout/stderr and a close code on request. */
function fakeSpawn(script = {}) {
  const calls = [];
  const fn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdin = { data: '', on() {}, end(p) { child.stdin.data = p; } };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    calls.push({ cmd, args, opts, child });
    setImmediate(() => {
      if (script.stdout) child.stdout.emit('data', script.stdout);
      if (script.stderr) child.stderr.emit('data', script.stderr);
      if (script.hang) return;
      child.emit('close', script.code ?? 0);
    });
    return child;
  };
  fn.calls = calls;
  return fn;
}

describe('model check', () => {
  it('rejects an unknown kind, a malformed id, and an id not on the allow-list', () => {
    assert.throws(() => assertModel('mistral', 'x', allowed), /unknown agent kind/);
    assert.throws(() => assertModel('claude', '--dangerous', allowed), /malformed model id/);
    assert.throws(() => assertModel('claude', 'claude-fake-1', allowed), /not on the allow-list/);
    assert.throws(() => assertModel('codex', 'gpt-6-luna', allowed), /codex model not on the allow-list/, 'codex list empty until the owner picks');
    assert.doesNotThrow(() => assertModel('gemini', 'gemini-2.5-flash-lite', allowed));
  });
});

describe('command per kind', () => {
  it('builds an argument array per CLI, with the model and the worktree as arguments and no shell', () => {
    const wt = '/work/x';
    const c = buildAgentCommand({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: wt });
    assert.equal(c.cmd, 'claude');
    assert.deepEqual(c.args.slice(0, 4), ['-p', '--model', 'claude-sonnet-5-5', '--output-format']);
    assert.ok(c.args.includes(wt));
    assert.equal(buildAgentCommand({ kind: 'codex', model: 'gpt-6-luna', worktree: wt }).args.includes('gpt-6-luna'), true);
    assert.equal(buildAgentCommand({ kind: 'gemini', model: 'gemini-2.5-flash-lite', worktree: wt }).cmd, 'gemini');
  });

  it('refuses a relative worktree path', () => {
    assert.throws(() => buildAgentCommand({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: 'rel/path' }), /absolute path/);
  });
});

describe('runSubagent', () => {
  it('refuses to run on the host unless allowHostAgents is set, and never spawns', async () => {
    const spawnFn = fakeSpawn();
    await assert.rejects(runSubagent({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: '/w', prompt: 'p', allowedModels: allowed, spawnFn }), /allowHostAgents/);
    assert.equal(spawnFn.calls.length, 0);
  });

  it('antigravity: prompt goes on stdin as one stream-json message; tokens and text come from the result line', async () => {
    const c = buildAgentCommand({ kind: 'antigravity', model: 'gemini-3.8-flash-low', worktree: '/w' });
    assert.equal(c.cmd, 'agy');
    assert.ok(c.args.includes('accept-edits') && c.args.includes('stream-json') && c.args.at(-1) === '-p=');
    assert.ok(buildAgentCommand({ kind: 'antigravity', model: 'gemini-3.8-flash-low', worktree: '/w', readOnly: true }).args.includes('plan'));
    assert.deepEqual(JSON.parse(agentStdin('antigravity', 'line 1\n"q"')), { event: 'user', message: { content: 'line 1\n"q"' } });
    assert.equal(agentStdin('claude', 'p'), 'p');
    const reply = [
      '{"event":"init","init":{"model":"gemini-3.8-flash-low"}}',
      '{"event":"step_update","step_update":{"text_delta":"done."}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"done.","usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":5,"cache_read_tokens":900}}}',
    ].join('\n');
    assert.equal(antigravityTokens(reply), 125);
    assert.equal(tokensFor('antigravity', reply), 125);
    assert.equal(antigravityTokens('not json'), null);
    const spawnFn = fakeSpawn({ stdout: reply });
    await runSubagent({ kind: 'antigravity', model: 'gemini-3.8-flash-low', worktree: '/w', prompt: 'secret instructions', allowedModels: allowed, allowHostAgents: true, spawnFn });
    assert.match(spawnFn.calls[0].child.stdin.data, /^\{"event":"user","message":\{"content":"secret instructions"\}\}\n$/);
    assert.ok(!spawnFn.calls[0].args.some((a) => a.includes('secret')), 'prompt never in argv');
  });

  it('pipes the prompt on stdin and resolves with the reply', async () => {
    const spawnFn = fakeSpawn({ stdout: 'DONE' });
    const r = await runSubagent({ kind: 'gemini', model: 'gemini-2.5-flash-lite', worktree: '/w', prompt: 'secret instructions', allowedModels: allowed, allowHostAgents: true, spawnFn });
    assert.equal(r.reply, 'DONE');
    assert.equal(spawnFn.calls[0].child.stdin.data, 'secret instructions');
    assert.ok(!spawnFn.calls[0].args.includes('secret instructions'), 'prompt never in argv');
    assert.equal(spawnFn.calls[0].opts.cwd, '/w');
  });

  it('forwards stdout, stderr and completion to an optional event hook without changing the result', async () => {
    const spawnFn = fakeSpawn({ stdout: 'DONE', stderr: 'warning' });
    const seen = [];
    const onEvent = {
      stdout: (chunk) => seen.push(['stdout', String(chunk)]),
      stderr: (chunk) => { seen.push(['stderr', String(chunk)]); throw new Error('telemetry failure'); },
      finish: (result) => seen.push(['finish', result.code, result.reply]),
    };
    const result = await runSubagent({ kind: 'gemini', model: 'gemini-2.5-flash-lite', worktree: '/w', prompt: 'p', allowedModels: allowed, allowHostAgents: true, spawnFn, onEvent });
    assert.equal(result.reply, 'DONE');
    assert.deepEqual(seen.filter(([kind]) => kind !== 'stderr'), [['stdout', 'DONE'], ['finish', 0, 'DONE']]);
  });

  it('a non-zero exit rejects with the stderr tail', async () => {
    const spawnFn = fakeSpawn({ stderr: 'quota exceeded', code: 3 });
    await assert.rejects(runSubagent({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: '/w', prompt: 'p', allowedModels: allowed, allowHostAgents: true, spawnFn }), /claude subagent exit 3: quota exceeded/);
  });

  it('kills and rejects a subagent that runs past the timeout', async () => {
    const spawnFn = fakeSpawn({ hang: true });
    await assert.rejects(runSubagent({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: '/w', prompt: 'p', allowedModels: allowed, allowHostAgents: true, spawnFn, timeoutMs: 50 }), /timed out/);
    assert.equal(spawnFn.calls[0].child.killed, true);
  });

  it('exposes an audited interrupt hook that signals the child without deleting its worktree', async () => {
    const spawnFn = fakeSpawn({ hang: true });
    const control = {};
    const running = runSubagent({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: '/w', prompt: 'p', allowedModels: allowed, allowHostAgents: true, spawnFn, control, timeoutMs: 5_000 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof control.interrupt, 'function');
    control.interrupt();
    assert.equal(spawnFn.calls[0].child.killed, true);
    spawnFn.calls[0].child.emit('close', null);
    await assert.rejects(running, /SIGINT: interrupt directive/);
  });

  it('spawns without a shell on POSIX, args unchanged', async () => {
    const spawnFn = fakeSpawn({ stdout: 'DONE' });
    await runSubagent({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: '/w dir', prompt: 'p', allowedModels: allowed, allowHostAgents: true, spawnFn, platform: 'linux' });
    assert.equal(spawnFn.calls[0].opts.shell, undefined);
    assert.ok(spawnFn.calls[0].args.includes('/w dir'));
  });

  it('on win32 runs through a shell with whitespace args quoted', async () => {
    const spawnFn = fakeSpawn({ stdout: 'DONE' });
    await runSubagent({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: '/w/Program Files/wt', prompt: 'p', allowedModels: allowed, allowHostAgents: true, spawnFn, platform: 'win32' });
    assert.equal(spawnFn.calls[0].opts.shell, true);
    assert.ok(spawnFn.calls[0].args.includes('"/w/Program Files/wt"'));
    assert.equal(spawnFn.calls[0].child.stdin.data, 'p');
  });

  it('on win32 refuses an argument cmd.exe would misread, and never spawns', async () => {
    const spawnFn = fakeSpawn();
    await assert.rejects(runSubagent({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: '/w&calc', prompt: 'p', allowedModels: allowed, allowHostAgents: true, spawnFn, platform: 'win32' }), /not safe for cmd.exe/);
    assert.equal(spawnFn.calls.length, 0);
  });

  it('container runtime refuses a host with no numeric uid/gid', async () => {
    const spawnFn = fakeSpawn();
    await assert.rejects(runSubagent({ kind: 'claude', model: 'claude-sonnet-5-5', worktree: '/w', prompt: 'p', allowedModels: allowed, runtime: 'container', image: 'img', uid: null, gid: null, spawnFn }), /numeric uid and gid/);
    assert.equal(spawnFn.calls.length, 0);
  });
});

describe('windowsShellArgs', () => {
  it('quotes args with spaces or parentheses and passes plain args through', () => {
    assert.deepEqual(windowsShellArgs(['-p', 'x', 'C:\\a b', 'C:\\Program Files (x86)\\y']), ['-p', 'x', '"C:\\a b"', '"C:\\Program Files (x86)\\y"']);
  });

  it('rejects quotes, percent, bang, pipes, redirects and carets', () => {
    for (const bad of ['a"b', '%PATH%', 'a!b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a\nb']) {
      assert.throws(() => windowsShellArgs([bad]), /not safe for cmd.exe/, bad);
    }
  });
});

describe('plan of subtasks', () => {
  const repo = () => {
    const dir = tmp('swarm-plan-');
    return git(dir, ['init', '--quiet']).then(async () => {
      fs.writeFileSync(path.join(dir, 'seed.txt'), 'x\n');
      await git(dir, ['add', '-A']);
      await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed']);
      return dir;
    });
  };
  const roles = { impl: { kind: 'claude', model: 'claude-sonnet-5-5', body: 'impl body' }, docs: { kind: 'claude', model: 'claude-haiku-5-5', body: 'docs body' } };

  it('runs disjoint subtasks in parallel, then accepts changes inside each subtask', async () => {
    const wt = await repo();
    const started = [];
    const gates = [];
    const runner = async ({ worktree, prompt }) => {
      started.push(prompt.slice(0, 4));
      await new Promise((r) => { gates.push(r); });
      return { ok: true };
    };
    const planned = runPlan({
      plan: [{ role: 'impl', paths: ['src/**'], prompt: 'do src' }, { role: 'docs', paths: ['docs/**'], prompt: 'do docs' }],
      roles, worktree: wt, runner,
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(started.length, 2, 'both subagents started before either finished');
    fs.mkdirSync(path.join(wt, 'src'));
    fs.writeFileSync(path.join(wt, 'src', 'a.mjs'), 'a\n');
    fs.mkdirSync(path.join(wt, 'docs'));
    fs.writeFileSync(path.join(wt, 'docs', 'b.md'), 'b\n');
    gates.forEach((g) => g());
    const out = await planned;
    assert.deepEqual(out.changed.sort(), ['docs/b.md', 'src/a.mjs']);
  });

  it('rejects overlapping subtasks before any subagent runs', async () => {
    const wt = await repo();
    let ran = 0;
    await assert.rejects(runPlan({
      plan: [{ role: 'impl', paths: ['src/**'], prompt: 'a' }, { role: 'docs', paths: ['src/x/**'], prompt: 'b' }],
      roles, worktree: wt, runner: async () => { ran += 1; },
    }), /subtasks overlap: impl and docs/);
    assert.equal(ran, 0);
  });

  it('rejects a change outside every subtask\'s paths', async () => {
    const wt = await repo();
    const runner = async () => { fs.writeFileSync(path.join(wt, 'secret.env'), 'x\n'); };
    await assert.rejects(runPlan({ plan: [{ role: 'impl', paths: ['src/**'], prompt: 'a' }], roles, worktree: wt, runner }), /changed outside every subtask: secret\.env/);
  });

  it('changedFiles strips the status code from every line, not just the first (" M path" lines)', async () => {
    const wt = await repo();
    for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(wt, f), '1\n');
    await git(wt, ['add', '-A']);
    await git(wt, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'three']);
    for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(wt, f), '2\n');
    fs.writeFileSync(path.join(wt, 'new.txt'), 'n\n');
    assert.deepEqual((await changedFiles(wt)).sort(), ['a.txt', 'b.txt', 'c.txt', 'new.txt']);
    const roles = { impl: { kind: 'claude', model: 'm', body: 'b' } };
    const plan = [{ role: 'impl', paths: ['a.txt', 'b.txt'], prompt: 'x' }, { role: 'impl', paths: ['c.txt', 'new.txt'], prompt: 'y' }];
    await runPlan({ plan, roles, worktree: wt, runner: async () => ({ reply: '' }) });
  });

  it('changedFiles lists untracked files inside new folders', async () => {
    const wt = await repo();
    fs.mkdirSync(path.join(wt, 'deep', 'er'), { recursive: true });
    fs.writeFileSync(path.join(wt, 'deep', 'er', 'f.txt'), 'f\n');
    assert.deepEqual(await changedFiles(wt), ['deep/er/f.txt']);
  });
});

describe('subagent task adapter', () => {
  const task = { id: 'T-0801', title: 'Add thing', acceptance: ['thing exists', 'tests pass'], paths: ['src/**'] };

  it('runs the implementer role body on the ladder model and passes findings in the prompt', async () => {
    let got;
    const runner = async (args) => { got = args; return { reply: 'ok' }; };
    const agent = subagentAgent({ kind: 'gemini', allowedModels: allowed, agentsDir: AGENTS, allowHostAgents: true, runner });
    const out = await agent({ task, worktree: '/w', findings: ['#1 blocker src/x.mjs: bad'], model: 'gemini-2.5-flash-lite' });
    assert.equal(got.model, 'gemini-2.5-flash-lite');
    assert.equal(got.kind, 'gemini');
    assert.match(got.prompt, /You implement the change/, 'role body included');
    assert.match(got.prompt, /- thing exists/);
    assert.match(got.prompt, /#1 blocker src\/x\.mjs: bad/);
    assert.deepEqual(out.evidence.map((e) => e.criterion), ['thing exists', 'tests pass']);
  });

  it('refuses to run without a ladder model', async () => {
    const agent = subagentAgent({ kind: 'claude', allowedModels: allowed, agentsDir: AGENTS, runner: async () => ({}) });
    await assert.rejects(agent({ task, worktree: '/w' }), /needs a model from the escalation ladder/);
  });

  it('the role files are readable and the prompt builder lists the paths', () => {
    assert.match(roleBody(AGENTS, 'checker'), /You check the change/);
    assert.match(buildRolePrompt('BODY', { prompt: 'p', paths: ['a/**', 'b/**'] }), /## Assigned paths\n\n- a\/\*\*\n\n- b\/\*\*/);
  });

  it('the ladder defaults are on the shipped policy allow-list; codex has one step (owner pick)', () => {
    const policy = loadPolicy(path.join(SWARM, 'policy.yaml'));
    for (const id of DEFAULT_LADDERS.claude) assert.ok(policy.models.claude.includes(id));
    for (const id of DEFAULT_LADDERS.gemini) assert.ok(policy.models.gemini.includes(id));
    for (const id of DEFAULT_LADDERS.codex) assert.ok(policy.models.codex.includes(id));
    assert.deepEqual(ladderFor('codex', undefined), ['gpt-5.6-luna']);
    assert.deepEqual(ladderFor('codex', ['gpt-5.6-luna']), ['gpt-5.6-luna']);
    assert.throws(() => ladderFor('mistral', undefined), /no default escalation ladder for mistral/);
  });
});

describe('token accounting', () => {
  it('claudeTokens sums input, output and cache creation, and leaves out cache reads', async () => {
    const { claudeTokens } = await import('../src/subagents.mjs');
    const reply = JSON.stringify({ result: 'ok', usage: { input_tokens: 2, output_tokens: 45, cache_creation_input_tokens: 39244, cache_read_input_tokens: 9012 } });
    assert.equal(claudeTokens(reply), 2 + 45 + 39244);
  });

  it('geminiTokens sums prompt and candidate tokens from stats.models', async () => {
    const { geminiTokens } = await import('../src/subagents.mjs');
    const reply = JSON.stringify({
      response: 'DONE',
      stats: {
        models: {
          'gemini-2.5-flash-lite': {
            tokens: { prompt: 150, candidates: 42, total: 192, cached: 0 }
          }
        }
      }
    });
    assert.equal(geminiTokens(reply), 150 + 42);
  });

  it('geminiTokens sums across multiple models in stats.models', async () => {
    const { geminiTokens } = await import('../src/subagents.mjs');
    const reply = JSON.stringify({
      stats: {
        models: {
          'model-a': { tokens: { prompt: 100, candidates: 20 } },
          'model-b': { tokens: { prompt: 50, candidates: 10 } }
        }
      }
    });
    assert.equal(geminiTokens(reply), 120 + 60);
  });

  it('geminiTokens handles streaming stats, direct tokens block, and usageMetadata fallback', async () => {
    const { geminiTokens } = await import('../src/subagents.mjs');
    assert.equal(geminiTokens(JSON.stringify({ stats: { input_tokens: 80, output_tokens: 20 } })), 100);
    assert.equal(geminiTokens(JSON.stringify({ stats: { tokens: { prompt: 50, candidates: 15 } } })), 65);
    assert.equal(geminiTokens(JSON.stringify({ usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30 } })), 230);
    assert.equal(geminiTokens(JSON.stringify({ stats: {} })), 0);
  });

  it('returns null for a reply with no usage block or no JSON', async () => {
    const { claudeTokens, geminiTokens } = await import('../src/subagents.mjs');
    assert.equal(claudeTokens('not json'), null);
    assert.equal(claudeTokens(JSON.stringify({ result: 'ok' })), null);
    assert.equal(geminiTokens('not json'), null);
    assert.equal(geminiTokens(JSON.stringify({ result: 'ok' })), null);
  });

  it('codexTokens reads the real `codex exec --json` fixture: input minus cached input, plus output', async () => {
    const { codexTokens } = await import('../src/subagents.mjs');
    const reply = fs.readFileSync(path.join(HERE, 'fixtures', 'codex-exec-json.jsonl'), 'utf8');
    // input_tokens 20624 includes cached_input_tokens 6784; output_tokens 5 includes reasoning (0)
    assert.equal(codexTokens(reply), 20624 - 6784 + 5);
  });

  it('codexTokens sums every turn.completed and skips junk lines', async () => {
    const { codexTokens } = await import('../src/subagents.mjs');
    const turn = (input, cached, output) => JSON.stringify({ type: 'turn.completed', usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 2 } });
    const reply = [turn(100, 40, 10), 'not json', JSON.stringify({ type: 'turn.started' }), turn(50, 0, 5)].join('\n');
    assert.equal(codexTokens(reply), (100 - 40 + 10) + (50 + 5));
  });

  it('codexTokens returns null without a turn.completed usage block', async () => {
    const { codexTokens } = await import('../src/subagents.mjs');
    assert.equal(codexTokens('not json'), null);
    assert.equal(codexTokens(''), null);
    assert.equal(codexTokens(JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } })), null);
    assert.equal(codexTokens(JSON.stringify({ type: 'turn.completed' })), null);
  });

  it('the codex adapter reports the tokens it found', async () => {
    const reply = fs.readFileSync(path.join(HERE, 'fixtures', 'codex-exec-json.jsonl'), 'utf8');
    const task = { id: 'T-0902', title: 't', acceptance: ['a'], paths: ['x/**'] };
    const codex = subagentAgent({ kind: 'codex', allowedModels: { codex: ['gpt-5.6-luna'] }, agentsDir: AGENTS, allowHostAgents: true, runner: async () => ({ reply }) });
    // one planning call plus one implementer call
    assert.equal((await codex({ task, worktree: '/w', model: 'gpt-5.6-luna' })).tokens, 2 * (20624 - 6784 + 5));
  });

  it('the claude and gemini adapters report the tokens they found; other kinds report 0', async () => {
    const claudeReply = JSON.stringify({ usage: { input_tokens: 10, output_tokens: 5 } });
    const geminiReply = JSON.stringify({ stats: { models: { 'gemini-2.5-flash-lite': { tokens: { prompt: 20, candidates: 10 } } } } });
    const task = { id: 'T-0901', title: 't', acceptance: ['a'], paths: ['x/**'] };
    const claude = subagentAgent({ kind: 'claude', allowedModels: { claude: ['claude-haiku-5-5'] }, agentsDir: AGENTS, allowHostAgents: true, runner: async () => ({ reply: claudeReply }) });
    // one planning call plus one implementer call, 15 tokens each
    assert.equal((await claude({ task, worktree: '/w', model: 'claude-haiku-5-5' })).tokens, 30);
    // claude format reply given to gemini yields 0
    const geminiEmpty = subagentAgent({ kind: 'gemini', allowedModels: allowed, agentsDir: AGENTS, allowHostAgents: true, runner: async () => ({ reply: claudeReply }) });
    assert.equal((await geminiEmpty({ task, worktree: '/w', model: 'gemini-2.5-flash-lite' })).tokens, 0);
    // gemini format reply: one planning call (30) + one implementer call (30) = 60
    const gemini = subagentAgent({ kind: 'gemini', allowedModels: allowed, agentsDir: AGENTS, allowHostAgents: true, runner: async () => ({ reply: geminiReply }) });
    assert.equal((await gemini({ task, worktree: '/w', model: 'gemini-2.5-flash-lite' })).tokens, 60);
  });
});

describe('plan runner on the default path', () => {
  const silent = { warn() {}, info() {} };
  const task = { id: 'T-0107', title: 'Two parts', acceptance: ['src done', 'docs done'], paths: ['src/**', 'docs/**'] };
  const planJson = (subtasks) => JSON.stringify({ subtasks });
  const two = [{ role: 'implementer', paths: ['src/**'], prompt: 'do src' }, { role: 'doc-writer', paths: ['docs/**'], prompt: 'do docs' }];
  const usage = (n) => ({ usage: { input_tokens: n, output_tokens: 0 } });
  const repo = async () => {
    const dir = tmp('swarm-t107-');
    await git(dir, ['init', '--quiet']);
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'x\n');
    await git(dir, ['add', '-A']);
    await git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'seed']);
    return dir;
  };
  const make = (runner, kind = 'claude') => subagentAgent({ kind, allowedModels: allowed, agentsDir: AGENTS, allowHostAgents: true, runner, log: silent });
  const model = 'claude-sonnet-5-5';
  const isPlanning = (prompt) => prompt.startsWith('You plan the work');

  // Waits on an event, not a timer: before the subagents start, the agent runs `git status`
  // twice (around the planning call), which takes longer than any fixed sleep on a loaded
  // CI machine. Each subagent blocks on its gate, so the second one can only start
  // while the first is still running: if runPlan ran them one after another, bothStarted
  // would never resolve and the test timeout below would fail it.
  it('runs two disjoint subtasks in parallel, keeps changes inside paths and sums tokens', { timeout: 30_000 }, async () => {
    const wt = await repo();
    const started = [];
    const gates = [];
    let markBothStarted;
    const bothStarted = new Promise((r) => { markBothStarted = r; });
    const runner = async ({ prompt }) => {
      if (isPlanning(prompt)) return { reply: JSON.stringify({ result: `Here:\n\`\`\`json\n${planJson(two)}\n\`\`\``, ...usage(7) }) };
      started.push(prompt);
      if (started.length === 2) markBothStarted();
      await new Promise((r) => { gates.push(r); });
      return { reply: JSON.stringify(usage(10)) };
    };
    const running = make(runner)({ task, worktree: wt, findings: ['#1 fix me'], model });
    const first = await Promise.race([bothStarted.then(() => 'started'), running.then(() => 'finished')]);
    assert.equal(first, 'started', 'agent finished before both subagents started');
    assert.equal(started.length, 2, 'both subagents started before either resolved');
    assert.ok(started.some((p) => p.includes('do src') && p.includes('- src/**')));
    assert.ok(started.every((p) => p.includes('#1 fix me')), 'findings in each subtask prompt');
    fs.mkdirSync(path.join(wt, 'src'));
    fs.writeFileSync(path.join(wt, 'src', 'a.mjs'), 'a\n');
    fs.mkdirSync(path.join(wt, 'docs'));
    fs.writeFileSync(path.join(wt, 'docs', 'b.md'), 'b\n');
    gates.forEach((g) => g());
    const out = await running;
    assert.equal(out.tokens, 7 + 10 + 10);
    assert.equal(out.subtasks, 2);
    assert.deepEqual(out.evidence.map((e) => e.criterion), ['src done', 'docs done']);
  });

  it('a change outside the subtask paths makes the agent throw, and runTask reports fail', async () => {
    const wt = await repo();
    const runner = async ({ prompt }) => {
      if (isPlanning(prompt)) return { reply: planJson(two) };
      fs.writeFileSync(path.join(wt, 'secret.env'), 'x\n');
      return { reply: '' };
    };
    await assert.rejects(make(runner)({ task, worktree: wt, model }), /changed outside every subtask: secret\.env/);

    const { runTask } = await import('../src/task-runner.mjs');
    const root = tmp('swarm-t107-rt-');
    const origin = path.join(root, 'origin.git');
    const repoDir = path.join(root, 'repo');
    const stateDir = path.join(root, 'state');
    await git(root, ['init', '--quiet', '--bare', origin]);
    await git(root, ['clone', '--quiet', origin, repoDir]);
    fs.writeFileSync(path.join(repoDir, 'README.md'), 'hello\n');
    await git(repoDir, ['add', '-A']);
    await git(repoDir, ['commit', '--quiet', '-m', 'init'], { identity: { name: 't', email: 't@t' } });
    await git(repoDir, ['push', '--quiet', 'origin', 'HEAD:main']);
    const calls = [];
    const client = { progress: async (...a) => { calls.push(['progress', ...a]); }, fail: async (...a) => { calls.push(['fail', ...a]); }, submit: async () => { throw new Error('must not submit'); } };
    const agent = async ({ worktree }) => make(async ({ prompt }) => {
      if (isPlanning(prompt)) return { reply: planJson(two) };
      fs.writeFileSync(path.join(worktree, 'secret.env'), 'x\n');
      return { reply: '' };
    })({ task, worktree, model });
    const res = await runTask({ task: { ...task, department: 'core', size: 'S', attempts: 0 }, client, manager: 'm', identity: { name: 'n', email: 'n@n' }, stateDir, repoDir, agent, checks: async () => ({ ok: true }), openPr: async () => 1, log: silent });
    assert.equal(res.status, 'failed');
    assert.match(res.reason, /changed outside every subtask/);
    assert.equal(calls.at(-1)[0], 'fail');
  });

  it('a one-subtask plan uses the single implementer prompt', async () => {
    const prompts = [];
    const runner = async ({ prompt }) => { prompts.push(prompt); return { reply: isPlanning(prompt) ? planJson([two[0]]) : 'ok' }; };
    const out = await make(runner)({ task, worktree: '/w', model });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /^You implement the change[\s\S]*## Task\nTask T-0107: Two parts\nAcceptance criteria:\n- src done/);
    assert.equal(out.subtasks, 1);
  });

  it('an unparseable or invalid planning reply falls back to the single implementer', async () => {
    for (const bad of ['no json here', '{"subtasks": []}', '{"subtasks":[{"role":"implementer","paths":["src/**"]}]}', planJson([{ role: 'nobody', paths: ['src/**'], prompt: 'x' }, two[1]])]) {
      const prompts = [];
      const runner = async ({ prompt }) => { prompts.push(prompt); return { reply: isPlanning(prompt) ? bad : 'ok' }; };
      const out = await make(runner)({ task, worktree: '/w', model });
      assert.equal(prompts.length, 2, bad);
      assert.match(prompts[1], /You implement the change/);
      assert.equal(out.subtasks, 1);
    }
  });

  it('planning argv is read-only per kind and the implementer argv is unchanged', () => {
    const wt = '/tmp/w';
    const m = { claude: 'claude-sonnet-5-5', codex: 'gpt-6-luna', gemini: 'gemini-2.5-flash-lite' };
    const bad = { claude: ['acceptEdits', '--dangerously-skip-permissions'], codex: ['workspace-write', 'danger-full-access', '--full-auto'], gemini: ['auto_edit', 'yolo', '--yolo'] };
    const flag = { claude: ['--permission-mode', 'plan'], codex: ['-s', 'read-only'], gemini: ['--approval-mode', 'plan'] };
    for (const kind of ['claude', 'codex', 'gemini']) {
      const ro = buildAgentCommand({ kind, model: m[kind], worktree: wt, readOnly: true }).args;
      const rw = buildAgentCommand({ kind, model: m[kind], worktree: wt }).args;
      const i = ro.indexOf(flag[kind][0]);
      assert.deepEqual(ro.slice(i, i + 2), flag[kind], kind);
      for (const b of bad[kind]) assert.ok(!ro.includes(b), `${kind} planning has ${b}`);
      assert.ok(bad[kind].some((b) => rw.includes(b)), `${kind} implementer keeps write mode`);
      assert.equal(ro.length, rw.length);
    }
  });

  it('only the planning call is read-only', async () => {
    const seen = [];
    const runner = async ({ prompt, readOnly }) => { seen.push([isPlanning(prompt), readOnly]); return { reply: isPlanning(prompt) ? planJson([two[0]]) : 'ok' }; };
    await make(runner)({ task, worktree: '/w', model });
    assert.deepEqual(seen, [[true, true], [false, undefined]]);
  });

  it('a planning run that writes a file fails planning, is reverted, and falls back to the implementer', async () => {
    const wt = await repo();
    fs.writeFileSync(path.join(wt, 'seed.txt'), 'x\n');
    const calls = [];
    const runner = async ({ prompt }) => {
      calls.push(prompt);
      if (isPlanning(prompt)) {
        fs.writeFileSync(path.join(wt, 'seed.txt'), 'planner edit\n');
        fs.writeFileSync(path.join(wt, 'new.txt'), 'n\n');
        return { reply: planJson(two) };
      }
      assert.equal(fs.readFileSync(path.join(wt, 'seed.txt'), 'utf8'), 'x\n', 'restored before implementer');
      assert.ok(!fs.existsSync(path.join(wt, 'new.txt')));
      return { reply: 'ok' };
    };
    const warns = [];
    const agent = subagentAgent({ kind: 'claude', allowedModels: allowed, agentsDir: AGENTS, allowHostAgents: true, runner, log: { warn: (m) => warns.push(m) } });
    const out = await agent({ task, worktree: wt, model });
    assert.equal(calls.length, 2, 'planning plus single implementer, no plan run');
    assert.match(calls[1], /You implement the change/);
    assert.equal(out.subtasks, 1);
    assert.deepEqual(await changedFiles(wt), []);
    assert.ok(warns.some((w) => /planning call failed.*changed files/.test(w)));
  });

  it('a failed planning call falls back to the single implementer', async () => {
    let n = 0;
    const runner = async ({ prompt }) => { n += 1; if (isPlanning(prompt)) throw new Error('boom'); return { reply: 'ok' }; };
    const out = await make(runner)({ task, worktree: '/w', model });
    assert.equal(n, 2);
    assert.equal(out.subtasks, 1);
  });

  it('an overlapping plan falls back to the single implementer before any subtask runs', async () => {
    const overlapping = [{ role: 'implementer', paths: ['src/**'], prompt: 'a' }, { role: 'doc-writer', paths: ['src/x/**'], prompt: 'b' }];
    const prompts = [];
    const runner = async ({ prompt }) => { prompts.push(prompt); return { reply: isPlanning(prompt) ? planJson(overlapping) : 'ok' }; };
    await make(runner)({ task, worktree: '/w', model });
    assert.equal(prompts.length, 2, 'planning plus the single implementer only');
    assert.match(prompts[1], /You implement the change/);
  });

  it('a subtask path outside task.paths is rejected and falls back', async () => {
    const outside = [{ role: 'implementer', paths: ['src/**'], prompt: 'a' }, { role: 'doc-writer', paths: ['other/**'], prompt: 'b' }];
    const prompts = [];
    const runner = async ({ prompt }) => { prompts.push(prompt); return { reply: isPlanning(prompt) ? planJson(outside) : 'ok' }; };
    await make(runner)({ task, worktree: '/w', model });
    assert.equal(prompts.length, 2);
  });

  it('a plan that leaves a named task file to no subtask falls back; splitting a glob is fine', () => {
    const roleNames = ['implementer', 'test-writer'];
    const allowedPaths = ['swarm/protocol/api/x.schema.json', 'swarm/protocol/validate.mjs', 'swarm/protocol/test/**'];
    const missing = [{ role: 'implementer', paths: ['swarm/protocol/api/x.schema.json'], prompt: 'a' }, { role: 'test-writer', paths: ['swarm/protocol/test/**'], prompt: 'b' }];
    assert.deepEqual(checkSubtasks(missing, { allowedPaths, roleNames }), { ok: false, reason: 'task file not given to any subtask: swarm/protocol/validate.mjs' });
    const full = [{ role: 'implementer', paths: ['swarm/protocol/api/x.schema.json', 'swarm/protocol/validate.mjs'], prompt: 'a' }, { role: 'test-writer', paths: ['swarm/protocol/test/a/**'], prompt: 'b' }];
    assert.equal(checkSubtasks(full, { allowedPaths, roleNames }).ok, true, 'a glob task path may be split or partly used');
  });

  it('globCovers is conservative', () => {
    assert.ok(globCovers('src/**', 'src/a/*.mjs'));
    assert.ok(globCovers('src/**', 'src/**'));
    assert.ok(globCovers('src/*.mjs', 'src/a.mjs'));
    assert.ok(globCovers('**', 'x/y'));
    assert.ok(!globCovers('src/*', 'src/**'));
    assert.ok(!globCovers('src/**', 'srcx/a'));
    assert.ok(!globCovers('src/*.mjs', 'src/*.js'));
    assert.ok(!globCovers('src/**', '../x'));
  });

  it('parsePlanReply reads bare JSON, prose around JSON and gemini envelopes', () => {
    assert.equal(parsePlanReply(planJson(two)).ok, true);
    assert.equal(parsePlanReply(`Sure {not json} then ${planJson(two)} done`).ok, true);
    assert.equal(parsePlanReply(JSON.stringify({ response: planJson(two) })).ok, true);
    assert.equal(parsePlanReply('nothing').ok, false);
  });

  it('tokensFor parses each kind in its own format and gives 0 for a foreign format', () => {
    const claudeReply = JSON.stringify({ usage: { input_tokens: 3, output_tokens: 4 } });
    const geminiReply = JSON.stringify({ stats: { models: { 'gemini-2.5-flash-lite': { tokens: { prompt: 10, candidates: 5 } } } } });
    assert.equal(tokensFor('claude', claudeReply), 7);
    assert.equal(tokensFor('claude', 'junk'), 0);
    assert.equal(tokensFor('gemini', claudeReply), 0);
    assert.equal(tokensFor('gemini', geminiReply), 15);
    assert.equal(tokensFor('gemini', 'junk'), 0);
    assert.equal(tokensFor('codex', claudeReply), 0);
    assert.equal(tokensFor('codex', geminiReply), 0);
    assert.equal(tokensFor('codex', 'junk'), 0);
    const codexReply = JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 30, cached_input_tokens: 10, output_tokens: 6 } });
    assert.equal(tokensFor('codex', codexReply), 26);
    assert.equal(tokensFor('gemini', codexReply), 0);
  });
});
