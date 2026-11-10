export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const label = (value) => {
  const text = String(value ?? '').replace(/[-_]/g, ' ');
  return escapeHtml(text ? `${text[0].toUpperCase()}${text.slice(1)}` : '');
};
const time = (value) => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export function hierarchyOf(assignments) {
  const byParent = new Map();
  for (const assignment of assignments) {
    const parent = assignment.parentId ?? '__root__';
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(assignment);
  }
  for (const children of byParent.values()) children.sort((a, b) => (a.kind === 'manager' ? -1 : 0) - (b.kind === 'manager' ? -1 : 0) || a.id.localeCompare(b.id));
  const output = [];
  const visit = (assignment, depth) => {
    output.push({ assignment, depth });
    for (const child of byParent.get(assignment.id) ?? []) visit(child, depth + 1);
  };
  const roots = assignments.filter((item) => item.kind === 'orchestrator');
  for (const root of roots) visit(root, 0);
  for (const orphan of assignments.filter((item) => !output.some((node) => node.assignment.id === item.id))) visit(orphan, orphan.kind === 'manager' ? 1 : 2);
  return output;
}

export function renderAgentTree(assignments, selectedId) {
  if (!assignments.length) return '<p class="cockpit-empty">No agents have reported yet.</p>';
  return hierarchyOf(assignments).map(({ assignment, depth }) => `
    <button class="cockpit-agent depth-${Math.min(depth, 2)} ${assignment.id === selectedId ? 'selected' : ''}" data-agent-id="${escapeHtml(assignment.id)}" aria-current="${assignment.id === selectedId ? 'true' : 'false'}">
      <span class="agent-state state-${escapeHtml(assignment.status)}" aria-hidden="true"></span>
      <span><strong>${escapeHtml(assignment.id)}</strong><small>${escapeHtml(assignment.taskId ?? assignment.kind)} · ${label(assignment.role ?? assignment.status)}</small></span>
      <span class="agent-clock"><b>${label(assignment.status)}</b><small>${time(assignment.updatedAt)}</small></span>
    </button>`).join('');
}

export function renderConversation(messages) {
  if (!messages.length) return '<p class="cockpit-empty">Prompt the orchestrator to begin. Replies and action previews stay here.</p>';
  return messages.map((message) => `<article class="cockpit-message ${message.role === 'assistant' ? 'assistant' : ''}">
    <span class="message-avatar" aria-hidden="true">${message.role === 'assistant' ? 'A' : 'U'}</span>
    <div><header><strong>${escapeHtml(message.actor)}</strong><time>${time(message.createdAt)}</time></header><p>${escapeHtml(message.text)}</p></div>
  </article>`).join('');
}

export function renderTimeline(items) {
  if (!items.length) return '<p class="cockpit-empty">Waiting for observable execution events.</p>';
  return items.map((item) => {
    const data = item.data ?? {};
    const title = data.summary ?? data.type ?? item.kind;
    const kind = data.type ?? item.kind;
    return `<article class="cockpit-event"><time>${time(item.at ?? data.at)}</time><span class="event-mark" aria-hidden="true"></span><div><strong>${escapeHtml(title)}</strong><p>${label(kind)} · observable event${item.taskId ? ` · ${escapeHtml(item.taskId)}` : ''}</p></div></article>`;
  }).join('');
}

export function renderDirectiveState(directive) {
  return `<span class="directive-state state-${escapeHtml(directive.status)}"><b>${label(directive.status)}</b>${directive.result ? ` · ${escapeHtml(directive.result)}` : ''}</span>`;
}

