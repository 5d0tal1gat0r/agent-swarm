import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderDepartments, renderPlan, renderService, renderTaskDetail, renderTokens, canPauseManager, departmentStats, describeAction, esc, findingOf, renderPipeline, renderTopology, renderTopologyTree, filterOptions, filterTasks, renderAlerts, renderBanner, renderControls, renderEpics, renderHistory, renderManagers, renderMetrics, renderTasks, taskActions, viewerContext } from '../src/static/render.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const task = (patch) => ({ id: 'T-0001', epicId: 'E-0001', repo: 'example-org/agent-coordination', title: 'one', department: 'core', status: 'queued', holder: null, attempts: 0, usedTokens: 10, budget: { tokens: 1000 }, pr: null, lastProgressAt: null, updatedAt: '2026-11-02T11:58:00Z', ...patch });

describe('dashboard render', () => {
  it('escapes everything that reaches the page', () => {
    assert.equal(esc('<img src=x onerror=alert(1)>"\''), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;');
    const html = renderTasks([task({ title: '<script>alert(1)</script>', holder: '"><b>' })], NOW);
    assert.doesNotMatch(html, /<script>|"><b>/);
    assert.doesNotMatch(renderAlerts([{ at: '2026-11-02T11:59:00Z', from: '<x>', content: '<img src=x>' }], NOW), /<img|<x>/);
    assert.doesNotMatch(renderEpics([{ id: 'E-1', title: '<svg onload=1>' }], []), /<svg/);
  });

  it('tasks table: one row per task with status, holder, tokens vs budget and a PR link', () => {
    const html = renderTasks([task({ status: 'in_progress', holder: 'me-core', pr: 42, usedTokens: 500 })], NOW);
    assert.match(html, /data-task="T-0001"/);
    assert.match(html, /st-in_progress/);
    assert.match(html, /me-core/);
    assert.match(html, /500 \/ 1,000/);
    assert.match(html, /href="https:\/\/github\.com\/example-org\/agent-coordination\/pull\/42"/);
    assert.match(renderTasks([], NOW), /No tasks match/);
  });

  it('filters by status, department and epic, active work first', () => {
    const tasks = [task({ id: 'T-3', status: 'merged' }), task({ id: 'T-2', status: 'in_progress', department: 'qa' }), task({ id: 'T-1', status: 'queued', epicId: 'E-2' })];
    assert.deepEqual(filterTasks(tasks).map((t) => t.id), ['T-2', 'T-1', 'T-3']);
    assert.deepEqual(filterTasks(tasks, { department: 'qa' }).map((t) => t.id), ['T-2']);
    assert.deepEqual(filterTasks(tasks, { epic: 'E-2' }).map((t) => t.id), ['T-1']);
    assert.deepEqual(filterOptions(tasks).status, ['in_progress', 'merged', 'queued']);
  });

  it('managers, epics, alerts, metrics and history render from fixture data', () => {
    assert.match(renderManagers([{ name: 'me-core', state: 'busy', freeSlots: 0, running: ['T-1'], lastHeartbeat: NOW - 30_000 }], NOW), /mg-busy.*T-1.*30s ago/s);
    const epics = renderEpics([{ id: 'E-1', title: 'Queue inspection', status: 'planned' }], [task({ epicId: 'E-1', status: 'merged' }), task({ epicId: 'E-1' })]);
    assert.match(epics, /planned.*1 \/ 2 complete/s);
    // Once every task is finished the epic reads done or cancelled, whatever its stored status.
    assert.match(renderEpics([{ id: 'E-1', title: 'x', status: 'open' }], [task({ epicId: 'E-1', status: 'cancelled' })]), /epic-status-cancelled/);
    assert.match(renderEpics([{ id: 'E-1', title: 'x' }], [task({ epicId: 'E-1', status: 'merged' }), task({ epicId: 'E-1', status: 'cancelled' })]), /epic-status-done/);
    assert.match(renderEpics([{ id: 'E-1', title: 'x' }], []), /epic-status-open/);
    // A cancelled task is finished but not complete: it must not fill the bar in the done colour.
    const cancelled = renderEpics([{ id: 'E-1', title: 'x' }], [task({ epicId: 'E-1', status: 'cancelled' })]);
    assert.match(cancelled, /0 \/ 1 complete/);
    assert.match(cancelled, /1 cancelled/);
    assert.match(cancelled, /epic-progress-merged" data-w="0"/);
    assert.match(cancelled, /epic-progress-cancelled" data-w="100"/);
    const mixed = renderEpics([{ id: 'E-1', title: 'x' }], [task({ epicId: 'E-1', status: 'merged' }), task({ epicId: 'E-1', status: 'cancelled' })]);
    assert.match(mixed, /1 \/ 2 complete/);
    assert.match(mixed, /1 merged · 1 cancelled/);
    assert.match(renderAlerts([{ at: '2026-11-02T11:55:00Z', from: 'swarm-orchestrator', content: 'CRITICAL alert.manager_down manager:me-core: no heartbeat' }], NOW), /al-critical.*5m ago/s);
    assert.match(renderAlerts([{ at: '2026-11-02T11:55:00Z', from: 'swarm-orchestrator', content: 'INFO healthy' }], NOW), /activity-toggle.*aria-expanded="false".*latest entries/s);
    assert.match(renderAlerts([{ at: '2026-11-02T11:55:00Z', from: 'swarm-orchestrator', content: 'INFO healthy' }], NOW, true), /activity-disclosure is-open.*aria-expanded="true".*Collapse/s);
    const metrics = renderMetrics({ statusCounts: { queued: 2 }, queueDepth: { core: 2 }, leasesHeld: 1, totalTokens: 9 });
    assert.match(metrics, /In flight.*0.*Queued.*2.*Attention.*0/s);
    assert.match(metrics, /State mix.*Queued 2.*Queue pressure.*core 2/s);
    assert.match(metrics, /Budget risk.*tasks at ≥80% of token limit/s);
    assert.match(renderHistory('T-1', [{ from: 'queued', to: 'leased', at: 'x', reason: 'leased by me-core' }]), /Queued<\/b> &rarr; <b>Leased<\/b>.*leased by me-core/s);
  });

  it('banner: online, offline with a last snapshot, offline with none', () => {
    assert.match(renderBanner({ online: true, fetchedAt: NOW - 5000 }, NOW), /online.*5s ago/);
    assert.match(renderBanner({ online: false, offlineSince: NOW - 600_000, fetchedAt: NOW - 700_000 }, NOW), /offline since 2026-11-02T11:50:00.000Z.*last snapshot/);
    assert.match(renderBanner({ online: false, offlineSince: NOW, fetchedAt: null, error: 'refused' }, NOW), /No data yet: refused/);
  });

  it('controls: buttons only for allowed roles and valid moves', () => {
    const managers = [{ name: 'alice-core', member: 'alice' }, { name: 'bob-core', member: 'bob' }];
    const alice = viewerContext({ viewerRoles: ['manager'], viewerMember: 'alice' }, managers);
    const owner = viewerContext({ viewerRoles: ['manager', 'owner'], viewerMember: 'o' }, managers);
    const dash = viewerContext({ viewerRoles: ['dashboard'], viewerMember: 'o' }, managers);
    assert.deepEqual(taskActions(task({ holder: 'alice-core', status: 'needs-human' }), alice), ['resolve', 'cancel']);
    assert.deepEqual(taskActions(task({ holder: 'alice-core', status: 'escalated' }), alice), ['replan', 'cancel']);
    assert.deepEqual(taskActions(task({ holder: 'bob-core', status: 'in_progress' }), alice), [], 'not her manager');
    assert.deepEqual(taskActions(task({ holder: null, status: 'queued' }), owner), ['cancel']);
    assert.deepEqual(taskActions(task({ holder: 'alice-core', status: 'merged' }), owner), [], 'terminal');
    assert.deepEqual(taskActions(task({ holder: 'alice-core', status: 'queued' }), dash), []);
    assert.equal(canPauseManager(managers[0], alice), true);
    assert.equal(canPauseManager(managers[1], alice), false);
    const rows = renderTasks([task({ holder: 'alice-core', status: 'needs-human' })], NOW, alice);
    assert.match(rows, /data-action="tasks\/T-0001\/resolve"/);
    assert.match(rows, /class="act danger" data-action="tasks\/T-0001\/cancel"/);
    assert.doesNotMatch(renderTasks([task()], NOW), /data-action/, 'no context, no buttons');
    assert.match(renderManagers(managers, NOW, alice, { managers: { 'alice-core': { reason: 'away' } } }), /paused.*away.*data-action="managers\/alice-core\/resume"/s);
    // An Actions column only when at least one row has an action: no column of dashes.
    const idle = renderTasks([task({ holder: 'alice-core', status: 'merged' })], NOW, alice);
    assert.doesNotMatch(idle, /<th>Actions<\/th>|class="acts"/);
    assert.match(rows, /<th>Actions<\/th>/);
    const mixed = renderTasks([task({ holder: 'alice-core', status: 'needs-human' }), task({ id: 'T-0002', holder: 'alice-core', status: 'merged' })], NOW, alice);
    assert.equal((mixed.match(/<td class="acts">/g) ?? []).length, 2, 'every row keeps the cell once the column exists');
    assert.doesNotMatch(renderManagers([managers[1]], NOW, alice), /<th>Actions<\/th>/, 'nothing she may pause');
    assert.match(renderManagers(managers, NOW, alice), /<th>Actions<\/th>/);
  });

  it('controls section: global and department pause for the owner only, epic form for members', () => {
    const snap = { paused: false, pauses: { departments: { qa: { reason: 'flaky', by: 'o' } }, managers: {} } };
    const owner = viewerContext({ viewerRoles: ['manager', 'owner'] }, []);
    const member = viewerContext({ viewerRoles: ['manager'] }, []);
    const html = renderControls(snap, owner, ['core', 'qa']);
    assert.match(html, /data-action="pause"/);
    assert.match(html, /class="act" data-action="departments\/core\/pause"/);
    assert.match(html, /qa.*paused.*flaky.*data-action="departments\/qa\/resume"/s);
    const m = renderControls(snap, member, ['core']);
    assert.doesNotMatch(m, /data-action/);
    assert.match(m, /id="epic-form"/);
    assert.doesNotMatch(renderControls(snap, null, ['core']), /epic-form|data-action/, 'offline or read-only: nothing to press');
    assert.match(renderControls({ ...snap, paused: true }, owner, []), /Dispatch paused.*data-action="resume"/s);
  });

  it('confirm text says exactly what an action does', () => {
    assert.match(describeAction('tasks/T-1/cancel'), /Cancel task T-1.*cannot be undone/);
    assert.match(describeAction('pause'), /WHOLE swarm/);
    assert.match(describeAction('departments/qa/pause'), /department qa/);
    assert.match(describeAction('managers/alice-core/resume'), /Resume manager alice-core/);
    assert.equal(describeAction('../x'), 'Unknown action.');
  });

  it('topology: one live node per department with counts, routes only on active links', () => {
    const snap = {
      departments: ['core', 'qa'],
      tasks: [task({ id: 'T-1', status: 'in_progress', department: 'core' }), task({ id: 'T-2', status: 'queued', department: 'qa' }), task({ id: 'T-3', status: 'merged', department: 'core' })],
      managers: [{ name: 'me-core', state: 'busy', departments: ['core'], running: ['T-1'], freeSlots: 0 }],
      pauses: { departments: {}, managers: {} },
    };
    const f0 = renderTopology(snap, 0);
    assert.match(f0, /orchestrator/);
    assert.match(f0, /core/);
    assert.match(f0, /data-topology-dept="core"/);
    assert.match(f0, /<span>core<\/span><small>1 run · 0 q<\/small>/, 'core running count');
    assert.match(f0, /data-topology-dept="qa"/);
    assert.match(f0, /<span>qa<\/span><small>no manager online · 1 queued<\/small>/, 'qa queue count');
    assert.equal((f0.match(/class="topology-packet"/g) ?? []).length, 1, 'one packet: only core has active work');
    assert.notEqual(renderTopology(snap, 1), f0, 'the next frame moves the packet');
    assert.match(f0, /no manager online/, 'qa shows it has no manager');
    assert.match(renderTopology(snap, 0, false), /offline/);
    // Work counts live in the summary line and System pulse; the orchestrator card shows capacity.
    assert.doesNotMatch(f0, /tasks moving/);
    assert.match(f0, /<b>0<\/b><small>free slots<\/small>/);
    assert.match(f0, /<b>2<\/b><small>departments<\/small>/);
    const paused = renderTopology({ ...snap, pauses: { departments: { core: { reason: 'x' } }, managers: {} } }, 0);
    assert.doesNotMatch(paused, /class="topology-packet"/, 'a paused department carries no packets');
    assert.doesNotMatch(renderTopology({ departments: ['<x>'], tasks: [], managers: [] }), /<x>/, 'names escaped');
  });

  it('pipeline: clickable stages expose counts, labels, and selected state', () => {
    const out = renderPipeline([task({ status: 'queued' }), task({ status: 'queued' }), task({ status: 'in_progress' }), task({ status: 'needs-human' }), task({ status: 'blocked' })], 'queued');
    assert.match(out, /class="pipeline-summary"/);
    assert.match(out, /data-pipeline-status="queued" aria-pressed="true"/);
    assert.match(out, /<span class="pipeline-stage-label">Queued<\/span>/);
    assert.match(out, /<strong class="pipeline-count mono">2<\/strong>/);
    assert.match(out, /data-pipeline-status="needs-human"/);
    assert.match(out, /<span>Needs human<\/span><strong class="mono">1<\/strong>/);
    assert.match(out, /class="pipeline-stage pipeline-neutral is-selected"/);
    assert.match(out, /class="pipeline-stage pipeline-active is-live"/);
    assert.match(out, /class="pipeline-stage pipeline-empty"[^>]*data-pipeline-status="leased"/);
    assert.match(out, /class="pipeline-exception pipeline-warning"[^>]*data-pipeline-status="blocked"/);
    assert.match(out, /class="pipeline-exception pipeline-empty"[^>]*data-pipeline-status="escalated"/);
    assert.deepEqual([...out.matchAll(/class="pipeline-stage [^"]*" data-pipeline-status="([^"]+)"/g)].map(([, status]) => status), [
      'in_progress', 'queued', 'in_review', 'changes_requested', 'leased', 'submitted', 'merged',
    ]);
  });

  it('finding: the most urgent fact first', () => {
    const base = { tasks: [], managers: [], departments: ['qa'], pauses: { departments: {}, managers: {} } };
    assert.match(findingOf({ ...base, paused: true }), /whole swarm is paused/);
    assert.match(findingOf({ ...base, tasks: [task({ status: 'needs-human' })] }), /1 task needs a person \(needs-human\): T-0001\./);
    assert.match(findingOf({ ...base, tasks: [task({ status: 'failed' }), task({ status: 'escalated' })] }), /2 tasks failed or escalated/);
    assert.match(findingOf({ ...base, tasks: [task({ status: 'queued', department: 'qa' })] }), /qa has 1 queued and no manager online/);
    assert.match(findingOf({ ...base, tasks: [task({ status: 'in_progress', department: 'qa' })], managers: [{ name: 'm', state: 'busy', departments: ['qa'] }] }), /1 task moving, 0 queued, nothing stuck/);
    assert.match(findingOf(base), /No tasks yet/);
    assert.deepEqual(departmentStats({ ...base, tasks: [task({ status: 'queued', department: 'qa' })] })[0].queued, 1);
  });

  it('topology tree for phones: managers own task-backed subagent leaves', () => {
    const snap = { departments: ['core', 'qa'], tasks: [task({ status: 'in_progress', department: 'core' }), task({ status: 'queued', department: 'qa' })],
      managers: [{ name: 'me-core', state: 'busy', departments: ['core'], running: ['T-0001'], freeSlots: 0 }], pauses: { departments: {}, managers: {} } };
    const out = renderTopologyTree(snap, 0);
    assert.match(out, /topology-tree-root/);
    assert.match(out, /topology-tree-manager topology-lane-busy/);
    assert.match(out, /topology-tree-name mono"><i class="topology-manager-dot pk"><\/i>me-core/);
    assert.match(out, /data-topology-task="T-0001"/);
    assert.match(out, /task details unavailable|one/);
    assert.notEqual(renderTopologyTree(snap, 1), out);
  });

  it('topology keeps configured subagent slots visible while their states change', () => {
    const base = { departments: ['core'], departmentInfo: [{ id: 'core', maxSubagents: 6 }], tasks: [],
      managers: [{ name: 'me-core', state: 'idle', departments: ['core'], running: [], freeSlots: 2 }], pauses: { departments: {}, managers: {} } };
    const idle = renderTopology(base);
    assert.equal((idle.match(/class="topology-subagent topology-subagent-ready"/g) ?? []).length, 0);
    assert.match(idle, /subagent pool offline/);
    const active = renderTopology({ ...base, tasks: [task({ status: 'in_progress' })], managers: [{ ...base.managers[0], state: 'busy', running: ['T-0001'], freeSlots: 1 }] });
    assert.match(active, /data-topology-task="T-0001"/);
    assert.equal((active.match(/class="topology-subagent topology-subagent-ready"/g) ?? []).length, 0);
    assert.match(active, /\+5 more slots/);
    const offline = renderTopology({ ...base, managers: [{ ...base.managers[0], state: 'offline' }] }, 0, false);
    assert.equal((offline.match(/class="topology-subagent topology-subagent-offline"/g) ?? []).length, 0);
    assert.match(offline, /subagent pool offline/);
  });

  it('topology keeps the full manager roster visible, including offline branches', () => {
    const snap = { departments: ['core', 'qa'], departmentInfo: [{ id: 'core', maxSubagents: 1 }, { id: 'qa', maxSubagents: 1 }], tasks: [],
      managers: [
        { name: 'remote-qa', state: 'offline', departments: ['qa'], running: [], freeSlots: null },
        { name: 'me-core', state: 'idle', departments: ['core'], running: [], freeSlots: 1 },
      ], pauses: { departments: {}, managers: {} } };
    const out = renderTopology(snap);
    assert.match(out, /data-topology-manager="me-core"/);
    assert.match(out, /data-topology-manager="remote-qa"/);
    assert.match(out, /topology-manager-lane topology-lane-offline/);
    assert.ok(out.indexOf('data-topology-manager="me-core"') < out.indexOf('data-topology-manager="remote-qa"'), 'online managers lead the tree');
  });

  it('topology reserves offline manager slots for departments without a provisioned manager', () => {
    const departments = ['core', 'runtime', 'qa', 'platform', 'docs'];
    const snap = { departments, departmentInfo: departments.map((id) => ({ id, maxSubagents: 3 })), tasks: [],
      managers: [{ name: 'owner-laptop', state: 'idle', departments, running: [], freeSlots: 1 }], pauses: { departments: {}, managers: {} } };
    const out = renderTopology(snap);
    assert.equal((out.match(/class="topology-manager-lane /g) ?? []).length, departments.length);
    assert.match(out, /data-topology-manager="owner-laptop"/);
    for (const department of departments.slice(1)) {
      assert.match(out, new RegExp(`data-topology-manager="offline-${department}"`));
    }
    assert.equal((out.match(/class="topology-manager-lane topology-lane-offline/g) ?? []).length, departments.length - 1);
    assert.equal((out.match(/subagent pool offline/g) ?? []).length, departments.length);
    assert.match(out, /BUS \/ DISPATCH \/ 5 MANAGERS/);
  });

  it('admin: plan button only for the owner on an empty epic; plan job states; commit button on a dry run', () => {
    const owner = viewerContext({ viewerRoles: ['manager', 'owner'] }, []);
    const member = viewerContext({ viewerRoles: ['manager'] }, []);
    const epics = [{ id: 'E-0003', title: 'New', status: 'open' }, { id: 'E-0001', title: 'Old' }];
    const tasks = [task({ epicId: 'E-0001' })];
    assert.match(renderEpics(epics, tasks, owner), /data-plan="E-0003"/);
    assert.doesNotMatch(renderEpics(epics, tasks, owner), /data-plan="E-0001"/, 'already planned');
    assert.doesNotMatch(renderEpics(epics, tasks, member), /data-plan/);
    assert.match(renderPlan('E-0003', { status: 'running' }), /Planning E-0003/);
    assert.match(renderPlan('E-0003', { status: 'failed', error: '<b>x</b>' }), /failed: &lt;b&gt;/);
    const dry = renderPlan('E-0003', { status: 'done', result: { model: 'claude-opus-5-5', written: false, tasks: [{ key: 'a', department: 'core', size: 'S', title: 'Contract', dependsOn: [] }] } });
    assert.match(dry, /Dry run for E-0003: 1 tasks proposed/);
    assert.match(dry, /data-action="epics\/E-0003\/plan"/);
    assert.doesNotMatch(renderPlan('E-0003', { status: 'done', result: { model: 'm', written: true, tasks: [{ id: 'T-0010', department: 'core', status: 'queued', title: 'x' }] } }), /data-action/);
    assert.match(describeAction('epics/E-0003/plan'), /Commit the plan for E-0003/);
    assert.match(describeAction('tokens/bob-qa/revoke'), /Revoke token bob-qa/);
    assert.match(describeAction('backup'), /Back up/);
    assert.match(renderControls({ pauses: {} }, owner, []), /data-action="intake".*data-action="backup"/s);
    assert.doesNotMatch(renderControls({ pauses: {} }, member, []), /data-action="(intake|backup)"/);
  });

  it('admin: service line, task detail, token list without hashes', () => {
    const svc = renderService({ version: 'abc1234', uptimeSeconds: 7500, features: { review: true, intake: false, dispatch: true, planCmd: false } }, { bus: 'ok', watchdog: { state: 'up', since: NOW - 3_600_000 } }, true, NOW);
    assert.match(svc, /abc1234 · up 2h 5m/);
    assert.match(svc, /orchestrator.*online/s);
    assert.match(svc, /review <span class="ok">on<\/span>/);
    assert.match(svc, /intake <span class="mut">off<\/span>/);
    assert.match(svc, /<b>bus<\/b> <span class="ok">ok/);
    assert.match(svc, /<b>watchdog<\/b> <span class="ok">up<\/span><span class="mut">60m ago/);
    const detail = renderTaskDetail(task({ paths: ['swarm/x/**'], acceptance: ['works'], branch: 'core/t-0001-x', lastPhase: 'checks', lastNote: '<i>', review: { findings: ['#1 blocker'] } }), [{ from: null, to: 'queued', at: 'x', reason: 'created' }]);
    assert.match(detail, /<dt>Paths<\/dt>[\s\S]*swarm\/x\/\*\*/);
    assert.match(detail, /core\/t-0001-x/);
    assert.match(detail, /checks<span class="sub">&lt;i&gt;<\/span>/);
    assert.match(detail, /#1 blocker/);
    assert.match(detail, /<b>-<\/b> &rarr; <b>Queued<\/b>.*created/);
    const tok = renderTokens([{ name: 'bob-qa', member: 'bob', roles: ['manager'], departments: ['qa'], createdAt: '2026-11-02T10:00:00Z' }], ['core', 'qa']);
    assert.match(tok, /bob-qa.*data-action="tokens\/bob-qa\/revoke"/s);
    assert.match(tok, /id="token-form"/);
    assert.match(tok, /value="qa"/);
  });
});

// Departments table: built from /snapshot fields only (departmentInfo, departments, managers, tasks, pauses, paused).
describe('departments table', () => {
  const info = (patch) => ({ id: 'core', agent: 'claude', paths: ['swarm/orchestrator/**', 'swarm/protocol/**'], concurrency: 3, maxSubagents: 4, host: 'owner', ...patch });
  const member = (patch) => ({ name: 'ana-1', member: 'ana', state: 'idle', departments: ['core'], freeSlots: 1, running: [], lastHeartbeat: NOW - 10_000, ...patch });
  const snapshot = (patch = {}) => ({
    departments: ['core', 'qa', 'docs'],
    departmentInfo: [info(), info({ id: 'qa', agent: 'codex', paths: ['swarm/test/**'], concurrency: 1 }), info({ id: 'docs', agent: 'gemini', paths: ['docs/**'], concurrency: 1 })],
    managers: [member({ state: 'busy', freeSlots: 0, running: ['T-0001'] }), member({ name: 'luis-1', member: 'luis', state: 'offline', freeSlots: null }), member({ name: 'bob-1', member: 'bob', departments: ['qa'] })],
    tasks: [],
    paused: false,
    pauses: { departments: {}, managers: {} },
    ...patch,
  });
  const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;|&#34;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&');
  // Data rows are the <tr> blocks without a header cell; the department id identifies each one.
  const rowsOf = (html) => (html.match(/<tr\b[\s\S]*?<\/tr>/g) ?? []).filter((r) => !r.includes('<th'));
  const textOf = (html) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const rowFor = (html, id) => {
    const hits = rowsOf(html).filter((r) => new RegExp(`(^|[^\\w-])${id}([^\\w-]|$)`).test(textOf(r)));
    assert.equal(hits.length, 1, `one row for ${id}`);
    return hits[0];
  };
  const titlesOf = (row) => [...row.matchAll(/title="([^"]*)"/g)].map((m) => unescapeHtml(m[1]));
  // A warning is a warn/neg class, a "no manager" note, or the warning sign.
  const warns = (row) => /warn|no (online )?manager|⚠/i.test(textOf(row)) || /class="[^"]*\b(warn|neg)\b/.test(row);

  it('escapes agent kind, paths, manager names and pause reasons in text and title attributes', () => {
    const hostilePath = 'swarm/<x>&"\'/**';
    const html = renderDepartments(snapshot({
      departments: ['core'],
      departmentInfo: [info({ agent: '<b>cl"aude</b>', paths: [hostilePath] })],
      managers: [member({ name: '"><img src=x onerror=alert(1)>', state: 'idle' })],
      pauses: { departments: { core: { reason: '<i>"&', by: 'x' } }, managers: {} },
    }));
    assert.doesNotMatch(html, /<(img|script|svg|b|i|x)[\s>/]/i, 'no raw markup from the snapshot');
    assert.ok(!html.includes('"><img'), 'a manager name cannot close the attribute');
    assert.ok(html.includes('&lt;b&gt;cl'), 'agent kind escaped in text');
    assert.ok(html.includes('&lt;img src=x'), 'manager name escaped in text');
    const row = rowFor(html, 'core');
    assert.ok(titlesOf(row).some((t) => t.includes(hostilePath)), 'path survives in title, escaped, and decodes to the original');
  });

  it('an empty snapshot renders an empty-state paragraph', () => {
    const html = renderDepartments({});
    assert.equal(typeof html, 'string');
    assert.match(html, /class="empty"/);
    assert.match(html, /No departments configured/);
  });

  it('one row per department: id, agent kind, shortened paths with the full list in title, concurrency, managers and online state', () => {
    const html = renderDepartments(snapshot());
    assert.equal(rowsOf(html).length, 3, 'one row per department');
    const core = rowFor(html, 'core');
    assert.match(textOf(core), /claude/);
    assert.match(textOf(core), /\b3\b/, 'concurrency 3');
    assert.ok(titlesOf(core).some((t) => t.includes('swarm/orchestrator/**') && t.includes('swarm/protocol/**')), 'full path list in title');
    assert.ok(!['swarm/orchestrator/**', 'swarm/protocol/**'].every((p) => textOf(core).includes(p)), 'visible paths are shortened');
    assert.match(textOf(core), /ana-1/);
    assert.match(textOf(core), /busy/);
    assert.match(textOf(core), /luis-1/);
    assert.match(textOf(core), /offline/i, 'offline manager shown as offline');
    const qa = rowFor(html, 'qa');
    assert.match(textOf(qa), /codex/);
    assert.match(textOf(qa), /bob-1/);
    assert.match(textOf(qa), /idle/);
    assert.doesNotMatch(textOf(qa), /ana-1|luis-1/, 'managers appear only in the rows of their departments');
  });

  it('a department no online manager serves renders a warning; a covered one does not', () => {
    const html = renderDepartments(snapshot({
      managers: [member({ name: 'ana-1', state: 'busy' }), member({ name: 'luis-1', member: 'luis', state: 'offline', departments: ['qa'] })],
    }));
    assert.ok(warns(rowFor(html, 'docs')), 'docs has no manager at all');
    assert.ok(warns(rowFor(html, 'qa')), 'qa has only an offline manager');
    assert.ok(!warns(rowFor(html, 'core')), 'core has an online manager');
  });

  it('a paused department renders its paused state, the others do not', () => {
    const html = renderDepartments(snapshot({ pauses: { departments: { qa: { reason: 'flaky tests', by: 'owner' } }, managers: {} } }));
    assert.match(rowFor(html, 'qa'), /paused/i);
    assert.doesNotMatch(rowFor(html, 'core'), /paused/i);
    assert.doesNotMatch(rowFor(html, 'docs'), /paused/i);
  });

  it('queued, running and merged counts per department', () => {
    const tasks = [
      ...Array.from({ length: 4 }, (_, i) => task({ id: `T-010${i}`, status: 'queued' })),
      ...Array.from({ length: 2 }, (_, i) => task({ id: `T-020${i}`, status: 'in_progress', holder: 'ana-1' })),
      ...Array.from({ length: 7 }, (_, i) => task({ id: `T-030${i}`, status: 'merged' })),
      task({ id: 'T-0400', status: 'blocked' }),
      task({ id: 'T-0401', status: 'failed' }),
      task({ id: 'T-0402', status: 'merged', department: 'qa' }),
    ];
    const html = renderDepartments(snapshot({ tasks }));
    const core = textOf(rowFor(html, 'core'));
    assert.match(core, /\b4\b/, 'queued: blocked and failed tasks are not counted');
    assert.match(core, /\b2\b/, 'running');
    assert.match(core, /\b7\b/, 'merged');
    assert.doesNotMatch(textOf(rowFor(html, 'qa')), /\b(4|2|7)\b/, 'qa counts only its own tasks');
  });
});
