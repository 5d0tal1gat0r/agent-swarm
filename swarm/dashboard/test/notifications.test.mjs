import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  NOTIFICATION_KINDS,
  chatNotification,
  deriveSnapshotNotifications,
  filterNotifications,
} from '../src/notifications.mjs';

const base = { online: true, tasks: [], epics: [] };
const task = (patch = {}) => ({ id: 'T-0001', title: 'Queue inspection', status: 'queued', updatedAt: '2026-11-06T10:00:00Z', ...patch });

describe('notification event model', () => {
  it('lists every level-1 kind', () => {
    assert.deepEqual(NOTIFICATION_KINDS, ['task-needs-human', 'task-failed', 'pr-merged', 'epic-finished', 'orchestrator-offline', 'orchestrator-online', 'chat-mention', 'chat-message', 'maintenance']);
  });

  it('derives one event for each new task, PR, and epic transition', () => {
    const previous = { ...base, tasks: [task()], epics: [{ id: 'E-1', title: 'Epic', status: 'planned' }] };
    const current = { ...base, tasks: [task({ status: 'needs-human' }), task({ id: 'T-0002', title: 'Merged', status: 'merged', pr: 42 }), { id: 'T-0003', title: 'Failed', status: 'failed' }], epics: [{ id: 'E-1', title: 'Epic', status: 'done' }] };
    const events = deriveSnapshotNotifications(previous, current, { now: '2026-11-06T10:01:00Z' });
    assert.deepEqual(events.map((e) => e.kind), ['task-needs-human', 'pr-merged', 'task-failed', 'epic-finished']);
    assert.equal(events[0].id, 'task-needs-human:T-0001');
    assert.equal(events[1].href, '/?task=T-0002');
  });

  it('does not repeat stable states and reports online transitions once', () => {
    const snapshot = { ...base, tasks: [task({ status: 'failed' })] };
    assert.deepEqual(deriveSnapshotNotifications(snapshot, snapshot), []);
    assert.deepEqual(deriveSnapshotNotifications({ ...snapshot, online: true }, { ...snapshot, online: false }).map((e) => e.kind), ['orchestrator-offline']);
    assert.deepEqual(deriveSnapshotNotifications({ ...snapshot, online: false }, { ...snapshot, online: true }).map((e) => e.kind), ['orchestrator-online']);
  });

  it('creates mentions and followed-channel messages without leaking unrelated chat', () => {
    const mention = chatNotification({ id: 7, channel: 'general', author: 'bob', text: 'hey @alice', at: '2026-11-06T10:00:00Z' }, { name: 'alice', member: 'alice' }, { channels: [] });
    const followed = chatNotification({ id: 8, channel: 'ops', author: 'bob', text: 'deploy started', at: '2026-11-06T10:01:00Z' }, { name: 'alice', member: 'alice' }, { channels: ['ops'] });
    const ignored = chatNotification({ id: 9, channel: 'ops', author: 'bob', text: 'unfollowed', at: '2026-11-06T10:02:00Z' }, { name: 'alice', member: 'alice' }, { channels: [] });
    assert.equal(mention.kind, 'chat-mention');
    assert.equal(followed.kind, 'chat-message');
    assert.equal(ignored, null);
  });

  it('filters by kind, audience, and preferences and bounds payloads', () => {
    const events = deriveSnapshotNotifications(base, { ...base, tasks: [task({ id: 'T-9', title: 'x'.repeat(1000), status: 'failed' })] });
    assert.equal(events[0].body.length <= 500, true);
    assert.equal(filterNotifications(events, { name: 'alice', member: 'alice' }, { kinds: { 'task-failed': false } }).length, 0);
    assert.equal(filterNotifications([{ ...events[0], audience: { users: ['bob'] } }], { name: 'alice', member: 'alice' }, {}).length, 0);
    assert.equal(filterNotifications([{ ...events[0], audience: { users: ['alice'] } }], { name: 'alice', member: 'alice' }, {}).length, 1);
  });
});
