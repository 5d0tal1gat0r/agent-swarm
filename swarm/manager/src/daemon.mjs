// The manager's loop. Runs up to `concurrency` tasks at once, leasing from its
// departments in order (each lease returns that department's fix work first),
// each department capped by its own `concurrency`. A leased task whose paths
// overlap a running task is released back to the queue (no attempt spent) and
// the tick stops leasing. Heartbeats on every tick. Every `cleanupEveryTicks`
// ticks (from the first) it runs `cleanup` with the running task ids to skip.
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { overlaps } from '../../shared/globs.mjs';

export const DEFAULT_MACHINE_SLOTS = 3;
export const DEFAULT_SLOT_DIR = path.join(os.homedir(), '.swarm', 'slots');

const activeSlotPaths = new Set();
let exitCleanupInstalled = false;

function installExitCleanup() {
  if (exitCleanupInstalled) return;
  exitCleanupInstalled = true;
  process.once('exit', () => {
    for (const slotPath of activeSlotPaths) {
      try { unlinkSync(slotPath); } catch (err) { if (err.code !== 'ENOENT') { /* best effort during exit */ } }
    }
    activeSlotPaths.clear();
  });
}

function slotOwnerAlive(slotPath) {
  let owner;
  try {
    owner = JSON.parse(readFileSync(slotPath, 'utf8'));
  } catch {
    return false;
  }
  if (!Number.isInteger(owner?.pid) || owner.pid < 1) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function createMachineSlotLock({ dir = DEFAULT_SLOT_DIR, maxSlots = DEFAULT_MACHINE_SLOTS, manager = 'unknown' } = {}) {
  const slotCount = Math.max(1, Math.floor(Number(maxSlots) || DEFAULT_MACHINE_SLOTS));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  installExitCleanup();

  return {
    acquire() {
      for (let index = 0; index < slotCount; index += 1) {
        const slotPath = path.join(dir, `slot-${index}.lock`);
        let fd;
        try {
          fd = openSync(slotPath, 'wx', 0o600);
          writeFileSync(fd, `${JSON.stringify({ pid: process.pid, manager, acquiredAt: Date.now() })}\n`);
          closeSync(fd);
          activeSlotPaths.add(slotPath);
          let released = false;
          return {
            path: slotPath,
            release() {
              if (released) return;
              released = true;
              try { unlinkSync(slotPath); } catch (err) { if (err.code !== 'ENOENT') throw err; }
              activeSlotPaths.delete(slotPath);
            },
          };
        } catch (err) {
          if (fd !== undefined) {
            try { closeSync(fd); } catch { /* the open failed or was already closed */ }
          }
          if (err.code !== 'EEXIST') throw err;
          if (slotOwnerAlive(slotPath)) continue;
          try { unlinkSync(slotPath); } catch (unlinkErr) { if (unlinkErr.code !== 'ENOENT') throw unlinkErr; }
          index -= 1; // retry this slot after reclaiming its dead owner
        }
      }
      return null;
    },
  };
}

export function tasksOverlap(a, b) {
  return a.paths.some((p) => b.paths.some((q) => {
    try {
      return overlaps(p, q);
    } catch {
      return true; // a glob we cannot read is treated as a clash
    }
  }));
}

export function createDaemon({ client, manager, agentKind, department, departments = null, departmentConcurrency = {}, runTask = null, concurrency = 1, version = '0.1.0', heartbeatMs = 60_000, log = console, slotDir = DEFAULT_SLOT_DIR, maxMachineSlots = DEFAULT_MACHINE_SLOTS, cleanup = null, cleanupEveryTicks = 10, directiveJournal = null }) {
  const depts = departments ?? [department];
  if (!Array.isArray(depts) || depts.length === 0 || depts.some((d) => !d)) throw new Error('createDaemon needs department or departments');
  const running = new Map(); // task id -> { task, department, promise }
  const runningIn = (dept) => [...running.values()].filter((r) => r.department === dept).length;
  const capOf = (dept) => departmentConcurrency[dept] ?? Infinity;
  const machineSlots = createMachineSlotLock({ dir: slotDir, maxSlots: maxMachineSlots, manager });
  let beatTimer = null;
  let ticks = 0;

  // While tasks run, heartbeat on a timer: the orchestrator renews their leases on each beat.
  function beat() {
    return client.heartbeat({ manager, agent: agentKind, version, freeSlots: daemon.concurrency - running.size, running: [...running.keys()] });
  }
  function ensureBeating() {
    if (beatTimer) return;
    beatTimer = setInterval(() => beat().catch((err) => log.warn?.(`[daemon] heartbeat failed: ${err.message}`)), heartbeatMs);
    beatTimer.unref?.();
  }
  function stopBeatingIfIdle() {
    if (running.size === 0 && beatTimer) {
      clearInterval(beatTimer);
      beatTimer = null;
    }
  }

  function releaseMachineSlot(slot) {
    try { slot.release(); } catch (err) { log.warn?.(`[daemon] machine slot release failed: ${err.message}`); }
  }

  function start(task, slot, dept) {
    const promise = Promise.resolve()
      .then(() => daemon.runTask(task))
      .then((result) => ({ id: task.id, result }), (err) => ({ id: task.id, error: err.message }))
      .finally(() => {
        running.delete(task.id);
        releaseMachineSlot(slot);
      });
    running.set(task.id, { task, department: dept, promise });
    ensureBeating();
    promise.finally(stopBeatingIfIdle);
    return promise;
  }

  const daemon = {
    runTask,
    running,
    concurrency,
    departments: depts,
    log,

    /** Starts tasks up to the free slots. Does not wait for them. */
    async tick() {
      await beat();
      if (directiveJournal) {
        try { await directiveJournal.poll(); } catch (err) { log.warn?.(`[daemon] directive poll failed: ${err.message}`); }
      }
      if (cleanup && ticks++ % Math.max(1, cleanupEveryTicks) === 0) {
        try {
          await cleanup({ skip: new Set(running.keys()) });
        } catch (err) {
          log.warn?.(`[daemon] worktree cleanup failed: ${err.message}`);
        }
      }
      const started = [];
      const pending = [];
      leasing: for (const dept of depts) {
        while (running.size < this.concurrency && runningIn(dept) < capOf(dept)) {
          const slot = machineSlots.acquire();
          if (!slot) break leasing;
          let task;
          try {
            [task] = await client.lease({ manager, department: dept, slots: 1 });
          } catch (err) {
            releaseMachineSlot(slot);
            throw err;
          }
          if (!task) {
            releaseMachineSlot(slot);
            break; // this department is empty: try the next one
          }
          const clash = [...running.values()].find((r) => tasksOverlap(r.task, task));
          if (clash) {
            try {
              await client.release(task.id, { manager, reason: `paths overlap running ${clash.task.id}` });
            } finally {
              releaseMachineSlot(slot);
            }
            break leasing;
          }
          started.push(task.id);
          pending.push(start(task, slot, dept));
        }
      }
      return { started, pending };
    },

    /** One tick, then wait for what it started. Used by `once` and tests. */
    async runOnce() {
      const { started, pending } = await this.tick();
      const results = await Promise.all(pending);
      return { leased: started[0] ?? null, result: results[0]?.result ?? null, results };
    },

    /** The task the next lease would take: the head of the first non-empty department queue. */
    async dryRun() {
      for (const dept of depts) {
        const queue = await client.queue(dept);
        if (queue.length) return queue.slice(0, 1).map((t) => ({ id: t.id, department: dept, title: t.title, priority: t.priority, paths: t.paths }));
      }
      return [];
    },
  };
  return daemon;
}
