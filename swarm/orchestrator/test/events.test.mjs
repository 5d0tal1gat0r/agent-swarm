import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SWARM_CHANNEL, sendEnvelope, allChannels, channelsFor, isValidChannelName, envelopeFor, eventTypeFor, publishEvents } from '../src/events.mjs';
import { loadDepartments } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';

const SHA = 'c'.repeat(40);
const task = (id, extra = {}) => ({
  id, epicId: 'E-0001', repo: 'o/r', title: id, department: 'core', priority: 'p1', size: 'S',
  paths: ['swarm/orchestrator/src/x.mjs'], dependsOn: [], acceptance: ['ok'],
  budget: { tokens: 500000, minutes: 30 }, ...extra,
});

function setup() {
  const clock = { t: Date.parse('2026-11-01T18:00:00.000Z'), now() { return this.t; }, advance(ms) { this.t += ms; } };
  const store = openStore({ clock });
  store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
  return { store, clock };
}

describe('events: mapping', () => {
  it('maps store moves to the spec event names', () => {
    assert.equal(eventTypeFor('blocked', 'queued'), 'task.queued');
    assert.equal(eventTypeFor('queued', 'leased'), 'task.leased');
    assert.equal(eventTypeFor('leased', 'in_progress'), 'task.progress');
    assert.equal(eventTypeFor('in_progress', 'submitted'), 'task.submitted');
    assert.equal(eventTypeFor('in_review', 'merged'), 'task.merged');
    assert.equal(eventTypeFor('failed', 'escalated'), 'task.escalated');
    assert.equal(eventTypeFor('queued', 'cancelled'), 'task.cancelled');
    assert.equal(eventTypeFor('in_review', 'changes_requested'), 'review.changes_requested');
  });

  it('publishes nothing for internal moves', () => {
    assert.equal(eventTypeFor('submitted', 'in_review'), null);
    assert.equal(eventTypeFor('in_review', 'needs-human'), null);
  });

  it('every envelope validates against the event schema', () => {
    const env = envelopeFor({ taskId: 'T-0001', department: 'core', from: 'queued', to: 'leased', reason: 'leased by m', at: '2026-11-01T18:00:00.000Z' });
    assert.equal(env.type, 'task.leased');
    assert.deepEqual(env.data, { from: 'queued', to: 'leased', reason: 'leased by m' });
  });

  it('publishes to swarm and to the department channel', () => {
    assert.deepEqual(channelsFor('core'), ['swarm', 'dept-core']);
  });
});

describe('events: bus', () => {
  it('sends each change to both channels, after commit', async () => {
    const { store } = setup();
    const sent = [];
    const bus = { send: async (channel, text) => { sent.push([channel, text]); } };
    publishEvents(store, bus);
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent.map(([c]) => c), ['swarm', 'dept-core']);
    assert.match(sent[0][1], /^task\.leased T-0001 \(core\): queued -> leased - leased by m1$/);
  });

  it('a bus that throws or hangs never changes the store', async () => {
    const { store } = setup();
    const bus = { send: () => { throw new Error('bus is down'); } };
    const warnings = [];
    publishEvents(store, bus, { log: { warn: (m) => warnings.push(m) } });
    store.createTask(task('T-0001'));
    const leased = store.lease({ department: 'core', slots: 1, manager: 'm1' });
    assert.equal(leased[0].status, 'leased');
    assert.equal(store.getTask('T-0001').status, 'leased');
    await new Promise((r) => setImmediate(r));
    assert.ok(warnings.length >= 2, 'failures are logged, not thrown');
  });

  it('unsubscribe stops publishing', async () => {
    const { store } = setup();
    const sent = [];
    const off = publishEvents(store, { send: async (c) => { sent.push(c); } });
    off();
    store.createTask(task('T-0001'));
    store.lease({ department: 'core', slots: 1, manager: 'm1' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(sent, []);
  });
});

describe('events: channel names', () => {
  const deptFile = new URL('../../departments.yaml', import.meta.url);
  const ids = Object.keys(loadDepartments(deptFile.pathname).departments);

  it('channelsFor returns valid names', () => {
    assert.deepEqual(channelsFor('core'), [SWARM_CHANNEL, 'dept-core']);
    assert.ok(channelsFor('core').every(isValidChannelName));
  });

  it('every channel the code can produce is valid for the real departments.yaml', () => {
    assert.ok(ids.length > 0);
    const names = [...allChannels(ids), ...ids.flatMap(channelsFor)];
    assert.ok(names.includes('swarm'));
    for (const n of names) assert.ok(isValidChannelName(n), n);
  });

  it('isValidChannelName rejects bad names', () => {
    for (const bad of ['#swarm', '#dept-core', 'Swarm', 'a', 'a'.repeat(65), '', 'has space', undefined]) {
      assert.equal(isValidChannelName(bad), false, String(bad));
    }
    assert.equal(isValidChannelName('ab'), true);
    assert.equal(isValidChannelName('a'.repeat(64)), true);
  });
});

describe('events: unregistered channels', () => {
  const env = (department) => ({ type: 'task.queued', at: 'x', taskId: 'T-1', department, data: { from: 'blocked', to: 'queued' } });
  const busWith = (channels) => {
    const sent = [];
    return { sent, hasChannel: (c) => channels.includes(c), send: async (c) => { sent.push(c); } };
  };

  it('a removed department posts only to swarm, warning once', async () => {
    const bus = busWith(['general', 'swarm', 'dept-core']);
    const warns = [];
    const log = { warn: (m) => warns.push(m) };
    await Promise.all(sendEnvelope(bus, env('gone'), { log }));
    await Promise.all(sendEnvelope(bus, env('gone'), { log }));
    assert.deepEqual(bus.sent, ['swarm', 'swarm']);
    assert.equal(warns.length, 1);
  });

  it('a registered department posts to both', async () => {
    const bus = busWith(['general', 'swarm', 'dept-core']);
    await Promise.all(sendEnvelope(bus, env('core')));
    assert.deepEqual(bus.sent, ['swarm', 'dept-core']);
  });
});
