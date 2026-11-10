#!/usr/bin/env node
// Manual live check of the subagent CLIs (P5.5). Never run in CI. Refuses
// unless SWARM_LIVE=1. Each kind gets a throwaway folder and one tiny task:
// write hello.txt with the text "ok". Prints a markdown table for the PR.
// The model is passed in, not read from policy: this checks the CLI, not the
// allow-list. Usage:
//   SWARM_LIVE=1 node manager/live/live-check.mjs --claude claude-haiku-5-5 --gemini gemini-2.5-flash-lite [--codex <id>] [--antigravity gemini-3.8-flash-low]
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KINDS, runSubagent } from '../src/subagents.mjs';

if (process.env.SWARM_LIVE !== '1') {
  console.error('refusing: set SWARM_LIVE=1 to call the real CLIs');
  process.exit(2);
}

const flags = {};
for (let i = 2; i < process.argv.length; i += 2) flags[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const PROMPT = 'Create a file named hello.txt in the current folder whose content is exactly: ok\nThen reply with the single word DONE.';

const rows = [];
for (const kind of KINDS) {
  const model = flags[kind];
  if (!model) continue;
  const dir = mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), `swarm-live-${kind}-`));
  const started = Date.now();
  let status;
  let detail;
  try {
    const { reply } = await runSubagent({ kind, model, worktree: dir, prompt: PROMPT, allowedModels: { [kind]: [model] }, allowHostAgents: true, timeoutMs: 5 * 60_000 });
    const file = path.join(dir, 'hello.txt');
    const content = existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
    status = content === 'ok' ? 'pass' : 'fail';
    detail = `file=${JSON.stringify(content)} reply=${JSON.stringify(reply.slice(0, 60))}`;
  } catch (err) {
    status = 'error';
    detail = err.message.slice(0, 200);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  rows.push({ kind, model, status, seconds: ((Date.now() - started) / 1000).toFixed(1), detail });
}

console.log('| CLI | model | result | seconds | detail |');
console.log('| --- | --- | --- | --- | --- |');
for (const r of rows) console.log(`| ${r.kind} | ${r.model} | ${r.status} | ${r.seconds} | ${r.detail.replace(/\|/g, '/')} |`);
process.exitCode = rows.every((r) => r.status === 'pass') ? 0 : 1;
