import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGraph, cycleNeighbour, neighbours, search, taskLinks, zoomToFit } from '../src/static/graph.mjs';

const bus = {
  agents: [
    { id: 'a1', name: 'swarm-orchestrator', status: 'online' },
    { id: 'a2', name: 'member-a-claude', status: 'offline' },
    { id: 'a3', name: 'owner-laptop-2b54', status: 'offline' }, // ephemeral fallback, never spoke
    { id: 'a4', name: 'owner-laptop', status: 'online' },
  ],
  channels: [{ id: 'c1', name: 'swarm' }, { id: 'c2', name: 'dept-docs' }],
  messages: {
    swarm: [
      { id: 1, from_agent: 'a1', content: 'task.merged T-0002 (docs): PR #171', created_at: '2026-11-06T12:00:00Z' },
      { id: 2, from_agent: 'a1', content: 'operator plan E-0002 by owner-owner', created_at: '2026-11-06T14:00:00Z' },
      { id: 3, from_agent: 'a2', content: 'reviewing T-0002', created_at: '2026-11-05T10:00:00Z' }, // older message
    ],
    'dept-docs': [{ id: 4, from_agent: 'a1', content: 'T-0002 queued', created_at: '2026-11-06T15:00:00Z' }],
  },
  state: [
    { namespace: 'swarm', key: 'orchestrator', value: '{"url":"http://x"}', updated_by: 'a1', updated_at: '2026-11-06T14:30:00Z' },
    { namespace: 'locks', key: 'swarm/manager/src/subagents.mjs', value: 'member-f-gemini', updated_by: 'gone-id', updated_at: '2026-11-04T10:00:00Z' }, // old lock
  ],
};
const snapshot = {
  departments: ['docs'],
  managers: [{ name: 'owner-laptop', state: 'idle', departments: ['docs'] }],
  epics: [{ id: 'E-0002', title: 'Pilot 2', status: 'open' }],
  tasks: [{ id: 'T-0002', epicId: 'E-0002', title: 'Record the first live run', status: 'merged', department: 'docs', holder: 'owner-laptop', pr: 171 }],
};

describe('graph model', () => {
  const g = buildGraph(bus, snapshot);
  const has = (id) => g.nodes.some((n) => n.id === id);
  const edge = (a, b, kind) => g.edges.find((e) => e.a === a && e.b === b && e.kind === kind);

  it('agents, channels, memory, namespaces, work all become nodes; ephemeral silent names are dropped', () => {
    for (const id of ['agent:swarm-orchestrator', 'agent:member-a-claude', 'channel:swarm', 'channel:dept-docs', 'memory:swarm/orchestrator', 'namespace:locks', 'department:docs', 'manager:owner-laptop', 'epic:E-0002', 'task:T-0002']) assert.ok(has(id), id);
    assert.ok(!has('agent:owner-laptop-2b54'), 'fallback name that never spoke is noise');
  });

  it('conversation edges are weighted by messages; mentions link channels to tasks and epics', () => {
    assert.equal(edge('agent:swarm-orchestrator', 'channel:swarm', 'talks').weight, 2);
    assert.equal(edge('agent:member-a-claude', 'channel:swarm', 'talks').weight, 1);
    assert.equal(edge('channel:swarm', 'task:T-0002', 'mentions').weight, 2);
    assert.ok(edge('channel:swarm', 'epic:E-0002', 'mentions'));
    assert.ok(edge('channel:dept-docs', 'task:T-0002', 'mentions'));
  });

  it('memory links to its namespace and its writer; the work graph is wired', () => {
    assert.ok(edge('namespace:swarm', 'memory:swarm/orchestrator', 'holds'));
    assert.ok(edge('agent:swarm-orchestrator', 'memory:swarm/orchestrator', 'wrote'));
    assert.ok(has('memory:locks/swarm/manager/src/subagents.mjs'), 'a stale lock by an unknown writer still shows');
    assert.ok(edge('task:T-0002', 'epic:E-0002', 'part of'));
    assert.ok(edge('manager:owner-laptop', 'task:T-0002', 'held'));
    assert.ok(edge('manager:owner-laptop', 'agent:owner-laptop', 'is'));
    assert.ok(edge('department:docs', 'channel:dept-docs', 'channel'));
  });

  it('neighbours and search', () => {
    assert.ok(neighbours(g, 'task:T-0002').has('epic:E-0002'));
    assert.deepEqual(search(g, 't-0002'), ['task:T-0002']);
    assert.deepEqual(search(g, ''), []);
  });

  it('works without a snapshot and with empty bus data', () => {
    assert.ok(buildGraph(bus, null).nodes.length > 0);
    assert.deepEqual(buildGraph({}, null), { nodes: [], edges: [] });
  });

  it('time window filters older messages and memory', () => {
    const clock = { now: () => Date.parse('2026-11-06T16:00:00Z') };
    // Last 6 hours only (since 10:00Z on Nov 6): message id 3 (from Nov 5) and old lock (Nov 4) should be excluded
    const filtered = buildGraph(bus, snapshot, { hours: 6, clock });
    const fEdge = (a, b, kind) => filtered.edges.find((e) => e.a === a && e.b === b && e.kind === kind);
    assert.equal(fEdge('agent:member-a-claude', 'channel:swarm', 'talks'), undefined, 'older message excluded');
    assert.ok(!filtered.nodes.some((n) => n.id === 'memory:locks/swarm/manager/src/subagents.mjs'), 'stale memory excluded');
    assert.ok(filtered.nodes.some((n) => n.id === 'memory:swarm/orchestrator'), 'recent memory kept');
  });

  it('taskLinks returns valid links to PR and control room', () => {
    const links = taskLinks({ id: 'T-0002', pr: 171, repo: 'example-org/agent-coordination' });
    assert.equal(links.prUrl, 'https://github.com/example-org/agent-coordination/pull/171');
    assert.equal(links.controlRoomUrl, '/#tasks');
    const custom = taskLinks({ id: 'T-0002', pr: 171 }, { repoUrl: 'https://github.com/example-org/agent-coordination' });
    assert.equal(custom.prUrl, 'https://github.com/example-org/agent-coordination/pull/171');
    const noPr = taskLinks({ id: 'T-0003' });
    assert.equal(noPr.prUrl, null);
    assert.equal(noPr.controlRoomUrl, '/#tasks');
  });

  it('zoomToFit calculates viewport bounding box and scale', () => {
    const positions = [
      { x: -100, y: -50 },
      { x: 100, y: 50 },
    ];
    const fit = zoomToFit(positions, { width: 800, height: 600, padding: 50 });
    assert.equal(fit.x, 0); // centered horizontally
    assert.equal(fit.y, 0); // centered vertically
    assert.ok(fit.k > 0 && fit.k <= 2);
  });

  it('cycleNeighbour enables keyboard navigation across connected nodes', () => {
    const next = cycleNeighbour(g, 'task:T-0002', 1);
    assert.ok(next, 'finds adjacent node');
    assert.ok(neighbours(g, 'task:T-0002').has(next));
    const prev = cycleNeighbour(g, 'task:T-0002', -1);
    assert.ok(prev);
    assert.ok(neighbours(g, 'task:T-0002').has(prev));
  });
});
