// Browser side of the server dashboard. Authentication uses the HttpOnly session cookie.
import { describeAction, filterOptions, filterTasks, findingOf, renderAlerts, renderBanner, renderControls, renderDepartments, renderEpics, renderManagers, renderMetrics, renderPipeline, renderPlan, renderService, renderTaskDetail, renderTasks, renderTopology, renderTopologyTree, statusLabel, viewerContext } from '/render.mjs';
import { watchBars } from '/bars.mjs';
import { amendRequest, renderFixForm } from '/fix.mjs';

const $ = (id) => document.getElementById(id);
const filters = { status: '', department: '', epic: '' };
let last = null;
let timer = null;
let frame = 0;
let selected = null;
let alertsExpanded = false;
let notificationSource = null;
let notificationPrefs = null;
let notificationLastId = '';
let notificationUnread = 0;
const still = window.matchMedia('(prefers-reduced-motion: reduce)');
const narrow = window.matchMedia('(max-width: 880px)');
// The wide diagram needs about 88 columns (about 740px at 14px); narrower screens get the tree.
const topology = (snap, f, online) => (narrow.matches ? renderTopologyTree : renderTopology)(snap, f, online);
// The topology is redrawn for its live packet phase. Keep the current node mounted while
// the pointer is over it, otherwise the hover transition restarts every 333ms and flickers.
const topologyHovered = () => document.querySelector('#topology .topology-manager-card:hover, #topology .topology-subagent:hover, #topology .topology-tree-manager:hover, #topology .topology-tree-subagent:hover, #topology .topology-dept-chip:hover, #topology .topology-gap:hover');

