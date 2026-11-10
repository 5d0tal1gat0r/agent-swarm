import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { assertValid, validate } from '../validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (...parts) => JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', ...parts), 'utf8'));
const withField = (base, patch) => ({ ...base, ...patch });

describe('protocol schemas', () => {
  it('accepts the valid task, epic and lease request fixtures', () => {
    assert.deepEqual(validate('task', fixture('valid', 'task.json')), { ok: true, errors: [] });
    assert.deepEqual(validate('epic', fixture('valid', 'epic.json')), { ok: true, errors: [] });
    assert.deepEqual(validate('api/lease.request', fixture('valid', 'lease.request.json')), { ok: true, errors: [] });
  });

  it('rejects a bad priority and names the field', () => {
    const task = withField(fixture('valid', 'task.json'), { priority: 'urgent' });
    const { ok, errors } = validate('task', task);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => e.startsWith('/priority')), errors.join('\n'));
  });

  it('rejects a path that escapes the repo', () => {
    const task = withField(fixture('valid', 'task.json'), { paths: ['../etc/passwd'] });
    assert.throws(() => assertValid('task', task), /invalid task: \/paths\/0/);
  });

  it('rejects an absolute path', () => {
    const task = withField(fixture('valid', 'task.json'), { paths: ['/etc/passwd'] });
    assert.equal(validate('task', task).ok, false);
  });

  it('rejects unknown fields and names them', () => {
    const task = withField(fixture('valid', 'task.json'), { foo: 1 });
    const { errors } = validate('task', task);
    assert.ok(errors.some((e) => e.includes("'foo'")), errors.join('\n'));
  });

  it('rejects more than 10 lease slots', () => {
    assert.throws(() => assertValid('api/lease.request', fixture('invalid', 'lease-slots-too-many.json')), /\/slots/);
  });

  it('rejects a submit with a malformed head SHA', () => {
    assert.throws(() => assertValid('api/submit.request', fixture('invalid', 'submit-bad-sha.json')), /\/headSha/);
  });

  it('rejects a task id that does not match T-nnnn', () => {
    const task = withField(fixture('valid', 'task.json'), { id: 'task-1' });
    assert.throws(() => assertValid('task', task), /\/id/);
  });

  it('rejects an event type that is not in the list', () => {
    const ev = { type: 'task.exploded', at: '2026-11-01T18:00:00.000Z', taskId: 'T-0001', department: 'core', data: {} };
    assert.throws(() => assertValid('events/event', ev), /\/type/);
  });

  it('accepts a snapshot response with departmentInfo', () => {
    assert.deepEqual(validate('api/snapshot.response', fixture('valid', 'snapshot.response.json')), { ok: true, errors: [] });
  });

  it('accepts a snapshot response without departmentInfo', () => {
    const snapshot = fixture('valid', 'snapshot.response.json');
    delete snapshot.departmentInfo;
    assert.deepEqual(validate('api/snapshot.response', snapshot), { ok: true, errors: [] });
  });

  it('pauses is the object readPauses returns ({ departments, managers }), not an array', async () => {
    const { readPauses } = await import('../../orchestrator/src/controls.mjs');
    const snapshot = fixture('valid', 'snapshot.response.json');
    snapshot.pauses = readPauses({ getMeta: () => null });
    assert.deepEqual(validate('api/snapshot.response', snapshot), { ok: true, errors: [] });
    snapshot.pauses = [];
    assert.equal(validate('api/snapshot.response', snapshot).ok, false);
  });

  it('rejects an invalid departmentInfo item', () => {
    assert.throws(() => assertValid('api/snapshot.response', fixture('invalid', 'snapshot-bad-department-info.json')), /\/departmentInfo\/0\/agent/);
  });

  it('accepts agent cockpit contracts', () => {
    const event = fixture('valid', 'agent-event.json');
    const assignment = {
      id: event.assignmentId,
      kind: 'subagent',
      parentId: 'manager-core',
      manager: event.manager,
      taskId: event.taskId,
      role: 'implementer',
      status: 'running',
      createdAt: event.at,
      updatedAt: event.at
    };
    const session = {
      id: event.sessionId,
      assignmentId: event.assignmentId,
      agentKind: 'codex',
      model: 'gpt-5.6-luna',
      status: 'running',
      phase: 'implement',
      startedAt: event.at,
      updatedAt: event.at,
      inputTokens: 0,
      outputTokens: 0,
      lastEventSeq: 1
    };
    const directive = {
      id: 'directive-a1b2c3d4',
      idempotencyKey: 'browser-a1b2c3d4',
      target: event.assignmentId,
      taskId: event.taskId,
      kind: 'prompt',
      payload: { text: 'Check the retry path.' },
      actor: 'owner',
      reason: 'Clarify the implementation',
      status: 'queued',
      createdAt: event.at
    };
    const turn = {
      id: 'turn-a1b2c3d4',
      conversationTarget: 'orchestrator',
      messageId: 1,
      status: 'queued',
      createdAt: event.at,
      attempts: 0
    };

    for (const [name, value] of [
      ['agent-assignment', assignment],
      ['agent-session', session],
      ['agent-event', event],
      ['agent-directive', directive],
      ['operator-turn', turn],
      ['api/agent-events.request', { events: [event] }],
      ['api/agent-session.request', { operation: 'start', session }],
      ['api/agent-directive.request', { status: 'delivered' }],
      ['api/agent-context.request', {
        idempotencyKey: 'browser-a1b2c3d5',
        reason: 'Use the focused test role',
        context: {
          goal: 'Finish the retry behavior',
          currentTask: 'Add the failing integration test',
          sessionSkills: { roles: ['test-writer'], note: 'Keep the fixture small.' },
          model: 'gpt-5.6-luna',
          runtimeMinutes: 20,
          guardrails: { allowedPaths: ['swarm/manager/**'], instructions: 'Do not edit protocol files.' }
        }
      }]
    ]) {
      assert.deepEqual(validate(name, value), { ok: true, errors: [] }, name);
    }
  });

  it('rejects unknown agent event fields', () => {
    const { ok, errors } = validate('agent-event', fixture('invalid', 'agent-event-secret-field.json'));
    assert.equal(ok, false);
    assert.ok(errors.some((error) => error.includes("'environment'")), errors.join('\n'));
  });

  it('rejects oversized agent event detail', () => {
    const event = fixture('valid', 'agent-event.json');
    event.data = { excerpt: 'x'.repeat(4097) };
    const { ok, errors } = validate('agent-event', event);
    assert.equal(ok, false);
    assert.ok(errors.some((error) => error.startsWith('/data')), errors.join('\n'));
  });

  it('rejects unsafe context widening fields', () => {
    const { ok, errors } = validate('api/agent-context.request', {
      idempotencyKey: 'browser-a1b2c3d6',
      reason: 'Try an unsafe path',
      context: { guardrails: { allowedPaths: ['../secrets/**'] } }
    });
    assert.equal(ok, false);
    assert.ok(errors.some((error) => error.includes('/context/guardrails/allowedPaths/0')), errors.join('\n'));
  });

  it('rejects unknown directive kind', () => {
    const event = fixture('valid', 'agent-event.json');
    const { ok, errors } = validate('agent-directive', {
      id: 'directive-a1b2c3d7',
      idempotencyKey: 'browser-a1b2c3d7',
      target: event.assignmentId,
      taskId: event.taskId,
      kind: 'shell',
      payload: {},
      actor: 'owner',
      reason: 'Must be rejected',
      status: 'queued',
      createdAt: event.at
    });
    assert.equal(ok, false);
    assert.ok(errors.some((error) => error.startsWith('/kind')), errors.join('\n'));
  });
});
