import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createDirectiveJournal } from '../src/directives.mjs';
import { applyDirectiveCheckpoints } from '../src/task-runner.mjs';

const dirs = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true }); });
const tempFile = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'directives-')); dirs.push(dir); return path.join(dir, 'journal.json'); };
const directive = (id, kind = 'prompt') => ({
  id, idempotencyKey: `key-${id}`, target: 'agent-T-0001-implementer-main', taskId: 'T-0001', kind,
  payload: kind === 'prompt' ? { text: `instruction ${id}` } : {}, actor: 'owner', reason: 'adjust work', status: 'queued',
  createdAt: '2026-11-05T10:00:00.000Z', deliveredAt: null, appliedAt: null, result: null, replacementSessionId: null,
});

describe('directive journal', () => {
  it('writes delivered directives before acknowledgement and deduplicates concurrent polls', async () => {
    const file = tempFile();
    const order = [];
    let polls = 0;
    const client = {
      async directives() { polls += 1; await new Promise((resolve) => setImmediate(resolve)); return [directive('directive-1')]; },
      async ackDirective(_manager, id, body) {
        order.push(['ack', id, body.status, fs.existsSync(file), JSON.parse(fs.readFileSync(file, 'utf8')).length]);
      },
    };
    const journal = createDirectiveJournal({ file, manager: 'alice-core', client });
    await Promise.all([journal.poll(), journal.poll()]);
    assert.equal(polls, 1);
    assert.deepEqual(order, [['ack', 'directive-1', 'delivered', true, 1]]);
    assert.equal(journal.pendingFor({ taskId: 'T-0001', assignmentId: 'agent-T-0001-implementer-main' }).length, 1);
  });

  it('survives a crash after local delivery and returns the stored applied result on redelivery', async () => {
    const file = tempFile();
    let failAck = true;
    const acks = [];
    const client = {
      async directives() { return [directive('directive-2')]; },
      async ackDirective(_manager, id, body) {
        acks.push([id, body.status, body.result]);
        if (failAck) throw new Error('offline');
      },
    };
    const first = createDirectiveJournal({ file, manager: 'alice-core', client });
    await assert.rejects(first.poll(), /offline/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].localStatus, 'delivered');
    failAck = false;
    const restarted = createDirectiveJournal({ file, manager: 'alice-core', client });
    await restarted.poll();
    failAck = true;
    await assert.rejects(restarted.markApplied('directive-2', { result: 'continued', replacementSessionId: 'run-T-0001-2-next' }), /offline/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].localStatus, 'applied');
    failAck = false;
    const afterAppliedCrash = createDirectiveJournal({ file, manager: 'alice-core', client });
    await afterAppliedCrash.poll();
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), []);
    assert.ok(acks.some(([, status, result]) => status === 'applied' && result === 'continued'));
  });

  it('signals only explicit interrupt/stop directives after they are journaled and delivered', async () => {
    const file = tempFile();
    const incoming = [directive('directive-interrupt', 'interrupt')];
    let interrupted = 0;
    const journal = createDirectiveJournal({
      file, manager: 'alice-core',
      client: { directives: async () => incoming, ackDirective: async () => { assert.ok(fs.existsSync(file)); } },
    });
    journal.register('T-0001', { interrupt: () => { interrupted += 1; } });
    await journal.poll();
    assert.equal(interrupted, 1);
  });
});

describe('checkpoint continuations', () => {
  it('finishes the current turn, combines queued directives, and starts one continuation in the same worktree and assignment', async () => {
    const pending = [directive('directive-a'), directive('directive-b', 'context')];
    const applied = [];
    const journal = {
      pendingFor: () => pending.splice(0),
      markApplied: async (id, result) => applied.push([id, result.replacementSessionId]),
    };
    const calls = [];
    const sessions = [];
    const result = await applyDirectiveCheckpoints({
      task: { id: 'T-0001' }, assignmentId: 'agent-T-0001-implementer-main', worktree: '/same/worktree',
      initialResult: { tokens: 10, subtasks: 1, evidence: [{ criterion: 'works', met: true }] }, journal,
      agent: async (input) => { calls.push(input); return { tokens: 4, subtasks: 1, evidence: input.initialEvidence }; },
      sessionReporter: async (event) => sessions.push(event), idFactory: () => 'run-T-0001-2-next',
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].worktree, '/same/worktree');
    assert.equal(calls[0].continuation.assignmentId, 'agent-T-0001-implementer-main');
    assert.equal(calls[0].continuation.directives.length, 2);
    assert.deepEqual(applied, [['directive-a', 'run-T-0001-2-next'], ['directive-b', 'run-T-0001-2-next']]);
    assert.deepEqual(sessions.map((item) => item.operation), ['start', 'finish']);
    assert.equal(result.tokens, 14);
  });

  it('caps continuations at five and leaves later directives pending without treating them as an agent failure', async () => {
    let round = 0;
    const journal = {
      pendingFor: () => (round++ < 7 ? [directive(`directive-${round}`)] : []),
      markApplied: async () => {},
    };
    let calls = 0;
    const result = await applyDirectiveCheckpoints({
      task: { id: 'T-0001' }, assignmentId: 'agent-T-0001-implementer-main', worktree: '/w',
      initialResult: { tokens: 0, evidence: [] }, journal,
      agent: async () => { calls += 1; return { tokens: 1, evidence: [] }; },
      log: { warn() {} },
    });
    assert.equal(calls, 5);
    assert.equal(result.tokens, 5);
    assert.equal(result.directivesDeferred, true);
  });
});
