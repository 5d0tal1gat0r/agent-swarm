import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, hierarchyOf, renderAgentTree, renderAuditHistory, renderConversation, renderDirectiveState, renderInspector, renderTaskFocus, renderTimeline } from '../src/static/agents-render.mjs';

const assignments = [
  { id: 'child', kind: 'subagent', parentId: 'manager', manager: 'manager', taskId: 'T-0001', role: 'implementer', status: 'running', updatedAt: '2026-11-05T10:00:02Z' },
  { id: 'orchestrator', kind: 'orchestrator', parentId: null, manager: null, taskId: null, role: null, status: 'running', updatedAt: '2026-11-05T10:00:00Z' },
  { id: 'manager', kind: 'manager', parentId: 'orchestrator', manager: 'manager', taskId: null, role: null, status: 'running', updatedAt: '2026-11-05T10:00:01Z' },
];

describe('agent cockpit rendering', () => {
  it('orders the hierarchy root, manager, then stable assignment and escapes hostile labels', () => {
    const tree = hierarchyOf(assignments);
    assert.deepEqual(tree.map((node) => [node.assignment.id, node.depth]), [['orchestrator', 0], ['manager', 1], ['child', 2]]);
    const html = renderAgentTree([...assignments, { ...assignments[2], id: '<img src=x onerror=alert(1)>' }], 'child');
    assert.ok(!html.includes('<img'));
    assert.match(html, /aria-current="true"/);
    assert.match(html, /Running/, 'state is text, not color only');
    assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  });

  it('renders conversations, honest observable telemetry, and directive lifecycle without injection', () => {
    const messages = [{ actor: 'owner', role: 'user', text: '<script>alert(1)</script>', createdAt: '2026-11-05T10:00:00Z' }];
    assert.ok(!renderConversation(messages).includes('<script>'));
    const timeline = renderTimeline([{ seq: 1, kind: 'agent-event', at: '2026-11-05T10:00:00Z', data: { type: 'status', summary: 'Observable status only' } }]);
    assert.match(timeline, /Observable status only/);
    assert.match(timeline, /observable event/i);
    for (const state of ['queued', 'applied', 'failed', 'cancelled']) assert.match(renderDirectiveState({ status: state }), new RegExp(state, 'i'));
  });

  it('hides mutation controls without permission and shows offline read-only copy', () => {
    const viewer = renderInspector(assignments[0], { roles: ['dashboard'], online: false, session: null });
    assert.match(viewer, /Read-only while orchestrator is offline/);
    assert.ok(!viewer.includes('data-command="interrupt"'));
    const owner = renderInspector(assignments[0], { roles: ['owner'], online: true, session: { model: 'gpt-5.6-luna', phase: 'implement' } });
    assert.match(owner, /Edit context/);
    assert.match(owner, /data-command="interrupt"/);
    const context = renderInspector(assignments[0], { roles: ['owner'], tab: 'context', detail: { assignment: { goal: 'Ship safely', currentTask: 'Verify UI', sessionSkills: { roles: ['checker'] }, guardrails: { instructions: 'Preserve state.' } } } });
    assert.match(context, /Ship safely/);
    assert.match(context, /checker/);
    assert.match(context, /Preserve state/);
  });

  it('renders a task focus card with linked agents and bounded audit history', () => {
    const task = { id: 'T-0001', title: '<ship cockpit>', status: 'running', department: 'core', holder: 'alice-core', budget: { tokens: 1000, minutes: 30 }, usedTokens: 200, lastPhase: 'checks', review: { rounds: 1, evidence: [{ criterion: '<works>', met: true }] }, pr: 42 };
    const focus = renderTaskFocus(task, assignments, [{ assignmentId: 'child', phase: 'test', status: 'running', inputTokens: 120, outputTokens: 80 }]);
    assert.match(focus, /T-0001/);
    assert.match(focus, /alice-core/);
    assert.match(focus, /child/);
    assert.match(focus, /works/);
    assert.ok(!focus.includes('<ship cockpit>'));
    const audit = renderAuditHistory([{ id: 'directive-1', kind: 'directive', action: 'pause', status: 'applied', actor: 'owner', reason: '<because>', result: 'checkpointed', at: '2026-11-05T10:00:00Z' }]);
    assert.match(audit, /Pause/);
    assert.match(audit, /because/);
    assert.ok(!audit.includes('<because>'));
    assert.match(renderAuditHistory([]), /No operator actions yet/);
  });
});
