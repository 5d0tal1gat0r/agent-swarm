// Publishes store changes to the bus. Fire-and-forget: a dead bus never
// changes store state (the spec: "If the bus is down, the swarm keeps working").
import { validate } from '../../protocol/validate.mjs';

// Store transition (from -> to) to bus event type. Unlisted moves publish nothing.
export function eventTypeFor(from, to) {
  // `from` is kept for callers; the mapping depends on the target state only.
  if (to === 'queued') return 'task.queued';
  if (to === 'leased') return 'task.leased';
  if (to === 'in_progress') return 'task.progress';
  if (to === 'submitted') return 'task.submitted';
  if (to === 'merged') return 'task.merged';
  if (to === 'failed') return 'task.failed';
  if (to === 'escalated') return 'task.escalated';
  if (to === 'cancelled') return 'task.cancelled';
  if (to === 'changes_requested') return 'review.changes_requested';
  return null;
}

/** Store change event -> validated bus envelope, or null when nothing is published. */
export function envelopeFor(change) {
  const type = eventTypeFor(change.from, change.to);
  if (!type) return null;
  const env = {
    type,
    at: change.at,
    taskId: change.taskId,
    department: change.department,
    data: { from: change.from, to: change.to, reason: change.reason },
  };
  const check = validate('events/event', env);
  if (!check.ok) throw new Error(`bad event ${type}: ${check.errors.join('; ')}`);
  return env;
}

/** The main swarm channel. Bus channel names are lowercase, with no `#`. */
export const SWARM_CHANNEL = 'swarm';

const CHANNEL_NAME = /^[a-z0-9._-]{2,64}$/;

/** The bus rule: 2-64 characters of a-z, 0-9, `.`, `_`, `-`. */
export function isValidChannelName(name) {
  return typeof name === 'string' && CHANNEL_NAME.test(name);
}

export function deptChannel(department) {
  return `dept-${department}`;
}

/** Every channel the swarm posts to, for bus registration. */
export function allChannels(departmentIds) {
  return [SWARM_CHANNEL, ...departmentIds.map(deptChannel)];
}

export function channelsFor(department) {
  return [SWARM_CHANNEL, deptChannel(department)];
}

/** One-line bus text for an envelope. `prefix` marks operator actions. */
export function textFor(env, prefix = '') {
  return `${prefix}${env.type} ${env.taskId} (${env.department}): ${env.data.from} -> ${env.data.to}${env.data.reason ? ` - ${env.data.reason}` : ''}`;
}

const warnedChannels = new Set();

/** Sends an envelope to its registered channels (all of them when the bus has no channel set). Returns one promise per channel; none rejects. */
export function sendEnvelope(bus, env, { log = console, prefix = '' } = {}) {
  const text = textFor(env, prefix);
  const registered = typeof bus.hasChannel === 'function' ? (c) => bus.hasChannel(c) : () => true;
  const channels = channelsFor(env.department).filter((channel) => {
    if (registered(channel)) return true;
    if (!warnedChannels.has(channel)) {
      warnedChannels.add(channel);
      log.warn?.(`[events] ${channel} is not a registered bus channel; skipping`);
    }
    return false;
  });
  return channels.map((channel) =>
    Promise.resolve()
      .then(() => bus.send(channel, text))
      .catch((err) => log.warn?.(`[events] ${channel} not sent: ${err.message}`)));
}

/** Subscribes the bus to a store. Returns an unsubscribe function. */
export function publishEvents(store, bus, { log = console } = {}) {
  return store.on('change', (change) => {
    const env = envelopeFor(change);
    if (!env) return;
    sendEnvelope(bus, env, { log });
  });
}
