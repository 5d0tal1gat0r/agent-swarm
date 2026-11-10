// Pure render functions for the server dashboard (layout ARCHITECTURE 50).
// Used by the browser (app.js) and by the tests. Every value from the swarm goes through
// esc(): task titles come from GitHub issues and bus messages from any member.

import { epicStatus } from './graph.mjs';

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const ago = (iso, now) => {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((now - (typeof iso === 'number' ? iso : Date.parse(iso))) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const hms = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toISOString().slice(11, 19);
};
const fmt = (n) => Number(n ?? 0).toLocaleString('en-US');
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

// The rail follows the operator's work path; blocked and terminal exceptions stay in Attention.
export const PIPELINE = ['in_progress', 'queued', 'in_review', 'changes_requested', 'leased', 'submitted', 'merged'];
export const SIDE = ['blocked', 'needs-human', 'escalated', 'failed', 'cancelled'];
const ACTIVE = new Set(['leased', 'in_progress', 'submitted', 'in_review', 'changes_requested']);
const STUCK = new Set(['needs-human', 'escalated', 'failed']);
const ORDER = ['needs-human', 'failed', 'escalated', 'changes_requested', 'in_progress', 'leased', 'in_review', 'submitted', 'queued', 'blocked', 'merged', 'cancelled'];
export const STATUS_LABELS = {
  blocked: 'Blocked', queued: 'Queued', leased: 'Leased', in_progress: 'Running', submitted: 'Submitted',
  in_review: 'In review', changes_requested: 'Changes requested', merged: 'Merged', 'needs-human': 'Needs human',
  escalated: 'Escalated', failed: 'Failed', cancelled: 'Cancelled',
};
export const statusLabel = (status) => STATUS_LABELS[status] ?? String(status ?? 'Unknown').replaceAll('_', ' ');

/** Tasks matching { status, department, epic }; empty filter values match everything. Stuck work first. */
export function filterTasks(tasks, filters = {}) {
  return tasks
    .filter((t) => (!filters.status || t.status === filters.status)
      && (!filters.department || t.department === filters.department)
      && (!filters.epic || t.epicId === filters.epic))
    .sort((a, b) => (ORDER.indexOf(a.status) - ORDER.indexOf(b.status)) || String(a.id).localeCompare(String(b.id)));
}

/** Distinct values for the filter selects. */
export function filterOptions(tasks) {
  const uniq = (key) => [...new Set(tasks.map((t) => t[key]).filter(Boolean))].sort();
  return { status: uniq('status'), department: uniq('department'), epic: uniq('epicId') };
}

/** Per department: queued, active, merged, stuck counts, pause, and the managers that cover it. */
export function departmentStats(snapshot) {
  const tasks = snapshot.tasks ?? [];
  const names = snapshot.departments?.length ? snapshot.departments : [...new Set(tasks.map((t) => t.department))].sort();
  return names.map((d) => {
    const mine = tasks.filter((t) => t.department === d);
    return {
      name: d,
      queued: mine.filter((t) => t.status === 'queued').length,
      active: mine.filter((t) => ACTIVE.has(t.status)).length,
      merged: mine.filter((t) => t.status === 'merged').length,
      stuck: mine.filter((t) => STUCK.has(t.status)).length,
      paused: snapshot.pauses?.departments?.[d] ?? null,
      managers: (snapshot.managers ?? []).filter((m) => (m.departments ?? []).includes(d)),
    };
  });
}

/** The one line the screen leads with: the fact that most needs attention now. */
export function findingOf(snapshot, online = true) {
  if (!snapshot) return 'No data from the orchestrator yet.';
  const tasks = snapshot.tasks ?? [];
  const count = (s) => tasks.filter((t) => t.status === s).length;
  if (snapshot.paused) return 'The whole swarm is paused: nothing is leased or merged until someone resumes it.';
  const ids = (s) => tasks.filter((t) => t.status === s).map((t) => t.id);
  const human = ids('needs-human');
  if (human.length) return `${human.length} task${human.length > 1 ? 's' : ''} need${human.length > 1 ? '' : 's'} a person (needs-human): ${human.slice(0, 3).join(', ')}${human.length > 3 ? ', …' : ''}.`;
  const broken = count('failed') + count('escalated');
  if (broken) return `${broken} task${broken > 1 ? 's' : ''} failed or escalated and wait${broken > 1 ? '' : 's'} for a replan.`;
  const orphan = departmentStats(snapshot).filter((d) => d.queued && !d.paused && !d.managers.some((m) => m.state !== 'offline'));
  if (orphan.length) return `${orphan.map((d) => `${d.name} has ${d.queued} queued`).join(', ')} and no manager online.`;
  if (!tasks.length) return 'No tasks yet. Open an issue labelled epic, or create an epic in Controls.';
  const active = tasks.filter((t) => ACTIVE.has(t.status)).length;
  return `${active} task${active === 1 ? '' : 's'} moving, ${count('queued')} queued, nothing stuck${online ? '' : ' (as of the last snapshot)'}.`;
}

export function renderBanner({ online, offlineSince, fetchedAt, error }, now) {
  if (online) return `<span class="dot ok" aria-hidden="true"></span>Orchestrator online. Updated ${esc(ago(fetchedAt, now))}.`;
  if (!fetchedAt) return `<span class="dot down" aria-hidden="true"></span><span class="down">Orchestrator offline${offlineSince ? ` since ${esc(new Date(offlineSince).toISOString())}` : ''}. No data yet${error ? `: ${esc(error)}` : ''}.</span>`;
  return `<span class="dot down" aria-hidden="true"></span><span class="down">Orchestrator offline since ${esc(new Date(offlineSince).toISOString())}. Showing the last snapshot from ${esc(ago(fetchedAt, now))}.</span>`;
}

// ---- the topology: a live dispatch map of the orchestrator, managers and subagents.

// Keep the tree readable when a manager has a large configured pool. Running leaves stay first;
// the collapsed remainder still communicates the manager's capacity without turning the map into a wall of cards.
const MAX_VISIBLE_SUBAGENTS = 3;

const topologyManagerState = (manager, snapshot, online) => {
  if (manager.synthetic) return ['offline', 'neg', 'no manager registered'];
  if (!online || manager.state === 'offline') return ['offline', 'neg', 'last heartbeat is stale'];
  const pause = snapshot?.pauses?.managers?.[manager.name];
  if (pause) return ['paused', 'warn', pause.reason || 'paused by operator'];
  if (manager.state === 'busy') return ['busy', 'pk', 'dispatching work'];
  if (manager.state === 'idle') return ['idle', 'ok', 'ready to lease'];
  return [manager.state || 'unknown', 'mut', 'manager state unknown'];
};

// Keep one visible branch per configured department. A live snapshot can contain only the
// managers that have been provisioned so far; the stable offline slots make that missing
// topology explicit instead of collapsing the tree down to the one active machine.
const topologyManagerRoster = (snapshot) => {
  const departments = departmentStats(snapshot ?? {});
  const managers = [...(snapshot?.managers ?? [])];
  const placeholders = departments.slice(managers.length).map((department) => ({
    name: `offline-${department.name}`,
    state: 'offline',
    departments: [department.name],
    freeSlots: 0,
    running: [],
    lastHeartbeat: null,
    agent: 'unassigned',
    synthetic: true,
  }));
  return managers.concat(placeholders);
};

const topologyManagerData = (snapshot, online) => {
  const departments = departmentStats(snapshot ?? {});
  const tasks = snapshot?.tasks ?? [];
  const info = new Map((snapshot?.departmentInfo ?? []).map((d) => [d.id, d]));
  const managers = topologyManagerRoster(snapshot).sort((a, b) => {
    const offline = (manager) => manager.state === 'offline' ? 1 : 0;
    return offline(a) - offline(b) || String(a.name).localeCompare(String(b.name));
  });
  return managers.map((manager) => {
    const coverage = departments.filter((d) => (manager.departments ?? []).includes(d.name));
    const running = Array.isArray(manager.running) ? manager.running : [];
    const capacity = (manager.departments ?? []).reduce((sum, department) => sum + Number(info.get(department)?.maxSubagents ?? 0), 0);
    const [state, tone, detail] = topologyManagerState(manager, snapshot, online);
    const paused = coverage.some((department) => department.paused) || Boolean(snapshot?.pauses?.managers?.[manager.name]);
    return {
      manager,
      coverage,
      running,
      tasks,
      capacity,
      state,
      tone,
      detail,
      moving: online && state === 'busy' && running.length > 0 && !snapshot?.paused && !paused,
    };
  });
};

const topologySubagentLeaves = (data, compact = false) => {
  if (!data.running.length) {
    const detail = data.state === 'offline' ? 'manager not registered' : 'no active subagents';
    if (compact) return `<span class="topology-tree-subagent topology-subagent-overflow"><span class="topology-tree-branch">└─</span><span><b>subagent pool offline</b><small>${esc(detail)}</small></span><em>offline</em></span>`;
    return `<span class="topology-subagent topology-subagent-overflow"><i class="topology-subagent-dot"></i><span><b>subagent pool offline</b><small>${esc(detail)}</small></span><em>offline</em></span>`;
  }
  const taskById = new Map(data.tasks.map((task) => [task.id, task]));
  const slots = Math.max(1, data.capacity, data.running.length);
  const visibleSlots = Math.min(MAX_VISIBLE_SUBAGENTS, data.running.length);
  const leaves = Array.from({ length: visibleSlots }, (_, index) => {
    const id = data.running[index];
    if (!id) {
      const state = data.state === 'offline' ? 'offline' : data.state === 'paused' ? 'paused' : 'ready';
      const label = state === 'ready' ? 'ready' : state;
      const detail = state === 'ready' ? 'waiting for work' : `manager ${state}`;
      if (compact) return `<span class="topology-tree-subagent topology-subagent-${state}"><span class="topology-tree-branch">└─</span><span><b>subagent ${index + 1}</b><small>${esc(detail)}</small></span><em>${esc(label)}</em></span>`;
      return `<span class="topology-subagent topology-subagent-${state}"><i class="topology-subagent-dot"></i><span><b>subagent ${index + 1}</b><small>${esc(detail)}</small></span><em>${esc(label)}</em></span>`;
    }
    const task = taskById.get(id);
    const phase = data.state === 'offline' ? 'manager offline' : data.state === 'paused' ? 'dispatch paused' : task?.lastPhase === 'subagents' ? 'subagents active' : statusLabel(task?.status ?? 'in_progress');
    const title = task?.title ?? 'task details unavailable';
    const className = data.state === 'offline' ? 'topology-subagent-offline' : data.state === 'paused' ? 'topology-subagent-paused' : task?.lastPhase === 'subagents' ? 'topology-subagent-active' : 'topology-subagent-running';
    if (compact) return `<button type="button" class="topology-tree-subagent ${className}" data-topology-task="${esc(id)}" aria-label="Open task ${esc(id)}"><span class="topology-tree-branch">└─</span><span><b class="mono">${esc(id)}</b><small>${esc(clip(title, 34))}</small></span><em>${esc(phase)}</em></button>`;
    return `<button type="button" class="topology-subagent ${className}" data-topology-task="${esc(id)}" aria-label="Open task ${esc(id)}"><i class="topology-subagent-dot"></i><span><b class="mono">${esc(id)}</b><small>${esc(clip(title, 32))}</small></span><em>${esc(phase)}</em></button>`;
  });
  const hidden = slots - visibleSlots;
  if (hidden) {
    if (compact) leaves.push(`<span class="topology-tree-subagent topology-subagent-overflow"><span class="topology-tree-branch">└─</span><span><b>+${hidden} more slots</b><small>collapsed for clarity</small></span><em>hidden</em></span>`);
    else leaves.push(`<span class="topology-subagent topology-subagent-overflow"><i class="topology-subagent-dot"></i><span><b>+${hidden} more slots</b><small>collapsed for clarity</small></span><em>hidden</em></span>`);
  }
  return leaves.join('');
};

/**
 * Responsive dispatch map. `frame` changes the packet phase and busy-manager marker so the
 * diagram communicates motion without inventing data; every count still comes from the snapshot.
 */
export function renderTopology(snapshot, frame = 0, online = true) {
  const depts = departmentStats(snapshot ?? {}).slice(0, 8);
  const tasks = snapshot?.tasks ?? [];
  const managers = topologyManagerData(snapshot, online);
  const c = (s) => tasks.filter((t) => t.status === s).length;
  const active = tasks.filter((t) => ACTIVE.has(t.status)).length;
  const subagents = managers.reduce((sum, data) => sum + data.running.length, 0);
  const gaps = depts.filter((d) => !d.managers.some((manager) => manager.state !== 'offline'));
  const [label, cls] = !online ? ['offline', 'neg'] : snapshot?.paused ? ['paused', 'warn'] : ['online', 'ok'];
  const freeSlots = (snapshot?.managers ?? []).reduce((sum, m) => sum + (Number.isInteger(m.freeSlots) && m.state !== 'offline' ? m.freeSlots : 0), 0);
  const deptCount = (snapshot?.departments ?? []).length;
  const originStats = `<span><b>${esc(managers.length)}</b><small>managers</small></span><span><b>${esc(subagents)}</b><small>subagents</small></span><span><b>${esc(freeSlots)}</b><small>free slots</small></span><span><b>${esc(deptCount)}</b><small>departments</small></span>`;
  const lanes = managers.length ? managers.map((data) => {
    const { manager, coverage } = data;
    const departments = coverage.length ? coverage.map((d) => `<button type="button" class="topology-dept-chip" data-topology-dept="${esc(d.name)}" aria-label="Focus ${esc(d.name)} tasks"><span>${esc(d.name)}</span><small>${d.active} run · ${d.queued} q</small></button>`).join('') : '<span class="topology-dept-chip topology-dept-chip-empty">no department coverage</span>';
    const capacity = data.capacity ? `<span class="topology-manager-capacity">cap ${esc(data.capacity)}</span>` : '';
    return `<section class="topology-manager-lane topology-lane-${esc(data.state)}${data.moving ? ' is-moving' : ''}" data-topology-manager="${esc(manager.name)}">
      <div class="topology-manager-route" data-phase="${frame % 3}" aria-hidden="true"><span class="topology-route-line"></span>${data.moving ? '<span class="topology-packet">•</span>' : '<span class="topology-route-idle">·</span>'}</div>
      <div class="topology-manager-card">
        <div class="topology-manager-head"><span><i class="topology-manager-dot ${data.tone}"></i><b class="mono">${esc(manager.name)}</b></span><span class="topology-state ${data.tone}">${esc(data.state)}</span></div>
        <p class="topology-manager-detail">${esc(data.detail)}</p>
        <div class="topology-manager-stats"><span><b>${esc(data.running.length)}</b><small>running</small></span><span><b>${esc(manager.freeSlots ?? '–')}</b><small>free slots</small></span><span><b>${esc(coverage.length)}</b><small>departments</small></span></div>
        <div class="topology-dept-chips">${departments}</div>
        <div class="topology-manager-foot"><span>${esc(manager.agent ?? 'manager')}</span>${capacity}<span>${manager.lastHeartbeat ? esc(ago(manager.lastHeartbeat, Date.now())) : 'no heartbeat'}</span></div>
      </div>
      <div class="topology-subagent-branch"><span class="topology-subagent-stem" aria-hidden="true"></span><div class="topology-subagents" aria-label="Subagents for ${esc(manager.name)}">${topologySubagentLeaves(data)}</div></div>
    </section>`;
  }).join('') : '<p class="empty topology-empty">No managers registered in the latest snapshot.</p>';
  const gapMarkup = gaps.length ? `<div class="topology-gaps"><span class="topology-gaps-label">Coverage gaps</span>${gaps.map((d) => `<button type="button" class="topology-gap" data-topology-dept="${esc(d.name)}"><span>${esc(d.name)}</span><small>no manager online · ${d.queued} queued</small></button>`).join('')}</div>` : '';
  const footer = snapshot?.paused ? '<span class="warn">Dispatch paused by operator.</span>' : !online ? '<span class="neg">Showing the last known routes.</span>' : `<span class="ok"><i class="topology-live-dot"></i> Routing live</span><span class="mut">${managers.length} manager${managers.length === 1 ? '' : 's'} · ${depts.length} department${depts.length === 1 ? '' : 's'} · ${subagents} active subagent${subagents === 1 ? '' : 's'}</span>`;
  return `<div class="topology-map" data-frame="${frame}">
    <div class="topology-origin"><div class="topology-origin-head"><span><i class="topology-live-dot ${cls}"></i><b>orchestrator</b></span><span class="topology-origin-state ${cls}">${esc(label)}</span></div><span class="topology-origin-sub">coordination core · manager dispatch</span><div class="topology-origin-stats">${originStats}</div></div>
    <div class="topology-bus"><span class="topology-bus-line"></span><span class="topology-bus-label mono">BUS / DISPATCH / ${managers.length} MANAGERS</span><span class="topology-bus-line"></span></div>
    <div class="topology-manager-grid">${lanes}</div>
    ${gapMarkup}
    <div class="topology-footer">${footer}</div>
  </div>`;
}

/** Compact topology tree for narrow screens; keeps the same three-level hierarchy and click targets. */
export function renderTopologyTree(snapshot, frame = 0, online = true) {
  const managers = topologyManagerData(snapshot, online);
  const subagents = managers.reduce((sum, data) => sum + data.running.length, 0);
  const tasks = snapshot?.tasks ?? [];
  const [label, cls] = !online ? ['○ offline', 'neg'] : snapshot?.paused ? ['‖ paused', 'warn'] : ['● online', 'ok'];
  const head = `<div class="topology-tree-root"><b>orchestrator</b> <span class="${cls}">${esc(label)}</span><span class="mut">${managers.length} mgr · ${subagents} subagents · q${tasks.filter((t) => t.status === 'queued').length} · ${tasks.filter((t) => ACTIVE.has(t.status)).length} active</span></div>`;
  const lines = managers.map((data, i) => {
    const { manager, coverage } = data;
    const branch = `<span class="topology-tree-branch">${i === managers.length - 1 ? '└' : '├'}${data.moving ? `<b class="pk">${['•──', '─•─', '──•'][frame % 3]}</b>` : '───'}</span>`;
    const deptNames = coverage.map((d) => d.name).join(', ') || 'no department coverage';
    return `<div class="topology-tree-manager topology-lane-${esc(data.state)}">${branch}<span class="topology-tree-name mono"><i class="topology-manager-dot ${data.tone}"></i>${esc(clip(manager.name, 18))}</span><span class="topology-tree-counts">${esc(data.state)} · ${data.running.length} subagent${data.running.length === 1 ? '' : 's'} · ${esc(manager.freeSlots ?? '–')} free</span><span class="topology-tree-detail ${data.tone}">${esc(deptNames)}</span></div><div class="topology-tree-subagents">${topologySubagentLeaves(data, true)}</div>`;
  }).join('');
  return `<div class="topology-tree">${head}${lines}</div>`;
}

const PIPELINE_COPY = {
  blocked: ['Blocked', 'waiting on dependencies'],
  queued: ['Queued', 'waiting for dispatch'],
  leased: ['Leased', 'manager assigned'],
  in_progress: ['Running', 'agent is working'],
  submitted: ['Submitted', 'waiting for checks'],
  in_review: ['In review', 'review loop'],
  changes_requested: ['Changes requested', 'needs another pass'],
  merged: ['Merged', 'delivered'],
  'needs-human': ['Needs human', 'person needed'],
  escalated: ['Escalated', 'needs a replan'],
  failed: ['Failed', 'execution stopped'],
  cancelled: ['Cancelled', 'closed without merge'],
};

const pipelineTone = (status) => (STUCK.has(status) ? 'danger' : status === 'merged' ? 'positive' : ACTIVE.has(status) ? 'active' : status === 'blocked' ? 'warning' : 'neutral');

/** A compact, clickable workflow rail. Every stage is a task-list filter target. */
export function renderPipeline(tasks = [], selectedStatus = '') {
  const counts = Object.fromEntries([...PIPELINE, ...SIDE].map((s) => [s, tasks.filter((t) => t.status === s).length]));
  const max = Math.max(1, ...PIPELINE.map((s) => counts[s]));
  const active = tasks.filter((t) => ACTIVE.has(t.status)).length;
  const labelFor = (status) => PIPELINE_COPY[status] ?? [status, ''];
  const stage = (status) => {
    const [label, hint] = labelFor(status);
    const count = counts[status];
    const selected = selectedStatus === status;
    const width = count ? Math.max(5, Math.round((count / max) * 100)) : 0;
    const tone = count ? pipelineTone(status) : 'empty';
    return `<button type="button" class="pipeline-stage pipeline-${tone}${selected ? ' is-selected' : ''}${ACTIVE.has(status) && count ? ' is-live' : ''}" data-pipeline-status="${esc(status)}" aria-pressed="${selected}" aria-label="Show ${count} ${esc(label)} tasks" title="${esc(hint)}">`
      + `<span class="pipeline-node" aria-hidden="true"></span><span class="pipeline-stage-main"><span class="pipeline-stage-meta"><span class="pipeline-stage-label">${esc(label)}</span><span class="pipeline-stage-hint">${esc(hint)}</span></span><span class="pipeline-bar" aria-hidden="true"><span data-w="${width}"></span></span></span><strong class="pipeline-count mono">${fmt(count)}</strong></button>`;
  };
  const exception = (status) => {
    const [label, hint] = labelFor(status);
    const count = counts[status];
    const selected = selectedStatus === status;
    const tone = count ? pipelineTone(status) : 'empty';
    return `<button type="button" class="pipeline-exception pipeline-${tone}${selected ? ' is-selected' : ''}" data-pipeline-status="${esc(status)}" aria-pressed="${selected}" aria-label="Show ${count} ${esc(label)} tasks" title="${esc(hint)}"><span>${esc(label)}</span><strong class="mono">${fmt(count)}</strong></button>`;
  };
  return `<div class="pipeline-summary"><button type="button" class="pipeline-total${selectedStatus === '' ? ' is-selected' : ''}" data-pipeline-status="" aria-pressed="${selectedStatus === ''}" aria-label="Show all ${tasks.length} tasks"><strong class="pipeline-total-value mono">${fmt(tasks.length)}</strong><span><b>tasks tracked</b><small>${fmt(active)} moving · ${fmt(counts.merged)} merged</small></span></button><span class="pipeline-hint">click a stage to filter</span></div>`
    + `<div class="pipeline-flow" role="group" aria-label="Task pipeline">${PIPELINE.map(stage).join('')}</div>`
    + `<div class="pipeline-exceptions"><span class="pipeline-exceptions-label">Attention</span>${SIDE.map(exception).join('')}</div>`;
}

export function renderTasks(tasks, now, ctx = null, meta = {}) {
  const filters = meta.filters ?? {};
  const activeFilters = Object.entries(filters).filter(([, value]) => value).map(([key, value]) => `${key}: ${key === 'status' ? statusLabel(value) : value}`);
  const queueMeta = `<div class="queue-meta"><span><strong>${fmt(tasks.length)}</strong> shown${Number.isInteger(meta.total) && meta.total !== tasks.length ? ` <span class="mut">of ${fmt(meta.total)}</span>` : ''}</span>${activeFilters.length ? `<span class="queue-filter-summary">${esc(activeFilters.join(' · '))}</span><button type="button" class="act" data-clear-filters>Clear filters</button>` : '<span class="mut">priority work first</span>'}</div>`;
  if (!tasks.length) return `${queueMeta}<p class="empty queue-empty">No tasks match the current filters. Clear a filter or wait for new work.</p>`;
  const withActions = Boolean(ctx) && tasks.some((t) => taskActions(t, ctx).length);
  const rows = tasks.map((t) => {
    const budget = t.budget?.tokens ? `${fmt(t.usedTokens)} / ${fmt(t.budget.tokens)}` : fmt(t.usedTokens);
    const pr = Number.isInteger(t.pr) && /^[\w.-]+\/[\w.-]+$/.test(t.repo ?? '')
      ? `<a href="https://github.com/${esc(t.repo)}/pull/${t.pr}" rel="noreferrer">#${t.pr}</a>` : (Number.isInteger(t.pr) ? `#${t.pr}` : '<span class="mut">-</span>');
    const actionName = { resolve: 'Resolve', replan: 'Replan', cancel: 'Cancel' };
    const actions = withActions ? `<td class="acts">${taskActions(t, ctx).map((a) => button(`tasks/${t.id}/${a}`, actionName[a] ?? a, a === 'cancel')).join(' ') || '<span class="mut">-</span>'}</td>` : '';
    return `<tr data-task="${esc(t.id)}" tabindex="0"><td class="mono">${esc(t.id)}</td><td>${esc(t.title)}<span class="sub mono">${esc([t.epicId, t.priority, t.size].filter(Boolean).join(' · '))}</span></td><td data-l="dept">${esc(t.department)}</td>`
      + `<td class="stc"><span class="st st-${esc(t.status)}">${esc(statusLabel(t.status))}</span></td><td class="mono" data-l="holder">${esc(t.holder ?? '-')}</td><td class="num mono" data-l="attempts">${esc(t.attempts ?? 0)}</td>`
      + `<td class="num mono" data-l="tokens">${esc(budget)}</td><td class="num mono" data-l="pr">${pr}</td><td class="num mono" data-l="progress">${esc(ago(t.lastProgressAt ?? t.updatedAt, now))}</td>${actions}</tr>`;
  }).join('');
  return `${queueMeta}<table><thead><tr><th>Task</th><th>Title</th><th>Dept</th><th>Status</th><th>Holder</th><th class="num">Attempts</th><th class="num">Tokens used / budget</th><th class="num">PR</th><th class="num">Last progress</th>${withActions ? '<th>Actions</th>' : ''}</tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
}

export function renderHistory(id, history) {
  if (!history?.length) return `<div class="history"><h3>${esc(id)} history</h3><p class="empty">No state changes recorded yet.</p></div>`;
  return `<div class="history"><h3>${esc(id)} history</h3><ol class="history-list">${history.map((h) => `<li><time class="mut mono">${esc(h.at)}</time><span><b>${esc(statusLabel(h.from ?? '-'))}</b> &rarr; <b>${esc(statusLabel(h.to))}</b><span class="sub">${esc(h.reason ?? 'No reason recorded.')}</span></span></li>`).join('')}</ol></div>`;
}

export function renderManagers(managers, now, ctx = null, pauses = { managers: {} }) {
  if (!managers.length) return '<p class="empty">No managers registered. Create one with <code>orchestrator token add</code>.</p>';
  const withActions = Boolean(ctx) && managers.some((m) => canPauseManager(m, ctx));
  return `<table><thead><tr><th>Manager</th><th>Member</th><th>Departments</th><th>State</th><th class="num">Free slots</th><th>Running</th><th class="num">Last heartbeat</th>${withActions ? '<th>Actions</th>' : ''}</tr></thead><tbody>`
    + managers.map((m) => {
      const paused = pauses.managers?.[m.name];
      const state = paused ? `<span class="mg mg-offline">paused</span> <span class="mut">${esc(paused.reason)}</span>` : `<span class="mg mg-${esc(m.state)}">${esc(m.state)}</span>`;
      const act = withActions ? `<td class="acts">${canPauseManager(m, ctx) ? button(`managers/${m.name}/${paused ? 'resume' : 'pause'}`, paused ? 'resume' : 'pause') : '<span class="mut">-</span>'}</td>` : '';
      return `<tr><td class="mono">${esc(m.name)}</td><td data-l="member">${esc(m.member ?? '-')}</td><td data-l="depts">${esc((m.departments ?? []).join(', ') || '-')}</td><td class="stc">${state}</td><td class="num mono" data-l="free">${esc(m.freeSlots ?? '-')}</td>`
        + `<td class="mono" data-l="running">${esc((m.running ?? []).join(', ') || '-')}</td><td class="num mono" data-l="heartbeat">${esc(ago(m.lastHeartbeat, now))}</td>${act}</tr>`;
    }).join('')
    + '</tbody></table>';
}

/** One row per department: agent, paths (full list in the title), concurrency, task counts, managers, pause. */
export function renderDepartments(snapshot = {}) {
  const stats = departmentStats(snapshot);
  if (!stats.length) return '<p class="empty">No departments configured.</p>';
  const info = Object.fromEntries((snapshot.departmentInfo ?? []).map((d) => [d.id, d]));
  const rows = stats.map((d) => {
    const dept = info[d.name] ?? {};
    const paths = dept.paths ?? [];
    const pathCell = paths.length
      ? `<span title="${esc(paths.join('\n'))}">${esc(clip(paths[0], 28))}${paths.length > 1 ? ` <span class="mut">+${paths.length - 1} more</span>` : ''}</span>`
      : '<span class="mut">-</span>';
    const online = d.managers.filter((m) => m.state !== 'offline');
    const managers = d.managers.map((m) => `<span class="mg mg-${esc(m.state)}">${esc(m.name)} ${esc(m.state)}</span>`).join(' ') || '<span class="mut">none</span>';
    const warn = online.length ? '' : ' <span class="neg">! no manager online</span>';
    const state = d.paused ? `<span class="warn">paused</span> <span class="mut">${esc(d.paused.reason)}</span>` : '<span class="mut">running</span>';
    return `<tr data-dept="${esc(d.name)}" data-dept-filter="${esc(d.name)}" tabindex="0"><td class="mono"><button type="button" class="table-link mono" data-dept-filter="${esc(d.name)}">${esc(d.name)}</button></td><td class="mono" data-l="agent">${esc(dept.agent ?? '-')}</td><td class="mono" data-l="paths">${pathCell}</td>`
      + `<td class="num mono" data-l="concurrency">${esc(dept.concurrency ?? '-')}</td><td class="num mono" data-l="queued">${esc(d.queued)}</td><td class="num mono" data-l="running">${esc(d.active)}</td><td class="num mono" data-l="merged">${esc(d.merged)}</td>`
      + `<td data-l="managers">${managers}${warn}</td><td class="stc" data-l="state">${state}</td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Department</th><th>Agent</th><th>Paths</th><th class="num">Concurrency</th><th class="num">Queued</th><th class="num">Running</th><th class="num">Merged</th><th>Managers</th><th>State</th></tr></thead>`
    + `<tbody>${rows}</tbody></table>`;
}

export function renderEpics(epics, tasks, ctx = null) {
  if (!epics.length) return '<p class="empty">No epics. Open an issue labelled epic, or create one in Controls.</p>';
  return '<div class="epic-list">' + epics.map((e) => {
    const mine = tasks.filter((t) => t.epicId === e.id);
    const merged = mine.filter((t) => t.status === 'merged').length;
    const cancelled = mine.filter((t) => t.status === 'cancelled').length;
    const pct = (n) => (mine.length ? Math.round((n / mine.length) * 100) : 0);
    const counts = [merged || !cancelled ? `${fmt(merged)} merged` : null, cancelled ? `${fmt(cancelled)} cancelled` : null].filter(Boolean).join(' · ');
    const status = epicStatus(e, mine);
    // An epic with no tasks yet can be planned from here by the owner: a dry run first.
    const plan = ctx?.owner && !mine.length ? `<button type="button" class="act" data-plan="${esc(e.id)}">Plan tasks</button>` : '';
    return `<article class="epic-row"><div class="epic-row-head"><button type="button" class="epic-id mono" data-epic-filter="${esc(e.id)}">${esc(e.id)}</button><span class="epic-status epic-status-${esc(status)}">${esc(status)}</span></div><p class="epic-title">${esc(e.title)}</p><div class="epic-progress"><span class="epic-progress-merged" data-w="${pct(merged)}"></span><span class="epic-progress-cancelled" data-w="${pct(cancelled)}"></span></div><div class="epic-row-foot"><span class="mono">${fmt(merged)} / ${fmt(mine.length)} complete</span><span class="mut">${mine.length ? counts : 'not planned'}</span>${plan}</div></article>`;
  }).join('') + '</div>';
}

/** A plan job: running, failed, or the proposed tasks with a commit button (dry run) / the created tasks. */
export function renderPlan(epicId, job) {
  if (!job) return '';
  if (job.status === 'running') return `<p class="mut">Planning ${esc(epicId)}… the model call can take a minute.</p>`;
  if (job.status === 'failed') return `<p class="down">Planning ${esc(epicId)} failed: ${esc(job.error)}</p>`;
  const r = job.result ?? {};
  const rows = (r.tasks ?? []).map((t) => `${esc((t.id ?? t.key ?? '').padEnd(8))} ${esc(String(t.department ?? '').padEnd(9))} ${esc(String(t.size ?? t.status ?? '').padEnd(4))} ${esc(t.title)}${t.dependsOn?.length ? ` <span class="mut">after ${esc(t.dependsOn.join(','))}</span>` : ''}`).join('\n');
  const head = r.written ? `Planned ${esc(epicId)}: ${(r.tasks ?? []).length} tasks created with ${esc(r.model)}.` : `Dry run for ${esc(epicId)}: ${(r.tasks ?? []).length} tasks proposed by ${esc(r.model)}. Nothing written yet.`;
  return `<h3>${head}</h3><pre class="log">${rows || '<span class="mut">no tasks</span>'}</pre>${r.written ? '' : button(`epics/${epicId}/plan`, 'commit this plan')}`;
}

/** Orchestrator, bus and watchdog health as a compact status strip. */
export function renderService(service, health, online, now) {
  const parts = [];
  if (service) {
    const up = service.uptimeSeconds ?? 0;
    const upText = up >= 86400 ? `${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h` : up >= 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m`;
    const f = service.features ?? {};
    const flag = (k, label) => `${label} <span class="${f[k] ? 'ok' : 'mut'}">${f[k] ? 'on' : 'off'}</span>`;
    parts.push(`<span class="service-item"><b>orchestrator</b> <span class="${online ? 'ok' : 'neg'}">${online ? 'online' : 'offline'}</span><span class="mut">${esc(service.version ?? '?')} · up ${esc(upText)}</span></span>`);
    parts.push(`<span class="service-item service-features"><span class="mut">loops</span> ${flag('review', 'review')} ${flag('intake', 'intake')} ${flag('dispatch', 'dispatch')} ${flag('planCmd', 'planner')}</span>`);
  } else parts.push(`<span class="service-item"><b>orchestrator</b> <span class="${online ? 'ok' : 'neg'}">${online ? 'online' : 'offline'}</span></span>`);
  if (health?.bus) parts.push(`<span class="service-item"><b>bus</b> <span class="${health.bus === 'ok' ? 'ok' : 'neg'}">${esc(health.bus)}</span></span>`);
  if (health?.watchdog) parts.push(`<span class="service-item"><b>watchdog</b> <span class="${health.watchdog.state === 'up' ? 'ok' : 'neg'}">${esc(health.watchdog.state)}</span><span class="mut">${esc(ago(health.watchdog.since, now))}</span></span>`);
  return `<span class="service-strip">${parts.join('')}</span>`;
}

/** Everything the snapshot knows about one task, then its history. */
export function renderTaskDetail(task, history) {
  if (!task) return renderHistory('?', history);
  const list = (xs) => (xs?.length ? `<ul>${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="mut">None</span>');
  const findings = task.review?.findings?.length ? list(task.review.findings.map((f) => typeof f === 'string' ? f : JSON.stringify(f))) : '<span class="mut">No review findings.</span>';
  const field = (label, value, cls = '') => `<div class="task-detail-field ${cls}"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
  return `<div class="task-detail"><div class="task-detail-head"><div><span class="mono task-detail-id">${esc(task.id)}</span><h3>${esc(task.title)}</h3></div><span class="st st-${esc(task.status)}">${esc(statusLabel(task.status))}</span></div><dl class="task-detail-grid">`
    + field('Epic', `${esc(task.epicId)} · ${esc(task.priority ?? 'normal')} · size ${esc(task.size ?? '-')}`)
    + field('Department', `<span class="mono">${esc(task.department)}</span>`)
    + field('Holder', `<span class="mono">${esc(task.holder ?? 'unassigned')}</span>`)
    + field('Phase', `${esc(task.lastPhase ?? 'not started')}${task.lastNote ? `<span class="sub">${esc(task.lastNote)}</span>` : ''}`)
    + field('Paths', list(task.paths), 'task-detail-wide')
    + field('Acceptance', list(task.acceptance), 'task-detail-wide')
    + field('Depends on', list(task.dependsOn), 'task-detail-wide')
    + field('Branch', task.branch ? `<code>${esc(task.branch)}</code>` : '<span class="mut">None yet</span>')
    + field('Review findings', findings, 'task-detail-wide')
    + `</dl></div>${renderHistory(task.id, history)}`;
}

/** Owner token list with revoke buttons, and the create form. */
export function renderTokens(tokens, departments = []) {
  const rows = (tokens ?? []).map((t) => `<tr><td class="mono">${esc(t.name)}</td><td>${esc(t.member)}</td><td>${esc(t.roles.join(', '))}</td><td>${esc(t.departments.join(', ') || '-')}</td><td class="num mono">${esc(t.createdAt ? t.createdAt.slice(0, 10) : '-')}</td><td class="acts">${button(`tokens/${t.name}/revoke`, 'revoke', true)}</td></tr>`).join('');
  const table = rows ? `<table><thead><tr><th>Name</th><th>Member</th><th>Roles</th><th>Departments</th><th class="num">Created</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="empty">No tokens.</p>';
  const depts = departments.map((d) => `<label class="chk"><input type="checkbox" name="departments" value="${esc(d)}"> ${esc(d)}</label>`).join('');
  return `${table}<form id="token-form" class="token-form"><h3>New token</h3>`
    + '<label>Name <input name="name" placeholder="member-department" pattern="[a-z][a-z0-9-]{0,63}" required></label>'
    + '<label>Member (GitHub login) <input name="member" required></label>'
    + '<label>Role <select name="role"><option value="manager">manager</option><option value="dashboard">dashboard (read only)</option><option value="owner">owner</option><option value="intake">intake</option></select></label>'
    + `<fieldset><legend>Departments</legend>${depts}</fieldset>`
    + '<label>Reason <input name="reason" minlength="3" required></label><button type="submit">Create token</button></form>'
    + '<div id="token-once" hidden></div>';
}

export function renderAlerts(alerts, now, expanded = false) {
  if (!alerts.length) return '<p class="empty">No alerts on the swarm channel.</p>';
  const rows = alerts.map((a) => {
    const level = /^(CRITICAL|WARN|INFO)\b/.exec(a.content)?.[1]?.toLowerCase() ?? 'info';
    const title = a.content.split('\n')[0];
    return `<li class="activity-row al-${level}"><span class="activity-level">${esc(level)}</span><time class="mut mono" datetime="${esc(a.at)}">${esc(hms(a.at))}</time><span class="who">${esc(clip(a.from, 18))}</span><span class="activity-content">${esc(title)}</span><span class="mut activity-age">${esc(ago(a.at, now))}</span></li>`;
  }).join('');
  return `<div class="activity-disclosure${expanded ? ' is-open' : ''}"><button type="button" class="activity-toggle" data-activity-toggle aria-expanded="${expanded}" aria-controls="activity-log-body"><span><strong>${fmt(alerts.length)}</strong> signals · ${expanded ? 'full log' : 'latest entries'}</span><span>${expanded ? 'Collapse' : 'Show all'}</span></button><div id="activity-log-body" class="activity-body"><ul class="activity-list">${rows}</ul></div></div>`;
}

/** Run-health cards and context computed from the snapshot's metrics. */
export function renderMetrics(metrics = {}) {
  const counts = metrics.statusCounts ?? {};
  const count = (state) => Number(counts[state] ?? 0);
  const open = Object.entries(counts).filter(([s]) => s !== 'merged' && s !== 'cancelled').reduce((n, [, v]) => n + Number(v || 0), 0);
  const queued = count('queued');
  const active = ['leased', 'in_progress', 'submitted', 'in_review', 'changes_requested'].reduce((n, state) => n + count(state), 0);
  const merged = Number(metrics.merged?.count ?? counts.merged ?? 0);
  const attention = ['needs-human', 'escalated', 'failed', 'blocked'].reduce((n, state) => n + count(state), 0);
  const lead = metrics.merged?.leadTimeMinutes?.count ? `median lead ${fmt(metrics.merged.leadTimeMinutes.median)} min` : 'no completed tasks yet';
  const status = Object.entries(counts).map(([k, v]) => `${esc(statusLabel(k))} ${fmt(v)}`).join(' · ') || 'No tasks reported';
  const queue = Object.entries(metrics.queueDepth ?? {}).map(([k, v]) => `${esc(k)} ${fmt(v)}`).join(' · ') || 'Queue is empty';
  const openNote = open ? `${fmt(queued)} queued · ${fmt(active)} active` : 'no queued or active work';
  const cells = [
    { label: 'In flight', value: fmt(active), note: `${fmt(metrics.leasesHeld)} leases held now`, tone: 'accent' },
    { label: 'Queued', value: fmt(queued), note: openNote, tone: queued ? 'warning' : 'positive' },
    { label: 'Attention', value: fmt(attention), note: attention ? 'blocked or needs a person' : 'nothing stuck', tone: attention ? 'warning' : 'positive' },
    { label: 'Delivered', value: fmt(merged), note: lead, tone: 'positive' },
    { label: 'Budget risk', value: fmt(metrics.overBudget), note: 'tasks at ≥80% of token limit', tone: metrics.overBudget ? 'warning' : 'neutral' },
  ];
  return `<div class="kpis">${cells.map(({ label, value, note, tone }) => `<div class="kpi kpi-${tone}"><span class="kpi-label">${esc(label)}</span><strong class="kpi-value mono">${esc(value)}</strong><span class="kpi-note">${esc(note)}</span></div>`).join('')}</div>`
    + `<div class="metrics-detail"><div><span class="lbl">State mix</span><span class="mono">${status}</span></div><div><span class="lbl">Queue pressure</span><span class="mono">${queue}</span></div><div><span class="lbl">Reported token spend</span><span class="mono">${fmt(metrics.totalTokens)} tokens across all tasks</span></div></div>`;
}

// ---- controls. The orchestrator re-checks every permission; these only decide which buttons show.

const TERMINAL = new Set(['merged', 'cancelled']);

/** { owner, manager, member, memberOf(managerName) } for the signed-in viewer. */
export function viewerContext({ viewerRoles = [], viewerMember = null } = {}, managers = []) {
  const members = new Map(managers.map((m) => [m.name, m.member]));
  return {
    owner: viewerRoles.includes('owner'),
    manager: viewerRoles.includes('manager'),
    member: viewerMember,
    memberOf: (name) => members.get(name) ?? null,
  };
}

/** Operator actions this viewer may take on a task in its current status. */
export function taskActions(task, ctx) {
  if (!ctx || TERMINAL.has(task.status)) return [];
  const mine = ctx.owner || (ctx.manager && task.holder && ctx.memberOf(task.holder) === ctx.member);
  if (!mine) return [];
  return [
    ...(task.status === 'needs-human' ? ['resolve'] : []),
    ...(task.status === 'escalated' ? ['replan'] : []),
    'cancel',
  ];
}

export const canPauseManager = (m, ctx) => Boolean(ctx && (ctx.owner || (ctx.manager && m.member && m.member === ctx.member)));

/** What an action will do, shown in the confirm dialog. */
export function describeAction(path) {
  const m = /^(tasks\/([^/]+)\/(resolve|replan|cancel)|pause|resume|departments\/([^/]+)\/(pause|resume)|managers\/([^/]+)\/(pause|resume)|epics\/[^/]+\/plan|intake|backup|tokens\/[^/]+\/revoke)$/.exec(path);
  if (!m) return 'Unknown action.';
  if (m[3] === 'cancel') return `Cancel task ${m[2]}. It stops for good: any running work is dropped and it is never merged. This cannot be undone.`;
  if (m[3] === 'resolve') return `Mark task ${m[2]} resolved by a person: it leaves needs-human.`;
  if (m[3] === 'replan') return `Send task ${m[2]} back to planning: it leaves escalated and is planned again.`;
  const e = /^epics\/([^/]+)\/plan$/.exec(path);
  if (e) return `Commit the plan for ${e[1]}: the planner runs again and its tasks are created and queued for the managers.`;
  if (path === 'intake') return 'Run one intake pass now: open issues labelled epic by members become epics.';
  if (path === 'backup') return 'Back up the orchestrator database now (a new file in ~/.swarm/backups).';
  const k = /^tokens\/([^/]+)\/revoke$/.exec(path);
  if (k) return `Revoke token ${k[1]}: anything using it is refused from now on. This cannot be undone; a new token can be created.`;
  if (path === 'pause') return 'Pause the WHOLE swarm: no manager leases, no dispatch, no merges, until someone resumes. Running tasks finish but do not merge.';
  if (path === 'resume') return 'Resume the whole swarm: leasing, dispatch and merging start again.';
  if (m[4]) return m[5] === 'pause' ? `Pause department ${m[4]}: no manager leases its tasks; running tasks finish.` : `Resume department ${m[4]}: its tasks can be leased again.`;
  return m[7] === 'pause' ? `Pause manager ${m[6]}: it leases nothing new; its running task finishes.` : `Resume manager ${m[6]}: it can lease again.`;
}

const button = (path, label, danger = false) => `<button type="button" class="act${danger ? ' danger' : ''}" data-action="${esc(path)}">${esc(label)}</button>`;

/** Swarm and department pause state, with buttons for the owner, and the new-epic form for any member. */
export function renderControls(snapshot, ctx, departments = []) {
  const pauses = snapshot.pauses ?? { departments: {}, managers: {} };
  const global = snapshot.paused
    ? `<div class="control-state down"><b>Dispatch paused</b><span>new leases and merges are stopped</span></div>${ctx?.owner ? button('resume', 'Resume swarm') : ''}`
    : `<div class="control-state ok"><b>Dispatch running</b><span>managers can lease and advance work</span></div>${ctx?.owner ? button('pause', 'Pause swarm', true) : ''}`;
  const ops = ctx?.owner ? `<div class="ops"><div><b>Run intake</b><span class="sub">import new epic issues now</span>${button('intake', 'Run intake')}</div><div><b>Database backup</b><span class="sub">write a fresh recovery copy</span>${button('backup', 'Back up')}</div></div>` : '';
  const depts = departments.map((d) => {
    const p = pauses.departments?.[d];
    return `<li><span class="mono">${esc(d)}</span> ${p ? `<span class="down">paused</span> <span class="mut">${esc(p.reason)} (${esc(p.by)})</span>` : '<span class="mut">running</span>'} `
      + `${ctx?.owner ? button(`departments/${d}/${p ? 'resume' : 'pause'}`, p ? 'resume' : 'pause') : ''}</li>`;
  }).join('');
  const epic = ctx?.manager || ctx?.owner
    ? '<form id="epic-form" class="epic-form"><h3>Start an epic</h3><p class="sub">Create a workstream, then plan its tasks from the Epics panel.</p><label>Title <input name="title" maxlength="200" required></label>'
      + '<label>Description <textarea name="body" rows="3" maxlength="20000"></textarea></label><button type="submit">Create epic</button></form>'
    : '';
  return `<div class="ctl"><div class="control-block"><h3>Dispatch</h3>${global}${ops}</div><div class="control-block"><h3>Department gates</h3><ul class="plain">${depts || '<li>none</li>'}</ul></div><div class="control-block control-create">${epic}</div></div>`;
}
