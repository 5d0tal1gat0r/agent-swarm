import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AGENT_DETAIL_PATH, AGENT_WRITE_PATH } from '../dashboard/src/server.mjs';
import { createAgentCache } from '../dashboard/src/agent-cache.mjs';
import { validate } from '../protocol/validate.mjs';

const root = path.resolve(import.meta.dirname, '..');

describe('agent cockpit cross-layer contract', () => {
  it('keeps context fields and old-manager session shape aligned', () => {
    const context = JSON.parse(fs.readFileSync(path.join(root, 'protocol/agent-context.schema.json')));
    const assignment = JSON.parse(fs.readFileSync(path.join(root, 'protocol/agent-assignment.schema.json')));
    const session = JSON.parse(fs.readFileSync(path.join(root, 'protocol/agent-session.schema.json')));
    for (const key of ['goal', 'currentTask', 'sessionSkills', 'guardrails']) {
      assert.ok(context.properties[key], `${key} is in shared context`);
      assert.ok(assignment.properties[key], `${key} is in assignment`);
      assert.ok(session.properties[key], `${key} is in session`);
    }
    const legacy = { operation: 'start', session: { id: 'run-legacy', assignmentId: 'agent-T-0001-implementer-main', agentKind: 'codex', model: 'gpt-5.6-luna', status: 'running', phase: 'implement', startedAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z', inputTokens: 0, outputTokens: 0, lastEventSeq: 0 } };
    assert.equal(validate('api/agent-session.request', legacy).ok, true);
  });

  it('covers every browser write/detail route and keeps privileged values out of the common cache', () => {
    for (const suffix of ['prompt', 'context', 'status', 'pause', 'resume', 'replan', 'interrupt', 'stop']) {
      assert.equal(AGENT_WRITE_PATH.test(`/api/operator/agents/orchestrator/${suffix}`), true, suffix);
    }
    assert.equal(AGENT_WRITE_PATH.test('/api/operator/agent-actions/action-1/confirm'), true);
    assert.equal(AGENT_DETAIL_PATH.test('/api/agents/assignments/agent-T-0001-implementer-main'), true);
    assert.equal(AGENT_DETAIL_PATH.test('/api/agents/assignments/agent-T-0001-implementer-main/events'), true);
    assert.equal(AGENT_DETAIL_PATH.test('/api/agents/conversations/orchestrator/messages'), true);
    assert.equal(AGENT_DETAIL_PATH.test('/api/agents/audit'), true);
    const cache = createAgentCache();
    assert.throws(() => cache.replaceSummary({ assignments: [{ id: 'a', goal: 'secret' }], sessions: [] }), /privileged field goal/);
    assert.throws(() => cache.appendFeed([{ seq: 1, kind: 'agent-event', data: { prompt: 'secret' } }]), /privileged field prompt/);
    const source = fs.readFileSync(path.join(root, 'dashboard/src/static/agents.js'), 'utf8');
    for (const kind of ['assignment', 'session', 'agent-event', 'directive', 'operator-turn', 'operator-action', 'message']) assert.match(source, new RegExp(kind));
    for (const marker of ['renderTaskFocus', 'renderAuditHistory', '/api/snapshot', 'audit-drawer']) assert.match(source, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
