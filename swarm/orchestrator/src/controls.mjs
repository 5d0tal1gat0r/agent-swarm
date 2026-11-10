// Operator controls for the dashboard (ARCHITECTURE 48). Who may do what:
//  - `owner` role: every action.
//  - any `manager` token: actions on its own member's managers, and on tasks those managers hold;
//    creating an epic.
//  - `dashboard` and `intake` tokens: no control actions.
// Department and manager pauses live in the store (meta key below), so they survive a restart and
// a move (swarmctl export). The global pause stays in bus state swarm/paused (guard.mjs).

export const PAUSES_KEY = 'controls.pauses';

const isOwner = (who) => who.roles.includes('owner');

/** Member of the token that holds the task, or null. */
function memberOf(tokens, managerName) {
  return tokens.managers?.[managerName]?.member ?? null;
}

export function canActOnTask(who, task, tokens) {
  if (isOwner(who)) return true;
  if (!who.roles.includes('manager') || !task.holder) return false;
  return memberOf(tokens, task.holder) === who.member;
}

export function canActOnManager(who, managerName, tokens) {
  if (isOwner(who)) return true;
  return who.roles.includes('manager') && memberOf(tokens, managerName) === who.member;
}

/** { departments: { id: {reason, by, at} }, managers: { name: {reason, by, at} } } */
export function readPauses(store) {
  try {
    const v = JSON.parse(store.getMeta(PAUSES_KEY) ?? '{}');
    return { departments: v.departments ?? {}, managers: v.managers ?? {} };
  } catch {
    return { departments: {}, managers: {} };
  }
}

/** kind: 'departments' | 'managers'. record null clears the pause. */
export function writePause(store, kind, name, record) {
  const p = readPauses(store);
  if (record) p[kind][name] = record;
  else delete p[kind][name];
  store.setMeta(PAUSES_KEY, JSON.stringify(p));
  return p;
}

/** Why this manager may not lease this department now, or null. */
export function leaseBlock(store, { manager, department }) {
  const p = readPauses(store);
  if (p.managers[manager]) return `manager ${manager} paused: ${p.managers[manager].reason}`;
  if (p.departments[department]) return `department ${department} paused: ${p.departments[department].reason}`;
  return null;
}

/** A reason of 3 to 300 characters, trimmed, on one line; null when missing. */
export function reasonOf(body) {
  const r = typeof body?.reason === 'string' ? body.reason.replace(/\s+/g, ' ').trim() : '';
  return r.length >= 3 ? r.slice(0, 300) : null;
}
