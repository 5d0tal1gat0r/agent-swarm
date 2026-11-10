import { envelopeFor, sendEnvelope } from './events.mjs';

// Operator actions on a stuck task: a person (or the owner's agent) resolves
// needs-human, replans escalated, or cancels. Each action needs a reason. The
// reason goes into the task history, so every human move is on record. The
// store checks the transition table; a wrong move throws and changes nothing.
export const OPERATOR_ACTIONS = ['resolve', 'replan', 'cancel'];

export function applyOperatorAction(store, { action, id, reason }) {
  if (!OPERATOR_ACTIONS.includes(action)) throw new Error(`unknown action ${action}; use one of: ${OPERATOR_ACTIONS.join(', ')}`);
  if (typeof reason !== 'string' || reason.trim().length < 3) throw new Error('a reason of at least 3 characters is required');
  const text = reason.trim().slice(0, 300);
  if (action === 'resolve') return store.resolve(id, text);
  if (action === 'replan') return store.replan(id, text);
  return store.cancel(id, text);
}

/**
 * Applies an operator action and announces the resulting store changes on the
 * bus (same mapping as publishEvents, text prefixed "operator <action>: ").
 * The CLI is a short-lived process, so the sends are awaited, but only up to
 * timeoutMs. A dead, slow or missing bus never changes the outcome: the store
 * change is already committed, a warning is logged and the task is returned.
 * A wrong action still throws before anything is sent.
 */
export async function applyAndAnnounce(store, bus, params, { timeoutMs = 5000, log = console } = {}) {
  const sends = [];
  const off = store.on('change', (change) => {
    if (!bus) return;
    try {
      const env = envelopeFor(change);
      if (env) sends.push(...sendEnvelope(bus, env, { log, prefix: `operator ${params.action}: ` }));
    } catch (err) {
      log.warn?.(`[operator] not announced: ${err.message}`);
    }
  });
  let task;
  try {
    task = applyOperatorAction(store, params);
  } finally {
    off();
  }
  if (sends.length) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const outcome = await Promise.race([Promise.all(sends).then(() => 'done'), timeout]);
    clearTimeout(timer);
    if (outcome === 'timeout') log.warn?.(`[operator] bus did not answer within ${timeoutMs} ms; the change is saved but may not be announced`);
  }
  return task;
}
