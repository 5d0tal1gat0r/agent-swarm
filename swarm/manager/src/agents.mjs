// Agent adapters. An agent runs inside a task's worktree and returns evidence
// for each acceptance criterion. M3 ships two adapters:
//  - fakeAgent: an in-process function for tests (CI makes no model calls);
//  - commandAgent: runs a fixed command in the sandbox container. Its evidence
//    is a placeholder (exit 0 = met). The model criteria gate arrives in M4.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { buildRunArgs, runContainer, writeEnvFile } from '../../shared/sandbox.mjs';

const run = promisify(execFile);

export function fakeAgent(edit) {
  return async ({ task, worktree }) => {
    const out = await edit({ task, worktree });
    return {
      tokens: out?.tokens ?? 0,
      evidence: task.acceptance.map((criterion) => ({ criterion, met: true, detail: 'fake agent' })),
    };
  };
}

/** Checks that run in the worktree (no container). args: [command, ...args]. */
export function commandChecks(args, { timeoutMs = 10 * 60_000 } = {}) {
  return async (dir) => {
    try {
      const { stdout, stderr } = await run(args[0], args.slice(1), { cwd: dir, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
      return { ok: true, summary: `${args.join(' ')} passed ${stdout.length + stderr.length} bytes of output` };
    } catch (err) {
      const tail = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim().split('\n').slice(-5).join(' | ');
      return { ok: false, summary: `${args.join(' ')} failed: ${tail || err.message}` };
    }
  };
}

export function commandAgent({ runtime = 'docker', image, command, stateDir, managerName, uid, gid, timeoutMinutes = 30, spawnFn }) {
  return async ({ task, worktree }) => {
    const envFile = writeEnvFile(path.join(stateDir, `env-${task.id}`), { TASK_ID: task.id, MANAGER: managerName });
    const args = buildRunArgs({ runtime, name: `swarm-${task.id.toLowerCase()}-${Date.now()}`, worktreeDir: worktree, envFile, image, uid, gid });
    const name = args[args.indexOf('--name') + 1];
    const idx = args.indexOf(image);
    args.splice(idx + 1, 0, ...command);
    const result = await runContainer(args, { runtime, name, logFile: path.join(stateDir, 'logs', `${task.id}.log`), timeoutMs: timeoutMinutes * 60_000, spawnFn });
    if (!result.ok) throw new Error(`agent command failed (exit ${result.code}${result.timedOut ? ', time limit' : ''})`);
    return { tokens: 0, evidence: task.acceptance.map((criterion) => ({ criterion, met: true, detail: `exit 0 in ${image}` })) };
  };
}
