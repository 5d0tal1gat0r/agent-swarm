// Idle wait for the manager loop, when the manager has a bus URL. It sleeps
// pollSeconds but wakes early on a "dispatch:" direct message from the orchestrator,
// and it tells the orchestrator "ready" when the manager goes idle. A spoofed
// "dispatch:" only makes the manager ask for a lease early; the lease API decides.
export const ORCHESTRATOR_NAME = 'swarm-orchestrator';

export function createWaker({ bus, orchestrator = ORCHESTRATOR_NAME, checkMs = 5000, sleepMs, now = Date.now }) {
  let lastId = null;

  /** True when a dispatch message arrived since the last read. The first read only records the newest id. */
  async function dispatched() {
    let msgs;
    try {
      msgs = await bus.inbox({ limit: 50 });
    } catch {
      return false; // a bad read counts as no dispatch
    }
    if (!Array.isArray(msgs)) return false;
    const hit = lastId !== null && msgs.some((m) => m.id > lastId && m.to_agent && /^dispatch:/.test(m.content));
    lastId = msgs.reduce((n, m) => Math.max(n, m.id), lastId ?? 0);
    return hit;
  }

  return {
    ready(freeSlots) {
      return bus.direct(orchestrator, `ready free ${freeSlots}`);
    },
    /** Waits up to `seconds`. Returns true when woken by a dispatch message. */
    async wait(seconds) {
      if (lastId === null) await dispatched();
      const end = now() + seconds * 1000;
      while (now() < end) {
        await sleepMs(Math.min(checkMs, end - now()));
        if (await dispatched()) return true;
      }
      return false;
    },
  };
}
