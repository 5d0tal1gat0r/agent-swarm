import { escapeHtml, renderAgentTree, renderAuditHistory, renderConversation, renderInspector, renderTaskFocus, renderTimeline } from '/agents-render.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  assignments: [], sessions: [], tasks: [], feed: [], messages: [], events: [], detail: null, audit: [],
  selectedId: localStorage.getItem('cockpit-agent') ?? 'orchestrator',
  selectedTaskId: localStorage.getItem('cockpit-task') ?? '', roles: [], viewer: '', online: false, tab: 'overview', view: 'agents', lastSeq: 0,
};
let refreshTimer = null;
let dialogAction = null;

const selected = () => state.assignments.find((item) => item.id === state.selectedId) ?? state.assignments[0] ?? null;
const sessionFor = (assignment) => state.sessions.find((item) => item.assignmentId === assignment?.id) ?? null;
const uid = (prefix) => `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
const title = (value) => String(value ?? '').replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());

async function json(url, init = {}) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  if (response.status === 401) { location.href = '/'; throw new Error('Sign in required'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
  return body;
}

function notice(message, tone = '') {
  const node = $('cockpit-notice');
  node.textContent = message;
  node.className = `cockpit-notice ${tone}`;
  node.hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { node.hidden = true; }, 5000);
}

function render() {
  const assignment = selected();
  const task = state.tasks.find((item) => item.id === state.selectedTaskId) ?? state.tasks.find((item) => item.id === assignment?.taskId) ?? null;
  if (task && task.id !== state.selectedTaskId) state.selectedTaskId = task.id;
  $('agent-count').textContent = state.assignments.length;
  $('agent-tree').innerHTML = renderAgentTree(state.assignments, assignment?.id);
  $('agent-tree').hidden = state.view !== 'agents';
  $('task-list').hidden = state.view !== 'tasks';
  $('task-list').innerHTML = state.tasks.length ? state.tasks.map((item) => `<button type="button" class="cockpit-task ${item.id === task?.id ? 'selected' : ''}" data-task-id="${escapeHtml(item.id)}"><strong>${escapeHtml(item.id)}</strong><span>${escapeHtml(item.title ?? 'Untitled')}</span><small>${escapeHtml(item.status)} · ${escapeHtml(item.holder ?? 'unassigned')}</small></button>`).join('') : '<p class="cockpit-empty">No tasks in the last snapshot.</p>';
  document.querySelectorAll('[data-view]').forEach((button) => { button.classList.toggle('selected', button.dataset.view === state.view); button.setAttribute('aria-selected', button.dataset.view === state.view ? 'true' : 'false'); });
  $('cockpit-connection').innerHTML = `<span class="dot ${state.online ? 'ok' : 'down'}"></span>${state.online ? 'Orchestrator online' : 'Read-only · offline'}`;
  $('live-label').textContent = state.online ? 'Live telemetry' : 'Cached state';
  $('workspace-title').textContent = title(assignment?.id ?? 'No agent');
  $('workspace-subtitle').textContent = assignment ? `${title(assignment.kind)}${assignment.taskId ? ` · ${assignment.taskId}` : ''} · ${title(assignment.status)}` : 'Waiting for agent assignments';
  $('task-focus').innerHTML = renderTaskFocus(task, state.assignments, state.sessions);
  $('conversation').innerHTML = renderConversation(state.messages);
  $('conversation-count').textContent = state.messages.length ? `${state.messages.length} messages` : '';
  const filter = $('timeline-filter').value;
  const timeline = state.events.filter((item) => !filter || String(item.type ?? item.kind ?? item.data?.type).includes(filter));
  $('timeline').innerHTML = renderTimeline(timeline);
  $('inspector').innerHTML = renderInspector(assignment, { roles: state.roles, online: state.online, session: sessionFor(assignment), detail: state.detail, tab: state.tab });
  const canPrompt = state.online && (state.roles.includes('owner') || (state.roles.includes('manager') && assignment?.kind !== 'orchestrator'));
  $('prompt-text').disabled = !canPrompt;
  $('prompt-send').disabled = !canPrompt;
  $('prompt-text').placeholder = !state.online ? 'Read-only while the orchestrator is offline' : assignment?.kind === 'orchestrator' ? 'Prompt the orchestrator…  (Ctrl or ⌘ + Enter to send)' : `Prompt ${assignment?.id ?? 'agent'}…  (Ctrl or ⌘ + Enter to send)`;
  $('prompt-hint').textContent = assignment?.kind === 'orchestrator' ? 'The orchestrator can plan, delegate, and propose actions for confirmation.' : 'The directive is queued and applied at the next safe checkpoint.';
}

async function loadSummary() {
  const [body, snapshot] = await Promise.all([json('/api/agents'), json('/api/snapshot').catch(() => ({ snapshot: null }))]);
  state.assignments = body.summary?.assignments ?? [];
  state.sessions = body.summary?.sessions ?? [];
  state.feed = body.feed ?? [];
  state.lastSeq = Math.max(body.lastSeq ?? 0, state.feed.at(-1)?.seq ?? 0);
  state.roles = body.viewerRoles ?? [];
  state.viewer = body.viewer ?? '';
  state.online = Boolean(body.online);
  state.tasks = snapshot.snapshot?.tasks ?? [];
  if (!state.selectedTaskId || !state.tasks.some((item) => item.id === state.selectedTaskId)) state.selectedTaskId = state.tasks.find((item) => item.status === 'running')?.id ?? state.tasks[0]?.id ?? '';
  if (!state.assignments.some((item) => item.id === state.selectedId)) state.selectedId = state.assignments.find((item) => item.kind === 'orchestrator')?.id ?? state.assignments[0]?.id ?? 'orchestrator';
  render();
}

async function loadDetail() {
  const assignment = selected();
  if (!assignment || !state.online) { state.messages = []; state.events = []; state.detail = null; render(); return; }
  const target = assignment.kind === 'orchestrator' ? 'orchestrator' : assignment.id;
  const [messages, events, detail] = await Promise.allSettled([
    json(`/api/agents/conversations/${encodeURIComponent(target)}/messages?limit=100`),
    assignment.kind === 'orchestrator' ? Promise.resolve({ events: state.feed.slice(-100) }) : json(`/api/agents/assignments/${encodeURIComponent(assignment.id)}/events?limit=100`),
    json(`/api/agents/assignments/${encodeURIComponent(assignment.id)}`),
  ]);
  state.messages = messages.status === 'fulfilled' ? messages.value.messages ?? [] : [];
  state.events = events.status === 'fulfilled' ? events.value.events ?? [] : [];
  state.detail = detail.status === 'fulfilled' ? detail.value : null;
  if (messages.status === 'rejected' && !/may not|owner-only|403/i.test(messages.reason.message)) notice(messages.reason.message, 'neg');
  render();
}

async function loadAudit(filter = {}) {
  if (!state.online) { state.audit = []; return; }
  const query = new URLSearchParams({ limit: '200' });
  if (filter.assignmentId) query.set('assignment', filter.assignmentId);
  if (filter.taskId) query.set('task', filter.taskId);
  try { state.audit = (await json(`/api/agents/audit?${query}`)).items ?? []; }
  catch (error) { state.audit = []; notice(error.message, 'neg'); }
}

async function openAudit(taskId = state.selectedTaskId) {
  const assignment = selected();
  const targetTask = taskId || assignment?.taskId;
  await loadAudit(targetTask ? { taskId: targetTask } : { assignmentId: assignment?.id });
  $('audit-subtitle').textContent = targetTask ? `Task ${targetTask}` : assignment?.id ?? 'Selected agent';
  $('audit-history').innerHTML = renderAuditHistory(state.audit);
  $('audit-drawer').showModal();
}

async function selectAgent(id) {
  if (id === state.selectedId) return;
  state.selectedId = id;
  state.messages = [];
  state.events = [];
  state.detail = null;
  localStorage.setItem('cockpit-agent', id);
  render();
  await loadDetail();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try { await loadSummary(); await loadDetail(); } catch (error) { notice(error.message, 'neg'); }
  }, 250);
}

function connect() {
  const source = new EventSource(`/api/agents/stream?after=${state.lastSeq}`);
  const update = (event) => {
    try {
      const item = JSON.parse(event.data);
      state.lastSeq = Math.max(state.lastSeq, Number(item.seq) || 0);
      scheduleRefresh();
    } catch { /* ignore malformed stream frames */ }
  };
  for (const kind of ['assignment', 'session', 'agent-event', 'directive', 'operator-turn', 'operator-action', 'message']) source.addEventListener(kind, update);
  source.onopen = () => { $('cockpit-connection').innerHTML = `<span class="dot ${state.online ? 'ok' : 'down'}"></span>${state.online ? 'Orchestrator online' : 'Read-only · offline'}`; };
  source.onerror = () => { $('cockpit-connection').innerHTML = '<span class="dot down"></span>Reconnecting'; };
}

async function prompt(event) {
  event.preventDefault();
  const text = $('prompt-text').value.trim();
  const assignment = selected();
  if (!text || !assignment) return;
  const payload = { text, idempotencyKey: uid('prompt') };
  if (assignment.kind !== 'orchestrator') payload.reason = 'Direct operator prompt from agent cockpit';
  $('prompt-send').disabled = true;
  try {
    await json(`/api/operator/agents/${encodeURIComponent(assignment.id)}/prompt`, { method: 'POST', body: JSON.stringify(payload) });
    $('prompt-text').value = '';
    notice(assignment.kind === 'orchestrator' ? 'Prompt queued for the orchestrator.' : 'Prompt queued for the next safe checkpoint.', 'ok');
    await loadDetail();
  } catch (error) { notice(error.message, 'neg'); }
  finally { $('prompt-send').disabled = false; }
}

function openDialog(action) {
  const assignment = selected();
  if (!assignment) return;
  dialogAction = action;
  const context = action === 'context';
  const dangerous = ['interrupt', 'stop'].includes(action);
  $('agent-dialog-title').textContent = context ? `Edit ${assignment.id} context` : `${title(action)} ${assignment.id}?`;
  $('agent-dialog-copy').textContent = context ? 'Changes are queued and applied at the next checkpoint.' : dangerous ? 'This affects a running process. Its worktree and audit history will be preserved.' : 'This command is queued, audited, and applied at a safe checkpoint.';
  $('context-fields').hidden = !context;
  $('agent-dialog-confirm').textContent = context ? 'Queue context update' : `Queue ${title(action)}`;
  $('agent-dialog-confirm').className = dangerous ? 'danger' : '';
  $('agent-reason').value = '';
  const current = { ...(state.detail?.assignment ?? assignment), ...(state.detail?.session ?? {}) };
  $('context-goal').value = current.goal ?? '';
  $('context-task').value = current.currentTask ?? '';
  $('context-skills').value = (current.sessionSkills?.roles ?? []).join(', ');
  $('agent-dialog').showModal();
}

async function submitDialog(event) {
  event.preventDefault();
  const assignment = selected();
  if (!dialogAction || !assignment) return;
  const payload = { reason: $('agent-reason').value.trim(), idempotencyKey: uid(dialogAction) };
  if (dialogAction === 'context') {
    const goal = $('context-goal').value.trim();
    const currentTask = $('context-task').value.trim();
    const roles = $('context-skills').value.split(',').map((item) => item.trim()).filter(Boolean);
    payload.context = {};
    if (goal) payload.context.goal = goal;
    if (currentTask) payload.context.currentTask = currentTask;
    if (roles.length) payload.context.sessionSkills = { roles };
    if (!Object.keys(payload.context).length) return notice('Add at least one context field.', 'neg');
  }
  try {
    const result = await json(`/api/operator/agents/${encodeURIComponent(assignment.id)}/${dialogAction}`, { method: 'POST', body: JSON.stringify(payload) });
    $('agent-dialog').close();
    notice(`${title(dialogAction)} queued${result.directive?.id ? ` · ${result.directive.id}` : ''}.`, 'ok');
    scheduleRefresh();
  } catch (error) { notice(error.message, 'neg'); }
}

$('agent-tree').addEventListener('click', (event) => { const button = event.target.closest('[data-agent-id]'); if (button) selectAgent(button.dataset.agentId); });
$('task-list').addEventListener('click', (event) => { const button = event.target.closest('[data-task-id]'); if (!button) return; state.selectedTaskId = button.dataset.taskId; state.view = 'tasks'; localStorage.setItem('cockpit-task', state.selectedTaskId); render(); });
$('task-focus').addEventListener('click', (event) => { const button = event.target.closest('[data-open-audit]'); if (button) openAudit(button.dataset.openAudit); });
document.querySelector('.cockpit-view-switch').addEventListener('click', (event) => { const button = event.target.closest('[data-view]'); if (!button) return; state.view = button.dataset.view; render(); });
$('inspector').addEventListener('click', (event) => {
  const tab = event.target.closest('[data-tab]');
  if (tab) { state.tab = tab.dataset.tab; render(); return; }
  const context = event.target.closest('[data-edit-context]');
  if (context) { openDialog('context'); return; }
  const command = event.target.closest('[data-command]');
  if (command) openDialog(command.dataset.command);
});
$('timeline-filter').addEventListener('change', render);
$('prompt-form').addEventListener('submit', prompt);
$('prompt-text').addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('prompt-form').requestSubmit(); });
$('agent-dialog-form').addEventListener('submit', submitDialog);
$('agent-dialog-cancel').addEventListener('click', () => $('agent-dialog').close());
$('audit-drawer').addEventListener('click', (event) => { if (event.target.matches('[data-close-audit]')) $('audit-drawer').close(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && $('audit-drawer').open) $('audit-drawer').close(); });

try { await loadSummary(); await loadDetail(); connect(); }
catch (error) { notice(error.message, 'neg'); }