// Password sign-in (ARCHITECTURE 54): the session is an HttpOnly cookie the page never sees.
async function api(path, body) {
  const init = { cache: 'no-store', credentials: 'same-origin' };
  if (body !== undefined) Object.assign(init, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const res = await fetch(path, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function fillSelect(id, values, label = (value) => value) {
  const sel = $(id);
  const current = sel.value;
  sel.replaceChildren(new Option('All', ''), ...values.map((v) => new Option(label(v), v)));
  sel.value = values.includes(current) ? current : '';
}

function render() {
  if (!last) return;
  const now = Date.now();
  const snap = last.snapshot ?? { tasks: [], epics: [], managers: [], metrics: {} };
  $('viewer').textContent = `signed in as ${last.viewer}`;
  $('banner').innerHTML = renderBanner(last, now);
  $('finding').textContent = findingOf(last.snapshot, last.online);
  $('service').innerHTML = renderService(snap.service, last.health, last.online, now);
  if (!topologyHovered()) $('topology').innerHTML = topology(snap, still.matches ? 0 : frame, last.online);
  $('pipeline').innerHTML = renderPipeline(snap.tasks, filters.status);
  const opts = filterOptions(snap.tasks);
  fillSelect('f-status', opts.status, statusLabel);
  fillSelect('f-department', opts.department);
  fillSelect('f-epic', opts.epic);
  const ctx = last.online ? viewerContext(last, snap.managers) : null; // no buttons while the orchestrator is offline
  $('admin-link').hidden = !ctx?.owner;
  $('tasks').innerHTML = renderTasks(filterTasks(snap.tasks, filters), now, ctx, { total: snap.tasks.length, filters });
  if (selected) $('tasks').querySelector(`tr[data-task="${CSS.escape(selected)}"]`)?.classList.add('sel');
  $('departments').innerHTML = renderDepartments(snap);
  $('managers').innerHTML = renderManagers(snap.managers, now, ctx, snap.pauses);
  // Keep a half-typed epic: skip the refresh only while focus is in the epic form's fields.
  const typing = document.activeElement?.closest?.('#epic-form') && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (!typing) $('controls').innerHTML = renderControls(snap, ctx, snap.departments ?? []);
  $('epics').innerHTML = renderEpics(snap.epics, snap.tasks, ctx);
  $('alerts').innerHTML = renderAlerts(last.alerts ?? [], now, alertsExpanded);
  $('metrics').innerHTML = renderMetrics(snap.metrics, snap.tasks);
}

async function refresh() {
  const r = await api('/api/snapshot').catch(() => null);
  if (!r) return;
  if (r.status === 401) return showLogin(signedIn ? 'Your session ended; sign in again.' : null);
  signedIn = true;
  last = r.body;
  $('login').hidden = true;
  $('app').hidden = false;
  $('logout').hidden = false;
  $('pw-open').hidden = false;
  render();
  startNotifications();
}

let signedIn = false;
function showLogin(message) {
  signedIn = false;
  clearInterval(timer);
  $('app').hidden = true;
  $('logout').hidden = true;
  $('pw-open').hidden = true;
  $('pw-form').hidden = true;
  $('admin-link').hidden = true;
  $('notifications').hidden = true;
  $('notification-panel').hidden = true;
  $('login').hidden = false;
  $('login-error').hidden = !message;
  $('login-error').textContent = message ?? '';
  notificationSource?.close();
  notificationSource = null;
}

function notificationItem(item, unread = true) {
  const row = document.createElement('article');
  row.className = `notification-item${unread ? ' unread' : ''}`;
  const title = document.createElement('strong');
  title.textContent = item.title;
  const body = document.createElement('p');
  body.textContent = item.body;
  const link = document.createElement('a');
  link.href = item.href || '/';
  link.textContent = 'Open';
  link.addEventListener('click', () => api('/api/notifications/read', { eventId: item.id }));
  row.append(title, body, link);
  $('notification-list').prepend(row);
}
function updateNotificationCount() {
  const count = $('notification-count');
  count.textContent = String(notificationUnread);
  count.hidden = notificationUnread < 1;
  $('notifications').setAttribute('aria-label', notificationUnread ? `${notificationUnread} unread notifications` : 'Notifications');
  document.title = notificationUnread ? `(${notificationUnread}) Swarm control room` : 'Swarm control room';
}
async function startNotifications() {
  if (notificationSource || !signedIn) return;
  const prefs = await api('/api/notifications/preferences');
  if (prefs.status === 401) return showLogin('Your session ended; sign in again.');
  notificationPrefs = prefs.body;
  $('pref-task-failed').checked = notificationPrefs.kinds?.['task-failed'] !== false;
  $('notifications').hidden = false;
  notificationSource = new EventSource(`/api/notifications/stream${notificationLastId ? `?after=${encodeURIComponent(notificationLastId)}` : ''}`);
  notificationSource.addEventListener('notification', (event) => {
    const item = JSON.parse(event.data);
    notificationLastId = item.id;
    notificationUnread += 1;
    updateNotificationCount();
    notificationItem(item);
    const toast = $('notification-toast');
    toast.textContent = `${item.title}: ${item.body}`;
    toast.hidden = false;
    setTimeout(() => { toast.hidden = true; }, 5000);
  });
  notificationSource.onerror = () => { if (notificationSource?.readyState === EventSource.CLOSED) { notificationSource = null; setTimeout(startNotifications, 1500); } };
}
$('notifications').addEventListener('click', () => {
  const panel = $('notification-panel');
  panel.hidden = !panel.hidden;
  $('notifications').setAttribute('aria-expanded', String(!panel.hidden));
  if (!panel.hidden) { notificationUnread = 0; updateNotificationCount(); }
});
$('notification-close').addEventListener('click', () => { $('notification-panel').hidden = true; $('notifications').setAttribute('aria-expanded', 'false'); });
$('notification-read').addEventListener('click', async () => {
  if (notificationLastId) await api('/api/notifications/read', { eventId: notificationLastId });
  notificationUnread = 0;
  updateNotificationCount();
});
$('pref-task-failed').addEventListener('change', async (e) => {
  const kinds = { ...(notificationPrefs?.kinds ?? {}), 'task-failed': e.target.checked };
  const r = await api('/api/notifications/preferences', { kinds });
  if (r.status === 200) notificationPrefs = r.body;
});

function initPanels() {
  const panels = document.querySelectorAll('section.panel[data-panel]');
  for (const p of panels) {
    const id = p.dataset.panel;
    let isCollapsed = false;
    try {
      isCollapsed = localStorage.getItem(`swarm.panel.${id}.collapsed`) === '1';
    } catch {}
    if (isCollapsed) {
      p.classList.add('is-collapsed');
      const toggle = p.querySelector(`button[data-toggle-panel="${CSS.escape(id)}"]`);
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
  }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-toggle-panel]');
  if (!btn) return;
  const id = btn.dataset.togglePanel;
  const panel = document.querySelector(`section.panel[data-panel="${CSS.escape(id)}"]`);
  if (!panel) return;
  const isCollapsed = panel.classList.toggle('is-collapsed');
  btn.setAttribute('aria-expanded', String(!isCollapsed));
  try {
    localStorage.setItem(`swarm.panel.${id}.collapsed`, isCollapsed ? '1' : '0');
  } catch {}
});

function start() {
  initPanels();
  clearInterval(timer);
  refresh();
  timer = setInterval(refresh, 15_000);
}

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = $('user').value.trim();
  const password = $('password').value;
  $('password').value = '';
  const r = await api('/api/login', { user, password });
  if (r.status !== 200) return showLogin(r.body.error ?? 'Sign-in failed.');
  start();
});
$('logout').addEventListener('click', async () => {
  await api('/api/logout', {});
  showLogin('Signed out.');
});
function pwMessage(text, ok) {
  $('pw-msg').hidden = !text;
  $('pw-msg').className = ok ? 'ok' : 'down';
  $('pw-msg').textContent = text ?? '';
}
$('pw-open').addEventListener('click', () => {
  $('pw-form').hidden = false;
  $('pw-form').elements.username.value = last?.viewer ?? '';
  pwMessage(null);
  $('pw-current').focus();
});
$('pw-cancel').addEventListener('click', () => { $('pw-form').reset(); $('pw-form').hidden = true; });
$('pw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const current = $('pw-current').value;
  const next = $('pw-next').value;
  if (next !== $('pw-again').value) return pwMessage('The two new passwords differ.', false);
  $('pw-form').reset();
  const r = await api('/api/password', { current, next });
  if (r.status === 401) return showLogin('Your session ended; sign in again.');
  if (r.status !== 200) return pwMessage(r.body.error ?? 'Could not change the password.', false);
  pwMessage('Password changed. Other sessions of this user were signed out.', true);
});
for (const key of Object.keys(filters)) {
  $(`f-${key}`).addEventListener('change', (e) => { filters[key] = e.target.value; render(); });
}
async function openHistory(row) {
  const id = row?.dataset.task;
  if (!id) return;
  selected = id;
  for (const r of $('tasks').querySelectorAll('tr.sel')) r.classList.remove('sel');
  row.classList.add('sel');
  const r = await api(`/api/history/${encodeURIComponent(id)}`);
  const task = last?.snapshot?.tasks?.find((t) => t.id === id);
  const history = r.status === 200 ? r.body.history : [];
  const owner = (last?.viewerRoles ?? []).includes('owner') && last?.online;
  $('history').innerHTML = renderFixForm(task, { owner, history, tasks: last?.snapshot?.tasks ?? [] })
    + (r.status === 200 ? renderTaskDetail(task, history) : renderTaskDetail(task, []) + `<p class="down">History unavailable (${r.status}).</p>`);
}
// Fix and retry (ARCHITECTURE 63): the owner widens paths, edits acceptance or drops a dependency.
$('history').addEventListener('submit', async (e) => {
  if (e.target.id !== 'fix-form') return;
  e.preventDefault();
  const form = e.target;
  const id = form.dataset.task;
  const task = last?.snapshot?.tasks?.find((t) => t.id === id);
  if (!task) return;
  const body = amendRequest(task, {
    paths: $('fix-paths').value, acceptance: $('fix-acceptance').value, reason: $('fix-reason').value,
    drop: [...form.querySelectorAll('input[name="drop"]:checked')].map((i) => i.value),
  });
  const msg = $('fix-msg');
  if (body.reason.length < 3) { msg.className = 'down'; msg.textContent = 'Write a reason first.'; return; }
  if (!body.paths && !body.acceptance && !body.dropDependsOn) { msg.className = 'down'; msg.textContent = 'Nothing changed. Edit a field, or use replan to retry as is.'; return; }
  const res = await api(`/api/operator/tasks/${encodeURIComponent(id)}/amend`, body);
  msg.className = res.status === 200 ? 'ok' : 'down';
  msg.textContent = res.status === 200 ? `Saved. ${id} is ${res.body.task.status}.` : (res.body.error ?? `Failed (${res.status}).`);
  if (res.status === 200) await refresh();
});
$('tasks').addEventListener('click', (e) => openHistory(e.target.closest('tr[data-task]')));
$('tasks').addEventListener('keydown', (e) => { if (e.key === 'Enter') openHistory(e.target.closest('tr[data-task]')); });
$('tasks').addEventListener('click', (e) => {
  if (!e.target.closest('[data-clear-filters]')) return;
  for (const key of Object.keys(filters)) filters[key] = '';
  render();
});

