// Sleep log (ARCHITECTURE 70). The orchestrator and the manager run on the orchestrator machine,
// so a suspend freezes both. Timers resume late after a wake; a gap between two observations far
// longer than the timer interval is recorded as a sleep, and clock-time budgets subtract it.

const HOUR = 3600_000;

/**
 * gapMs: a gap longer than this between two observe() calls is a sleep (the loops tick every minute).
 * onSleep(gapMs, from, to): called once per detected sleep, for example to extend leases.
 */
export function createSleepLog({ gapMs = 3 * 60_000, keepMs = 24 * HOUR, onSleep = null } = {}) {
  const sleeps = []; // [{ from, to }] in ms, oldest first
  let lastAt = null;
  return {
    /** Records now; returns the gap in ms when it is a sleep, else 0. */
    observe(now) {
      const prev = lastAt;
      lastAt = Math.max(now, prev ?? now);
      if (prev === null || now - prev <= gapMs) return 0;
      sleeps.push({ from: prev, to: now });
      while (sleeps.length && sleeps[0].to < now - keepMs) sleeps.shift();
      onSleep?.(now - prev, prev, now);
      return now - prev;
    },
    intervals() {
      return sleeps.map((s) => ({ ...s }));
    },
  };
}

/** Pure: how much of [from, to] falls inside the recorded sleeps, in ms. */
export function sleptMs(sleeps, from, to) {
  let total = 0;
  for (const s of sleeps ?? []) total += Math.max(0, Math.min(to, s.to) - Math.max(from, s.from));
  return total;
}
