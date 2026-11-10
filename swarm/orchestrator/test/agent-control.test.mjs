import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore } from '../src/store.mjs';
import { AgentControlError, createAgentControl } from '../src/agent-control.mjs';

const policy = {
  models: { claude: ['claude-sonnet-5-5'], codex: ['gpt-5.6-luna'], gemini: [], antigravity: [] },
  limits: { maxTaskMinutes: 60 },
};
const departments = {
  contracts: ['swarm/protocol/**'],
  departments: { core: { agent: 'codex', paths: ['swarm/orchestrator/**', 'swarm/protocol/**'] } },
};
const tokens = {
  managers: {
    'm-owner': { member: 'owner', roles: ['owner', 'manager'], departments: ['core'] },
    'm-core': { member: 'alice', roles: ['manager'], departments: ['core'] },
    'm-other': { member: 'bob', roles: ['manager'], departments: ['core'] },
    dashboard: { member: 'screen', roles: ['dashboard'], departments: [] },
  },
};
const owner = { name: 'm-owner', member: 'owner', roles: ['owner', 'manager'] };
const alice = { name: 'm-core', member: 'alice', roles: ['manager'] };
const bob = { name: 'm-other', member: 'bob', roles: ['manager'] };
const dashboard = { name: 'dashboard', member: 'screen', roles: ['dashboard'] };

function setupControl() {
  const store = openStore();
  store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'body' });
  store.createTask({
    id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'Task', department: 'core', priority: 'p1', size: 'S',
    paths: ['swarm/orchestrator/**'], dependsOn: [], acceptance: ['works'], budget: { tokens: 1000, minutes: 30 },
  });
  store.upsertAgentAssignment({
    id: 'agent-T-0001-implementer-a1b2c3d4', kind: 'subagent', parentId: 'm-core', manager: 'm-core',
    taskId: 'T-0001', role: 'implementer', status: 'running',
  });
  store.startAgentSession({
    id: 'run-T-0001-1-a1b2c3d4', assignmentId: 'agent-T-0001-implementer-a1b2c3d4', agentKind: 'codex',
    model: 'gpt-5.6-luna', status: 'running', phase: 'implement', inputTokens: 0, outputTokens: 0, lastEventSeq: 0,
  });
  return { store, control: createAgentControl({ store, policy, departments, tokens }) };
}

describe('agent control', () => {
  it('lets the owner operate every assignment and the owning manager only its own', () => {
    const { control } = setupControl();
    assert.equal(control.canReadDetail(owner, 'agent-T-0001-implementer-a1b2c3d4'), true);
    assert.equal(control.canDirect(alice, 'agent-T-0001-implementer-a1b2c3d4'), true);
    assert.equal(control.canDirect(bob, 'agent-T-0001-implementer-a1b2c3d4'), false);
    assert.equal(control.canReadSummary(dashboard), true);
    assert.equal(control.canReadDetail(dashboard, 'agent-T-0001-implementer-a1b2c3d4'), false);
  });

  it('rejects a write to a one-turn session and names the stable assignment', () => {
    const { control } = setupControl();
    assert.throws(
      () => control.resolveWriteTarget('run-T-0001-1-a1b2c3d4'),
      (error) => error instanceof AgentControlError && error.status === 409 && error.assignmentId === 'agent-T-0001-implementer-a1b2c3d4',
    );
  });

  it('accepts narrowed context but rejects widening, costly changes and uninstalled roles', () => {
    const { control } = setupControl();
    assert.deepEqual(control.validateContext(owner, 'agent-T-0001-implementer-a1b2c3d4', {
      guardrails: { allowedPaths: ['swarm/orchestrator/src/**'] }, runtimeMinutes: 45, model: 'gpt-5.6-luna',
      sessionSkills: { roles: ['test-writer'], note: 'Focus on the route.' },
    }).guardrails.allowedPaths, ['swarm/orchestrator/src/**']);
    assert.throws(() => control.validateContext(owner, 'agent-T-0001-implementer-a1b2c3d4', {
      guardrails: { allowedPaths: ['swarm/**'] },
    }), /widen/);
    assert.throws(() => control.validateContext(alice, 'agent-T-0001-implementer-a1b2c3d4', { runtimeMinutes: 45 }), /owner/);
    assert.throws(() => control.validateContext(owner, 'agent-T-0001-implementer-a1b2c3d4', { model: 'unknown-model' }), /allow-list/);
    assert.throws(() => control.validateContext(owner, 'agent-T-0001-implementer-a1b2c3d4', {
      sessionSkills: { roles: ['not-installed'] },
    }), /installed role/);
  });

  it('lets any manager operate the orchestrator while keeping model changes and interrupts owner-only', () => {
    const { store, control } = setupControl();
    store.upsertAgentAssignment({ id: 'orchestrator', kind: 'orchestrator', parentId: null, manager: null, taskId: null, role: null, status: 'running' });
    assert.equal(control.canPromptOrchestrator(owner), true);
    assert.equal(control.canPromptOrchestrator(alice), true);
    assert.doesNotThrow(() => control.assertDirectiveAllowed(alice, 'orchestrator', 'status'));
    assert.doesNotThrow(() => control.assertDirectiveAllowed(alice, 'orchestrator', 'pause'));
    assert.throws(() => control.assertDirectiveAllowed(alice, 'orchestrator', 'interrupt'), /owner/);
    assert.throws(() => control.assertDirectiveAllowed(alice, 'agent-T-0001-implementer-a1b2c3d4', 'interrupt'), /owner/);
    assert.doesNotThrow(() => control.assertDirectiveAllowed(owner, 'agent-T-0001-implementer-a1b2c3d4', 'interrupt'));
  });
});
