// Detail cards for the Graph page side panel (ARCHITECTURE 55): what a node is, what was done,
// who did it, what it affects, how long it took and what it cost. Pure: a graph node plus the
// bus data and orchestrator snapshot in, a plain card object out; renderCard() turns it into
// escaped HTML. Used by graph.js in the browser and by the tests.

import { epicStatus, taskLinks } from './graph.mjs';
import { esc, statusLabel } from './render.mjs';

const FINISHED = new Set(['merged', 'cancelled']);
const GOOD = new Set(['merged', 'done', 'online', 'idle']);
const BAD = new Set(['cancelled', 'failed', 'needs-human', 'escalated', 'offline']);
const BUSY = new Set(['leased', 'in_progress', 'submitted', 'in_review', 'changes_requested', 'busy']);
const toneOf = (status) => (GOOD.has(status) ? 'good' : BAD.has(status) ? 'bad' : BUSY.has(status) ? 'busy' : 'plain');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const listed = (items, max) => (items.length ? items.slice(0, max).join(', ') + (items.length > max ? `, +${items.length - max} more` : '') : '-');
const ms = (iso) => (iso ? Date.parse(String(iso).includes('T') ? iso : `${String(iso).replace(' ', 'T')}Z`) : NaN);

/** 45 s, 12 min, 1 h 28 min, 3 d 5 h. */
export function formatDuration(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const s = Math.max(0, Math.round(value / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Local date and time, short: 3 Nov 11:44. */
export function formatTime(iso) {
  const t = ms(iso);
  if (!Number.isFinite(t)) return '-';
  const d = new Date(t);
  const month = d.toLocaleString('en-GB', { month: 'short' });
  return `${d.getDate()} ${month} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The model a subagent ran, from the manager's last note ("... model claude-haiku-5-5"). */
export function modelOf(task) {
  return /\bmodel\s+([\w.:/]+-[\w.:/-]+)/.exec(String(task?.lastNote ?? ''))?.[1] ?? null;
}

/**
 * Timing from a task's history: waiting is created -> first lease, working is first lease ->
 * merged or cancelled (or now, while open). outcome is the reason of the last transition.
 */
export function taskTiming(history = [], now = Date.now()) {
  const steps = Array.isArray(history) ? history : [];
  if (!steps.length) return { createdAt: null, startedAt: null, endedAt: null, waitMs: null, workMs: null, outcome: null, steps: [] };
  const createdAt = steps[0].at ?? null;
  const startedAt = steps.find((h) => h.to === 'leased')?.at ?? null;
  const last = steps[steps.length - 1];
  const endedAt = FINISHED.has(last.to) ? last.at : null;
  const waitMs = startedAt ? ms(startedAt) - ms(createdAt) : (endedAt ? null : now - ms(createdAt));
  const workMs = startedAt ? (endedAt ? ms(endedAt) : now) - ms(startedAt) : null;
  return { createdAt, startedAt, endedAt, waitMs, workMs, outcome: last.reason ?? null, steps };
}

function tokenSum(tasks) {
  return tasks.reduce((acc, t) => ({ used: acc.used + (Number(t.usedTokens) || 0), budget: acc.budget + (Number(t.budget?.tokens) || 0) }), { used: 0, budget: 0 });
}

function statusCounts(tasks) {
  const counts = new Map();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  const order = ['merged', 'in_progress', 'leased', 'submitted', 'in_review', 'changes_requested', 'queued', 'blocked', 'needs-human', 'escalated', 'failed', 'cancelled'];
  return [...counts].sort(([a], [b]) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99).map(([status, count]) => ({ status, count }));
}
const taskItem = (t) => ({ meta: t.id, label: statusLabel(t.status), tone: toneOf(t.status), text: t.title ?? '' });
const countText = (counts, sep = ' · ') => counts.map((c) => `${c.count} ${statusLabel(c.status).toLowerCase()}`).join(sep);

/** First paragraph of an issue body as plain text. */
function firstParagraph(body) {
  const para = String(body ?? '').trim().split(/\n\s*\n/)[0] ?? '';
  return clip(para.replace(/[*_`#>]/g, '').replace(/\s*\n\s*/g, ' ').trim(), 400);
}

function taskCard(task, { snapshot, history, now }) {
  const epic = (snapshot?.epics ?? []).find((e) => e.id === task.epicId);
  const timing = taskTiming(history ?? [], now);
  const model = modelOf(task);
  const tags = [{ text: statusLabel(task.status), tone: toneOf(task.status) }];
  for (const t of [task.department, task.priority, task.size ? `size ${task.size}` : null, model]) if (t) tags.push({ text: t, tone: 'plain' });

  const parts = [];
  if (epic) parts.push(`Part of ${epic.id} ${epic.title ?? ''}.`.replace(' .', '.'));
  if (task.holder) parts.push(`Held by ${task.holder}${task.lastPhase ? `, last phase ${task.lastPhase}` : ''}.`);
  if (task.status === 'merged') parts.push(task.pr ? `Merged in PR #${task.pr}.` : 'Merged.');
  else if (FINISHED.has(task.status) || BAD.has(task.status)) parts.push(`${statusLabel(task.status)}${timing.outcome ? `: ${timing.outcome}` : ''}.`);
  else if (task.lastNote) parts.push(`Now: ${clip(task.lastNote, 160)}.`);
  if (task.status !== 'merged') parts.push(task.pr ? `PR #${task.pr} open.` : 'No pull request yet.');

  const time = timing.createdAt
    ? `created ${formatTime(timing.createdAt)} · waited ${formatDuration(timing.waitMs)}${timing.startedAt ? ` · worked ${formatDuration(timing.workMs)}${timing.endedAt ? '' : ' so far'}` : ''}`
    : `created ${formatTime(task.createdAt)} · updated ${formatTime(task.updatedAt)}`;
  const facts = [
    ['Who', task.holder ?? 'nobody yet'],
    ['Affects', (task.paths ?? []).join(', ') || '-'],
    ['Depends on', (task.dependsOn ?? []).join(', ') || '-'],
    ['Time', time],
    ['Attempts', String(task.attempts ?? 0)],
  ];
  if (task.branch) facts.push(['Branch', task.branch]);
  if (task.budget?.minutes) facts.push(['Time budget', `${task.budget.minutes} min`]);

  const sections = [];
  if (task.acceptance?.length) sections.push({ title: 'Acceptance', items: task.acceptance.map(String) });
  if (timing.steps.length) sections.push({ title: 'Timeline', items: timing.steps.map((h) => ({ meta: formatTime(h.at), label: statusLabel(h.to), tone: toneOf(h.to), text: h.reason ? clip(h.reason, 140) : '' })) });
  const { prUrl, controlRoomUrl } = taskLinks(task);
  const links = [{ href: controlRoomUrl, text: 'Open in control room' }];
  if (prUrl) links.push({ href: prUrl, text: `Pull request #${task.pr}` });
  return { title: `${task.id} ${task.title ?? ''}`.trim(), kind: 'task', tags, summary: parts.join(' '), facts,
    tokens: { used: Number(task.usedTokens) || 0, budget: Number(task.budget?.tokens) || 0 }, sections, links, needsHistory: history == null };
}

function epicCard(epic, { snapshot }) {
  const tasks = (snapshot?.tasks ?? []).filter((t) => t.epicId === epic.id);
  const status = epicStatus(epic, snapshot?.tasks ?? []);
  const tags = [{ text: status, tone: status === 'done' ? 'good' : toneOf(status) }];
  if (epic.issue) tags.push({ text: `issue #${epic.issue}`, tone: 'plain' });
  if (epic.source) tags.push({ text: epic.source, tone: 'plain' });
  const counts = statusCounts(tasks);
  const holders = [...new Set(tasks.map((t) => t.holder).filter(Boolean))];
  const paths = [...new Set(tasks.flatMap((t) => t.paths ?? []))];
  const starts = tasks.map((t) => ms(t.createdAt)).filter(Number.isFinite);
  const ends = tasks.map((t) => ms(t.updatedAt)).filter(Number.isFinite);
  const facts = [
    ['Progress', tasks.length ? `${countText(counts)} of ${plural(tasks.length, 'task')}` : 'not planned yet'],
    ['Who', holders.join(', ') || '-'],
    ['Affects', listed(paths, 8)],
    ['Time', starts.length ? `${formatTime(new Date(Math.min(...starts)).toISOString())} → ${formatTime(new Date(Math.max(...ends)).toISOString())}` : `created ${formatTime(epic.createdAt)}`],
  ];
  const links = [];
  if (epic.issue && /^[\w.-]+\/[\w.-]+$/.test(epic.repo ?? '')) links.push({ href: `https://github.com/${epic.repo}/issues/${epic.issue}`, text: `Issue #${epic.issue}` });
  return { title: `${epic.id} ${epic.title ?? ''}`.trim(), kind: 'epic', tags, summary: firstParagraph(epic.body) || 'No description.', facts,
    tokens: tokenSum(tasks), progress: counts,
    sections: tasks.length ? [{ title: 'Tasks', items: tasks.map(taskItem) }] : [], links };
}

function managerCard(m, { snapshot }) {
  const tasks = (snapshot?.tasks ?? []).filter((t) => t.holder === m.name);
  const counts = statusCounts(tasks);
  const tags = [{ text: m.state ?? 'unknown', tone: toneOf(m.state) }];
  if (m.member) tags.push({ text: `member ${m.member}`, tone: 'plain' });
  const facts = [
    ['Departments', (m.departments ?? []).join(', ') || '-'],
    ['Free slots', m.freeSlots ?? '-'],
    ['Running', (m.running ?? []).map((r) => (typeof r === 'string' ? r : r.taskId ?? r.id ?? '?')).join(', ') || 'nothing'],
    ['Last heartbeat', m.lastHeartbeat ? formatTime(new Date(m.lastHeartbeat).toISOString()) : '-'],
  ];
  return { title: m.name, kind: 'manager', tags, facts,
    summary: tasks.length ? `Holds ${plural(tasks.length, 'task')}: ${countText(counts, ', ')}.` : 'Has held no tasks.',
    tokens: tasks.length ? tokenSum(tasks) : null,
    sections: tasks.length ? [{ title: 'Tasks held', items: tasks.map(taskItem) }] : [], links: [] };
}

function departmentCard(id, { snapshot }) {
  const info = (snapshot?.departmentInfo ?? []).find((d) => d.id === id) ?? {};
  const tasks = (snapshot?.tasks ?? []).filter((t) => t.department === id);
  const managers = (snapshot?.managers ?? []).filter((m) => (m.departments ?? []).includes(id));
  const counts = statusCounts(tasks);
  const tags = [];
  if (info.agent) tags.push({ text: info.agent, tone: 'plain' });
  if (!managers.some((m) => m.state && m.state !== 'offline')) tags.push({ text: 'no manager online', tone: 'bad' });
  const facts = [
    ['Agent', info.agent ?? '-'],
    ['Owns paths', (info.paths ?? []).join(', ') || '-'],
    ['Managers', managers.map((m) => `${m.name} (${m.state ?? '?'})`).join(', ') || 'none'],
    ['Concurrency', info.concurrency ?? '-'],
  ];
  if (info.host) facts.push(['Host', info.host]);
  return { title: id, kind: 'department', tags, facts,
    summary: tasks.length ? `${plural(tasks.length, 'task')}: ${countText(counts, ', ')}.` : 'No tasks yet.',
    tokens: tasks.length ? tokenSum(tasks) : null, progress: counts,
    sections: tasks.length ? [{ title: 'Tasks', items: tasks.map(taskItem) }] : [], links: [] };
}

function agentCard(node, { graph, bus, snapshot, now }) {
  const agent = (bus?.agents ?? []).find((a) => `agent:${a.name}` === node.id) ?? {};
  const perChannel = new Map();
  const mine = [];
  for (const [ch, msgs] of Object.entries(bus?.messages ?? {})) {
    for (const m of msgs ?? []) {
      if (m.from_agent !== agent.id) continue;
      perChannel.set(ch, (perChannel.get(ch) ?? 0) + 1);
      mine.push({ ch, m });
    }
  }
  mine.sort((a, b) => (b.m.id ?? 0) - (a.m.id ?? 0));
  const wrote = graph.edges.filter((e) => e.a === node.id && e.kind === 'wrote').length;
  const parts = [];
  if (agent.status_text) parts.push(`${agent.status_text}.`.replace(/\.\.$/, '.'));
  const total = mine.length;
  parts.push(total ? `Wrote ${plural(total, 'message')} in ${[...perChannel].sort((a, b) => b[1] - a[1]).map(([ch, n]) => `#${ch}${perChannel.size > 1 ? ` (${n})` : ''}`).join(', ')}.` : 'No messages on record.');
  if (wrote) parts.push(`Last wrote ${plural(wrote, 'memory key')}.`);
  const held = (snapshot?.tasks ?? []).filter((t) => t.holder === agent.name);
  if (held.length) parts.push(`Also manager: holds ${plural(held.length, 'task')} (${countText(statusCounts(held), ', ')}).`);
  const seen = ms(agent.last_heartbeat);
  return { title: agent.name ?? node.label, kind: 'agent', tags: [{ text: agent.status ?? 'unknown', tone: toneOf(agent.status) }], summary: parts.join(' '),
    facts: [['Last seen', Number.isFinite(seen) ? `${formatTime(agent.last_heartbeat)} (${formatDuration(now - seen)} ago)` : '-']],
    tokens: held.length ? tokenSum(held) : null,
    sections: mine.length ? [{ title: 'Recent messages', items: mine.slice(0, 6).map(({ ch, m }) => ({ meta: `${formatTime(m.created_at)} #${ch}`, text: clip(m.content, 160) })) }] : [], links: [] };
}

function channelCard(node, { bus }) {
  const name = node.id.slice('channel:'.length);
  const msgs = bus?.messages?.[name] ?? [];
  const names = new Map((bus?.agents ?? []).map((a) => [a.id, a.name]));
  const posters = new Map();
  for (const m of msgs) { const who = names.get(m.from_agent) ?? String(m.from_agent).slice(0, 8); posters.set(who, (posters.get(who) ?? 0) + 1); }
  const top = [...posters].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const last = msgs[msgs.length - 1];
  const desc = node.meta.description ?? (bus?.channels ?? []).find((c) => c.name === name)?.description;
  const summary = [desc ? `${desc}.`.replace(/\.\.$/, '.') : null,
    msgs.length ? `${plural(msgs.length, 'message')} from ${plural(posters.size, 'agent')}; last ${formatTime(last.created_at)}.` : 'No messages on record.'].filter(Boolean).join(' ');
  return { title: node.label, kind: 'channel', tags: [], summary,
    facts: [['Top posters', top.map(([who, n]) => `${who} ×${n}`).join(', ') || '-']], tokens: null,
    sections: msgs.length ? [{ title: 'Recent', items: msgs.slice(-8).reverse().map((m) => ({ meta: `${formatTime(m.created_at)} ${names.get(m.from_agent) ?? '?'}`, text: clip(m.content, 160) })) }] : [], links: [] };
}

function memoryCard(node, { graph }) {
  const writer = graph.edges.find((e) => e.b === node.id && e.kind === 'wrote')?.a;
  const writerLabel = writer ? graph.nodes.find((n) => n.id === writer)?.label ?? writer : 'unknown';
  const { namespace, value, updatedAt, expiresAt } = node.meta;
  const tags = [{ text: `${namespace}/`, tone: 'plain' }];
  if (namespace === 'locks') tags.push({ text: 'lock', tone: 'busy' });
  const facts = [['Value', clip(value ?? '', 200) || '-'], ['Written by', writerLabel], ['Updated', formatTime(updatedAt)]];
  if (expiresAt) facts.push(['Expires', formatTime(expiresAt)]);
  return { title: node.label, kind: 'memory', tags,
    summary: namespace === 'locks' ? `${value} holds the lock on ${node.label}.` : `Shared state key in ${namespace}/, last written by ${writerLabel}.`,
    facts, tokens: null, sections: [], links: [] };
}

function namespaceCard(node, { graph }) {
  const keys = graph.edges.filter((e) => e.a === node.id && e.kind === 'holds').map((e) => graph.nodes.find((n) => n.id === e.b)?.label ?? e.b);
  return { title: node.label, kind: 'namespace', tags: [], summary: `${plural(keys.length, 'key')} in shared state.`, facts: [], tokens: null,
    sections: keys.length ? [{ title: 'Keys', items: keys.slice(0, 30) }] : [], links: [] };
}

/**
 * The card for one graph node. ctx: { graph, bus, snapshot, history?, now? }; history is the
 * task's history from /api/history/:id (null while not fetched: card.needsHistory is then true).
 */
export function nodeCard(node, ctx = {}) {
  if (!node) return null;
  const c = { graph: { nodes: [], edges: [] }, bus: {}, snapshot: null, history: null, now: Date.now(), ...ctx };
  const tasks = c.snapshot?.tasks ?? [];
  const key = node.id.slice(node.id.indexOf(':') + 1);
  switch (node.type) {
    case 'task': { const t = tasks.find((x) => x.id === key); if (t) return taskCard(t, c); break; }
    case 'epic': { const e = (c.snapshot?.epics ?? []).find((x) => x.id === key); if (e) return epicCard(e, c); break; }
    case 'manager': { const m = (c.snapshot?.managers ?? []).find((x) => x.name === key); if (m) return managerCard(m, c); break; }
    case 'department': return departmentCard(key, c);
    case 'agent': return agentCard(node, c);
    case 'channel': return channelCard(node, c);
    case 'memory': return memoryCard(node, c);
    case 'namespace': return namespaceCard(node, c);
    default: break;
  }
  return { title: node.label, kind: node.type, tags: [], summary: '', facts: Object.entries(node.meta ?? {}).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)]), tokens: null, sections: [], links: [] };
}

const safeHref = (href) => (/^(https:\/\/|\/(?!\/))/.test(String(href)) ? String(href) : null);
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');

const CLOSE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';
const OPEN_BY_DEFAULT = new Set(['Recent', 'Recent messages', 'Tasks', 'Tasks held', 'Acceptance']);
const pill = (text, tone = 'plain') => `<span class="st g-tone-${esc(tone)}">${esc(text)}</span>`;
const itemHtml = (i) => (typeof i === 'string' ? `<li class="g-bullet">${esc(i)}</li>`
  : `<li class="g-item"><span class="g-item-meta">${esc(i.meta ?? '')}</span>${i.label ? pill(i.label, i.tone) : ''}${i.text ? `<span class="g-item-text">${esc(i.text)}</span>` : ''}</li>`);

/**
 * Escaped HTML for a card: a main column (header, summary, facts, links) and a side column
 * (folding sections, then options.side, trusted HTML from the caller). Only https and
 * same-site links are kept.
 */
export function renderCard(card, { side = '' } = {}) {
  if (!card) return '<p class="mut">No node selected.</p>';
  const tags = (card.tags ?? []).map((t) => pill(t.text, t.tone)).join('');
  let html = '<div class="g-card-main"><header class="g-card-head"><div class="g-card-titles">'
    + `<h2>${esc(card.title)}</h2><p class="g-meta"><span class="g-kind">${esc(card.kind)}</span>${tags}</p></div>`
    + `<button type="button" class="act g-close" data-close aria-label="Close details">${CLOSE_ICON}</button></header>`;
  if (card.summary) html += `<p class="g-summary">${esc(card.summary)}</p>`;
  if (card.progress?.length) {
    const total = card.progress.reduce((n, p) => n + p.count, 0);
    html += `<div class="g-progress" role="img" aria-label="${esc(card.progress.map((p) => `${p.count} ${p.status}`).join(', '))}">${card.progress.map((p) => `<span class="g-fill-${esc(toneOf(p.status))}" data-flex="${(p.count / total).toFixed(3)}"></span>`).join('')}</div>`;
  }
  html += '<dl class="g-facts">';
  for (const [k, v] of card.facts ?? []) html += `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`;
  if (card.tokens) {
    const { used, budget } = card.tokens;
    const pct = budget > 0 ? Math.min(100, Math.round((used / budget) * 100)) : 0;
    html += `<dt>Tokens</dt><dd><span class="g-num">${esc(fmt(used))}</span>${budget ? ` <span class="mut">of ${esc(fmt(budget))} · ${pct}%</span>` : ''}`
      + (budget ? `<span class="g-bar" role="meter" aria-label="Tokens used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span data-w="${pct}"></span></span>` : '') + '</dd>';
  }
  html += '</dl>';
  const links = (card.links ?? []).map((l) => ({ ...l, href: safeHref(l.href) })).filter((l) => l.href);
  if (links.length) html += `<p class="g-card-links">${links.map((l) => `<a class="act" href="${esc(l.href)}"${l.href.startsWith('https://') ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(l.text)} ↗</a>`).join('')}</p>`;
  if (card.needsHistory) html += '<p class="mut g-loading">Loading timeline…</p>';
  html += '</div><div class="g-card-side">';
  for (const sec of card.sections ?? []) {
    html += `<details class="g-section"${OPEN_BY_DEFAULT.has(sec.title) ? ' open' : ''}><summary><span>${esc(sec.title)}</span><span class="g-count">${sec.items.length}</span></summary><ul class="plain">${sec.items.map(itemHtml).join('')}</ul></details>`;
  }
  return `${html}${side}</div>`;
}
