// Maintenance banner state (ARCHITECTURE 77). Pure, so node tests and every page share it; maint.js draws it.

const hhmm = (iso, timeZone) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

/** { kind: 'on' | 'overrun' | 'down', text } for the banner, or null when there is nothing to show. */
export function bannerState({ reachable, maintenance }, { timeZone } = {}) {
  if (!reachable) return { kind: 'down', text: 'Dashboard restarting… this page reloads when it is back.' };
  if (!maintenance) return null;
  const at = hhmm(maintenance.since, timeZone);
  if (maintenance.overrun) return { kind: 'overrun', text: `Maintenance overrun: ${maintenance.reason} · since ${at} · longer than 30 min, check swarmctl status` };
  return { kind: 'on', text: `Maintenance: ${maintenance.reason} · since ${at} · actions are paused` };
}

/** After one /health probe: reload the page when the server answers again after being unreachable (new code). */
export const nextProbe = ({ wasDown }, reachable) => ({ wasDown: !reachable, reload: wasDown && reachable });