// Topology is a routing surface, not just a picture: selecting a department carries the
// operator straight to the work behind that node.
$('topology').addEventListener('click', (e) => {
  const taskNode = e.target.closest('[data-topology-task]');
  if (taskNode) {
    selected = taskNode.dataset.topologyTask;
    for (const key of Object.keys(filters)) filters[key] = '';
    render();
    const row = $('tasks').querySelector(`tr[data-task="${CSS.escape(selected)}"]`);
    if (row) {
      row.scrollIntoView({ behavior: still.matches ? 'auto' : 'smooth', block: 'center' });
      openHistory(row);
    }
    return;
  }
  const node = e.target.closest('[data-topology-dept]');
  if (!node) return;
  const department = node.dataset.topologyDept;
  filters.department = department;
  $('f-department').value = department;
  render();
  $('tasks').closest('section')?.scrollIntoView({ behavior: still.matches ? 'auto' : 'smooth', block: 'start' });
});
$('pipeline').addEventListener('click', (e) => {
  const stage = e.target.closest('[data-pipeline-status]');
  if (!stage) return;
  filters.status = stage.dataset.pipelineStatus;
  $('f-status').value = filters.status;
  render();
  $('tasks').closest('section')?.scrollIntoView({ behavior: still.matches ? 'auto' : 'smooth', block: 'start' });
});
$('epics').addEventListener('click', (e) => {
  const epic = e.target.closest('button[data-epic-filter]');
  if (!epic || e.target.closest('[data-plan]')) return;
  filters.epic = epic.dataset.epicFilter;
  $('f-epic').value = filters.epic;
  render();
  $('tasks').closest('section')?.scrollIntoView({ behavior: still.matches ? 'auto' : 'smooth', block: 'start' });
});
$('departments').addEventListener('click', (e) => {
  const department = e.target.closest('[data-dept-filter]');
  if (!department) return;
  filters.department = department.dataset.deptFilter;
  $('f-department').value = filters.department;
  render();
  $('tasks').closest('section')?.scrollIntoView({ behavior: still.matches ? 'auto' : 'smooth', block: 'start' });
});
$('alerts').addEventListener('click', (e) => {
  if (!e.target.closest('[data-activity-toggle]')) return;
  alertsExpanded = !alertsExpanded;
  render();
});