export function renderTaskFocus(task, assignments = [], sessions = []) {
  if (!task) return '<section class="task-focus cockpit-empty">Select a task to see its operating picture.</section>';
  const linked = assignments.filter((item) => item.taskId === task.id);
  const tokenBudget = Number(task.budget?.tokens ?? 0);
  const usedTokens = Number(task.usedTokens ?? (Number(task.inputTokens ?? 0) + Number(task.outputTokens ?? 0)));
  const pct = tokenBudget > 0 ? Math.min(100, Math.round((usedTokens / tokenBudget) * 100)) : 0;
  const phase = task.lastPhase ?? sessions.find((item) => item.taskId === task.id || linked.some((assignment) => assignment.id === item.assignmentId))?.phase ?? 'queued';
  const checks = task.review?.evidence?.length ? task.review.evidence.map((item) => `<li class="${item.met ? 'check-pass' : 'check-open'}"><span>${item.met ? '✓' : '○'}</span>${escapeHtml(item.criterion)}</li>`).join('') : '<li class="check-open"><span>○</span>Checks not reported yet</li>';
  const links = linked.length ? linked.map((item) => `<span class="task-agent-chip"><i class="agent-state state-${escapeHtml(item.status)}"></i><b>${escapeHtml(item.id)}</b><small>${label(item.kind)} · ${escapeHtml(item.role ?? item.status)}</small></span>`).join('') : '<span class="mut">No agent assignments reported yet.</span>';
  return `<section class="task-focus" data-task-focus="${escapeHtml(task.id)}">
    <div class="task-focus-head"><div><p class="eyebrow">Task operating picture</p><h3>${escapeHtml(task.id)} · ${escapeHtml(task.title ?? 'Untitled task')}</h3></div><span class="status-pill state-${escapeHtml(task.status)}">${label(task.status)}</span></div>
    <div class="task-focus-grid"><span><small>Manager</small><b>${escapeHtml(task.holder ?? 'Unassigned')}</b></span><span><small>Department</small><b>${escapeHtml(task.department ?? '—')}</b></span><span><small>Phase</small><b>${label(phase)}</b></span><span><small>PR</small><b>${task.pr ? `#${escapeHtml(task.pr)}` : 'Not opened'}</b></span><span><small>Worktree / branch</small><b>${escapeHtml(task.branch ?? 'Not created')}</b></span><span><small>Checks</small><b>${escapeHtml(task.review?.status ?? task.lastNote ?? 'Not reported')}</b></span></div>
    <div class="task-budget"><div><span>Token budget</span><b>${usedTokens.toLocaleString()} / ${tokenBudget.toLocaleString()}</b></div><meter min="0" max="100" value="${pct}">${pct}%</meter></div>
    <div class="task-agents"><div class="stream-head"><h4>Manager + subagents</h4><span class="mut">${linked.length} linked</span></div><div class="task-agent-list">${links}</div></div>
    <div class="task-checks"><div class="stream-head"><h4>Acceptance checks</h4><span class="mut">${task.review?.rounds ?? 0} review rounds</span></div><ul>${checks}</ul></div>
    <button class="task-history-button" type="button" data-open-audit="${escapeHtml(task.id)}">Open action history</button>
  </section>`;
}

export function renderAuditHistory(items) {
  if (!items.length) return '<p class="cockpit-empty">No operator actions yet.</p>';
  return items.map((item) => `<article class="audit-item"><div class="audit-item-head"><span class="event-mark" aria-hidden="true"></span><div><strong>${label(item.action ?? item.kind)}</strong><span class="audit-meta">${label(item.kind)} · ${label(item.status)} · ${time(item.at)}</span></div></div><p>${item.actor ? `<b>${escapeHtml(item.actor)}</b>` : '<b>system</b>'}${item.reason ? ` · ${escapeHtml(item.reason)}` : ''}</p>${item.result ? `<small class="audit-result">Result: ${escapeHtml(typeof item.result === 'string' ? item.result : JSON.stringify(item.result))}</small>` : ''}</article>`).join('');
}

export function renderInspector(assignment, { roles = [], online = true, session = null, detail = null, tab = 'overview' } = {}) {
  if (!assignment) return '<p class="cockpit-empty">Select an agent.</p>';
  const canDirect = roles.includes('owner') || roles.includes('manager');
  const owner = roles.includes('owner');
  const offline = !online ? '<p class="offline-note">Read-only while orchestrator is offline.</p>' : '';
  const context = { ...(detail?.assignment ?? assignment), ...(detail?.session ?? {}) };
  const skills = context.sessionSkills?.roles ?? [];
  const overview = `<section class="inspector-stats"><span>Agent ID <code>${escapeHtml(assignment.id)}</code></span><span>Model <code>${escapeHtml(session?.model ?? context.model ?? '—')}</code></span><span>Phase <code>${escapeHtml(session?.phase ?? 'idle')}</code></span><span>Tokens <code>${Number(session?.inputTokens ?? 0).toLocaleString()} in / ${Number(session?.outputTokens ?? 0).toLocaleString()} out</code></span></section>`;
  const contextPanel = `<section class="inspector-context"><h3>Goal</h3><p>${escapeHtml(context.goal ?? 'Not reported')}</p><h3>Current task</h3><p>${escapeHtml(context.currentTask ?? assignment.taskId ?? 'Not reported')}</p><h3>Skills</h3><div class="skill-list">${skills.length ? skills.map((skill) => `<code>${escapeHtml(skill)}</code>`).join('') : '<span class="mut">Not reported</span>'}</div><h3>Guardrails</h3><p>${escapeHtml(context.guardrails?.instructions ?? 'Canonical task paths and swarm policy apply.')}</p>${context.guardrails?.allowedPaths?.length ? `<ul>${context.guardrails.allowedPaths.map((path) => `<li><code>${escapeHtml(path)}</code></li>`).join('')}</ul>` : ''}</section>`;
  const activity = `<section class="inspector-stats"><span>Assignment <code>${label(assignment.status)}</code></span><span>Session <code>${label(session?.status ?? 'none')}</code></span><span>Updated <code>${time(session?.updatedAt ?? assignment.updatedAt)}</code></span><span>Event cursor <code>${Number(session?.lastEventSeq ?? 0).toLocaleString()}</code></span></section>`;
  const panel = tab === 'context' ? contextPanel : tab === 'activity' ? activity : overview;
  return `<section class="inspector-identity"><div><span class="agent-state state-${escapeHtml(assignment.status)}"></span><h2>${escapeHtml(assignment.id)}</h2><b>${label(assignment.status)}</b></div><p>${label(assignment.kind)}${assignment.taskId ? ` · ${escapeHtml(assignment.taskId)}` : ''}</p></section>
    <div class="inspector-tabs" role="tablist">${['overview', 'context', 'activity'].map((name) => `<button role="tab" data-tab="${name}" aria-selected="${tab === name}">${label(name)}</button>`).join('')}</div>
    ${offline}
    ${panel}
    ${canDirect && online ? `<button class="inspector-wide" data-edit-context>Edit context</button>
    <section class="inspector-commands"><h3>Safe commands</h3><p>Checkpointed, non-destructive operations.</p>${['status', 'pause', 'replan'].map((command) => `<button data-command="${command}"><b>${command === 'status' ? 'Request status' : label(command)}</b><small>${command === 'status' ? 'Ask for a fresh progress event' : 'Queued and audited'}</small></button>`).join('')}</section>` : ''}
    ${owner && online ? `<section class="inspector-danger"><h3>Dangerous actions</h3><p>Requires a reason and explicit confirmation.</p><button data-command="interrupt"><b>Interrupt now</b><small>Signal the active process, preserve its worktree</small></button><button data-command="stop"><b>Stop agent</b><small>End the run and preserve current state</small></button></section>` : ''}`;
}
