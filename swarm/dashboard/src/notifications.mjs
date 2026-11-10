export const NOTIFICATION_KINDS = [
  'task-needs-human', 'task-failed', 'pr-merged', 'epic-finished',
  'orchestrator-offline', 'orchestrator-online', 'chat-mention', 'chat-message', 'maintenance',
];
const TERMINAL_EPIC = new Set(['done', 'merged', 'cancelled', 'finished']);
const MAX_TEXT = 500;

const clean = (value, fallback = '') => String(value ?? fallback).replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
const taskMap = (snapshot) => new Map((snapshot?.tasks ?? []).filter((t) => t?.id).map((t) => [t.id, t]));
const epicMap = (snapshot) => new Map((snapshot?.epics ?? []).filter((e) => e?.id).map((e) => [e.id, e]));
const event = (id, kind, title, body, href, at, audience) => ({ id, kind, title: clean(title), body: clean(body), href, at: at ?? new Date().toISOString(), ...(audience ? { audience } : {}) });

export function deriveSnapshotNotifications(previous = {}, current = {}, { now = new Date().toISOString() } = {}) {
  const out = [];
  const oldTasks = taskMap(previous);
  for (const next of current.tasks ?? []) {
    if (!next?.id) continue;
    const old = oldTasks.get(next.id);
    if (next.status === 'needs-human' && old?.status !== next.status) out.push(event(`task-needs-human:${next.id}`, 'task-needs-human', 'Task needs a person', `${next.id}: ${next.title ?? 'Untitled'}`, `/?task=${encodeURIComponent(next.id)}`, now));
    if (next.status === 'failed' && old?.status !== next.status) out.push(event(`task-failed:${next.id}`, 'task-failed', 'Task failed', `${next.id}: ${next.title ?? 'Untitled'}`, `/?task=${encodeURIComponent(next.id)}`, now));
    if (next.status === 'merged' && old?.status !== next.status && next.pr != null) out.push(event(`pr-merged:${next.id}:${next.pr}`, 'pr-merged', 'Pull request merged', `${next.id}: ${next.title ?? 'Untitled'} (#${next.pr})`, `/?task=${encodeURIComponent(next.id)}`, now));
  }
  const oldEpics = epicMap(previous);
  for (const next of current.epics ?? []) {
    if (!next?.id || !TERMINAL_EPIC.has(next.status) || TERMINAL_EPIC.has(oldEpics.get(next.id)?.status)) continue;
    out.push(event(`epic-finished:${next.id}`, 'epic-finished', 'Epic finished', `${next.id}: ${next.title ?? 'Untitled'}`, `/?epic=${encodeURIComponent(next.id)}`, now));
  }
  if (previous.online === true && current.online === false) out.push(event('orchestrator-offline', 'orchestrator-offline', 'Orchestrator offline', 'The dashboard is showing the last known state.', '/'));
  if (previous.online === false && current.online === true) out.push(event('orchestrator-online', 'orchestrator-online', 'Orchestrator back online', 'Live swarm updates have resumed.', '/'));
  return out;
}

export function chatNotification(message, viewer, preferences = {}) {
  if (!message?.id || !viewer?.name || message.author === viewer.name) return null;
  const text = clean(message.text);
  const names = [viewer.name, viewer.member].filter(Boolean).map((name) => `@${name}`);
  const mention = names.some((name) => new RegExp(`(^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`, 'i').test(text));
  if (!mention && !preferences.channels?.includes(message.channel)) return null;
  const kind = mention ? 'chat-mention' : 'chat-message';
  return event(`chat:${kind}:${message.id}`, kind, mention ? 'You were mentioned' : `New message in #${message.channel}`, `${message.author}: ${text}`, `/chat#${encodeURIComponent(message.channel)}`, message.at, mention ? { users: [viewer.name, viewer.member].filter(Boolean) } : { channels: [message.channel] });
}

export function filterNotifications(events, viewer, preferences = {}) {
  const kinds = preferences.kinds ?? {};
  return events.filter((item) => {
    if (!NOTIFICATION_KINDS.includes(item?.kind) || kinds[item.kind] === false) return false;
    const users = item.audience?.users;
    const channels = item.audience?.channels;
    if (users && !users.includes(viewer?.name) && !users.includes(viewer?.member)) return false;
    if (channels && !channels.some((channel) => preferences.channels?.includes(channel))) return false;
    return true;
  });
}