// ---- controls: every action needs a typed reason; the orchestrator checks the viewer's role.
let pendingAction = null;
const dialog = $('confirm');
function confirmAction(path) {
  pendingAction = path;
  $('confirm-what').textContent = describeAction(path);
  $('confirm-reason').value = '';
  $('confirm-ok').disabled = true;
  dialog.showModal();
  $('confirm-reason').focus();
}
$('confirm-reason').addEventListener('input', (e) => { $('confirm-ok').disabled = e.target.value.trim().length < 3; });
$('confirm-cancel').addEventListener('click', () => { pendingAction = null; dialog.close(); });
$('confirm-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const reason = $('confirm-reason').value.trim();
  if (!pendingAction || reason.length < 3) return;
  const path = pendingAction;
  pendingAction = null;
  dialog.close();
  const plan = /^epics\/([^/]+)\/plan$/.exec(path);
  const r = await api(`/api/operator/${path}`, plan ? { reason, dryRun: false } : { reason });
  if (r.status === 202 && r.body.job) return followJob(r.body.job, plan?.[1]);
  $('action-result').textContent = r.status === 200 ? `Done: ${path}${r.body.file ? ` (${r.body.file})` : ''}.` : `Refused (${r.status}): ${r.body.error ?? 'unknown error'}`;
  refresh();
});
document.addEventListener('click', (e) => {
  const p = e.target.closest('button[data-plan]');
  if (p) {
    e.stopPropagation();
    planDryRun(p.dataset.plan);
    return;
  }
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  e.stopPropagation();
  confirmAction(b.dataset.action);
});

// ---- owner controls: jobs and plan dry runs.
async function followJob(job, epicId = null) {
  const show = (j) => {
    if (epicId) $('plan-result').innerHTML = renderPlan(epicId, j);
    else $('action-result').textContent = j.status === 'running' ? `${j.kind} running…` : j.status === 'failed' ? `${j.kind} failed: ${j.error}` : `${j.kind} done: ${JSON.stringify(j.result).slice(0, 160)}`;
  };
  show(job);
  for (let i = 0; i < 300 && job.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const r = await api(`/api/operator/jobs/${job.id}`);
    if (r.status !== 200) break;
    job = r.body.job;
    show(job);
  }
  refresh();
}
async function planDryRun(epicId) {
  const r = await api(`/api/operator/epics/${encodeURIComponent(epicId)}/plan`, { dryRun: true });
  if (r.status === 202) return followJob(r.body.job, epicId);
  $('plan-result').replaceChildren(Object.assign(document.createElement('p'), { className: 'down', textContent: `Plan refused (${r.status}): ${r.body.error ?? 'unknown error'}` }));
}
$('controls').addEventListener('submit', async (e) => {
  if (e.target.id !== 'epic-form') return;
  e.preventDefault();
  const form = new FormData(e.target);
  const r = await api('/api/operator/epics', { title: String(form.get('title') ?? '').trim(), body: String(form.get('body') ?? '') });
  $('action-result').textContent = r.status === 201 ? `Epic ${r.body.epic?.id} created.` : `Refused (${r.status}): ${r.body.error ?? 'unknown error'}`;
  if (r.status === 201) e.target.reset();
  refresh();
});

// Topology animation: packets on active links, spinners on busy managers. It is redrawn at
// 3 frames a second; stop while a node is hovered so its interaction stays mounted.
setInterval(() => {
  if (!last?.snapshot || still.matches || document.hidden || topologyHovered()) return;
  frame += 1;
  $('topology').innerHTML = topology(last.snapshot, frame, last.online);
}, 333);

// A live session cookie signs in straight away; otherwise the first refresh shows the form.
watchBars();
start();
