import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openStore } from '../src/store.mjs';
import { createOperatorWorker } from '../src/operator-worker.mjs';

function queuedTurn(store, text, target = 'orchestrator') {
  const message = store.appendAgentMessage({ target, actor: 'owner', role: 'user', text });
  return store.createOperatorTurn({ target, messageId: message.id });
}

const contextFor = (target) => ({
  model: 'claude-sonnet-5-5',
  target,
  snapshot: { tasks: [], managers: [] },
  histories: [],
  agent: target === 'orchestrator' ? { id: 'orchestrator', status: 'running' } : null,
});

describe('operator worker', () => {
  it('serializes concurrent ticks and processes conversation turns in message order', async () => {
    const store = openStore();
    const first = queuedTurn(store, 'First');
    const second = queuedTurn(store, 'Second');
    let release;
    const calls = [];
    const callModel = ({ prompt }) => {
      calls.push(prompt);
      return new Promise((resolve) => { release = resolve; });
    };
    const worker = createOperatorWorker({ store, callModel, applyAction: async () => null, contextFor, log: { error() {} } });
    const one = worker.tick();
    const concurrent = worker.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'one global model call');
    release(JSON.stringify({ reply: 'First reply', proposedActions: [] }));
    assert.equal((await one).id, first.id);
    assert.equal((await concurrent).id, first.id);
    assert.equal(store.getOperatorTurn(first.id).status, 'succeeded');
    assert.equal(store.getOperatorTurn(second.id).status, 'queued');

    const two = worker.tick();
    await new Promise((resolve) => setImmediate(resolve));
    release(JSON.stringify({ reply: 'Second reply', proposedActions: [] }));
    assert.equal((await two).id, second.id);
    assert.deepEqual(store.agentMessages('orchestrator').filter((message) => message.role === 'assistant').map((message) => message.text), ['First reply', 'Second reply']);
    store.close();
  });

  it('repairs invalid output once, auto-applies only status, and leaves mutations pending', async () => {
    const store = openStore();
    const turn = queuedTurn(store, 'Inspect and propose');
    const replies = [
      'not json',
      JSON.stringify({
        reply: 'I checked the agent and drafted an epic.',
        proposedActions: [
          { kind: 'request_status', payload: { target: 'manager-core' } },
          { kind: 'create_epic', payload: { title: 'Improve telemetry', body: 'Acceptance here' } },
        ],
      }),
    ];
    const applied = [];
    const worker = createOperatorWorker({
      store,
      callModel: async () => replies.shift(),
      applyAction: async (action) => { applied.push(action.kind); return { ok: true }; },
      contextFor,
      log: { error() {} },
    });
    await worker.tick();
    assert.equal(store.getOperatorTurn(turn.id).status, 'succeeded');
    assert.deepEqual(applied, ['request_status']);
    assert.deepEqual(store.operatorActions(turn.id).map((action) => [action.kind, action.status]), [
      ['request_status', 'applied'],
      ['create_epic', 'pending'],
    ]);
    store.close();
  });

  it('fails visibly after two invalid replies and applies nothing', async () => {
    const store = openStore();
    const turn = queuedTurn(store, 'Bad output');
    let calls = 0;
    const worker = createOperatorWorker({
      store,
      callModel: async () => { calls += 1; return calls === 1 ? '{}' : 'still bad'; },
      applyAction: async () => { throw new Error('must not apply'); },
      contextFor,
      log: { error() {} },
    });
    await worker.tick();
    assert.equal(calls, 2);
    assert.equal(store.getOperatorTurn(turn.id).status, 'failed');
    assert.match(store.getOperatorTurn(turn.id).error, /invalid operator reply/);
    assert.equal(store.agentMessages('orchestrator').filter((message) => message.role === 'assistant').length, 0);
    store.close();
  });

  it('confirms a pending mutation exactly once and cancellation never applies it', async () => {
    const store = openStore();
    const turn = queuedTurn(store, 'Propose actions');
    const worker = createOperatorWorker({
      store,
      callModel: async () => JSON.stringify({
        reply: 'Two proposals',
        proposedActions: [
          { kind: 'create_epic', payload: { title: 'A', body: 'B' } },
          { kind: 'replan_task', payload: { taskId: 'T-0001' } },
        ],
      }),
      applyAction: async (action) => ({ applied: action.kind }),
      contextFor,
      log: { error() {} },
    });
    await worker.tick();
    const [confirm, cancel] = store.operatorActions(turn.id);
    const first = await worker.confirmAction(confirm.id, { actor: 'owner', reason: 'Approved', idempotencyKey: 'confirm-a1b2c3d4' });
    const again = await worker.confirmAction(confirm.id, { actor: 'owner', reason: 'Approved', idempotencyKey: 'confirm-a1b2c3d4' });
    assert.equal(first.status, 'applied');
    assert.deepEqual(again, first);
    assert.equal((await worker.cancelAction(cancel.id, { actor: 'owner', reason: 'Not now', idempotencyKey: 'cancel-a1b2c3d4' })).status, 'cancelled');
    store.close();
  });
});
