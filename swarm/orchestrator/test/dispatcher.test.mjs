import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/store.mjs';
import { writePause } from '../src/controls.mjs';
import { DISPATCH, createBusListener, createDispatchExecutor, managersFrom, parseManagerMessage, planDispatch, startDispatcher } from '../src/dispatcher.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-02T12:00:00Z');
const mgr = (patch = {}) => ({ name: 'me-core', departments: ['core'], at: NOW - 30_000, freeSlots: 1, running: [], ...patch });
const plan = (managers, queued, busOnline) => planDispatch({ now: NOW, managers, queued: new Map(Object.entries(queued)), busOnline });

describe('parseManagerMessage', () => {
  it('reads ready, blocked and help, and ignores chatter', () => {
    assert.deepEqual(parseManagerMessage('ready free 2'), { kind: 'ready' });
    assert.deepEqual(parseManagerMessage('blocked T-0004 tests need a token'), { kind: 'blocked', taskId: 'T-0004', reason: 'tests need a token' });
    assert.deepEqual(parseManagerMessage('help  stuck on rebase'), { kind: 'help', text: 'stuck on rebase' });
    assert.equal(parseManagerMessage('I am ready-ish, maybe'), null);
    assert.equal(parseManagerMessage('hello'), null);
  });
});

describe('planDispatch', () => {
  it('nudges an idle online manager for the best queued task of its department', () => {
    const { presence, actions } = plan([mgr()], { core: ['T-0002', 'T-0003'] });
    assert.deepEqual(presence, [{ name: 'me-core', state: 'idle' }]);
    assert.deepEqual(actions, [{ type: 'dispatch.nudge', manager: 'me-core', department: 'core', taskId: 'T-0002', count: 1 }]);
  });

  it('a busy manager is not nudged and raises nothing', () => {
    const { presence, actions } = plan([mgr({ freeSlots: 0, running: ['T-0001'] })], { core: ['T-0002'] });
    assert.equal(presence[0].state, 'busy');
    assert.deepEqual(actions, []);
  });

  it('queued work with no online manager raises no_manager', () => {
    const { presence, actions } = plan([mgr({ at: NOW - (DISPATCH.onlineMs + MIN) })], { core: ['T-0002'], runtime: ['T-0009'] });
    assert.equal(presence[0].state, 'offline');
    assert.deepEqual(actions.map((a) => [a.type, a.department]), [['dispatch.no_manager', 'core'], ['dispatch.no_manager', 'runtime']]);
  });

  it('a manager online on the bus without a heartbeat is offline: nudged as a hint, never assigned', () => {
    const { presence, actions } = plan([mgr({ at: 0, freeSlots: undefined })], { core: ['T-0002'] }, new Set(['me-core']));
    assert.deepEqual(presence, [{ name: 'me-core', state: 'offline' }]);
    assert.deepEqual(actions.map((a) => a.type), ['dispatch.no_manager', 'dispatch.nudge']);
  });

  it('a bus-online manager with a stale heartbeat does not count as idle for another one', () => {
    const managers = [mgr({ name: 'a-core', at: 0 }), mgr({ name: 'b-core', freeSlots: 1 })];
    const { presence, actions } = plan(managers, { core: ['T-1', 'T-2'] }, new Set(['a-core']));
    assert.deepEqual(presence.map((p) => p.state), ['offline', 'idle']);
    assert.deepEqual(actions, [{ type: 'dispatch.nudge', manager: 'b-core', department: 'core', taskId: 'T-1', count: 1 }]);
  });

  it('splits queued tasks across idle managers by free slots', () => {
    const managers = [mgr({ name: 'a-core', freeSlots: 2 }), mgr({ name: 'b-core', freeSlots: 1 })];
    const { actions } = plan(managers, { core: ['T-1', 'T-2', 'T-3', 'T-4'] });
    assert.deepEqual(actions.map((a) => [a.manager, a.taskId, a.count]), [['a-core', 'T-1', 2], ['b-core', 'T-3', 1]]);
  });

  it('free slots are shared across departments', () => {
    const m = mgr({ departments: ['core', 'runtime'], freeSlots: 1 });
    const { actions } = plan([m], { core: ['T-1'], runtime: ['T-2'] });
    assert.deepEqual(actions.map((a) => a.taskId), ['T-1']);
  });

  it('empty queues do nothing', () => {
    assert.deepEqual(plan([mgr()], { core: [] }).actions, []);
  });
});

describe('managersFrom', () => {
  it('joins manager tokens with heartbeats and skips intake tokens', () => {
    const tokens = { managers: { 'me-core': { departments: ['core'], roles: ['manager'] }, intake: { roles: ['intake'] }, 'owner-ops': { departments: [], roles: ['manager', 'owner'] } } };
    const beats = new Map([['me-core', { at: 5, freeSlots: 1, running: [] }]]);
    assert.deepEqual(managersFrom(tokens, beats), [{ name: 'me-core', departments: ['core'], at: 5, freeSlots: 1, running: [] }]);
  });
});

describe('dispatch executor', () => {
  it('DMs the manager once per task per cooldown, and alerts no_manager on the channel', async () => {
    const sent = [];
    const emitted = [];
    const bus = { direct: async (to, text) => sent.push([to, text]) };
    const ex = createDispatchExecutor({ bus, emit: (a) => emitted.push(a), cooldownMs: 10 * MIN });
    const actions = [
      { type: 'dispatch.nudge', manager: 'me-core', department: 'core', taskId: 'T-2', count: 1 },
      { type: 'dispatch.no_manager', department: 'runtime', count: 3 },
    ];
    await ex.apply(actions, NOW);
    await ex.apply(actions, NOW + MIN);
    assert.deepEqual(sent, [['me-core', 'dispatch: 1 task(s) queued in core, next T-2. Lease now.']]);
    assert.deepEqual(emitted.map((a) => [a.type, a.severity]), [['dispatch.nudge', 'info'], ['dispatch.no_manager', 'warn']]);
    await ex.apply(actions, NOW + 11 * MIN);
    assert.equal(sent.length, 2, 'nudged again after the cooldown');
  });
});

describe('bus listener', () => {
  it('skips history on the first read, then hands over new direct messages in order', async () => {
    let inbox = [{ id: 5, to_agent: 'o', content: 'ready' }];
    const seen = [];
    const listener = createBusListener({ bus: { inbox: async () => inbox }, onMessage: async (m) => seen.push(m.id) });
    assert.equal(await listener.tick(), 0);
    inbox = [{ id: 8, to_agent: 'o', content: 'b' }, { id: 7, to_agent: null, content: 'channel chatter' }, { id: 6, to_agent: 'o', content: 'a' }, ...inbox];
    assert.equal(await listener.tick(), 2);
    assert.deepEqual(seen, [6, 8]);
    assert.equal(await listener.tick(), 0, 'nothing twice');
  });

  it('a throw on message 2 of 3 does not replay message 1 next tick', async () => {
    let inbox = [{ id: 1, to_agent: 'o', content: 'x' }];
    const seen = [];
    const listener = createBusListener({ bus: { inbox: async () => inbox }, onMessage: async (m) => { seen.push(m.id); if (m.id === 3) throw new Error('boom'); } });
    await listener.tick();
    inbox = [2, 3, 4].map((id) => ({ id, to_agent: 'o', content: 'x' })).concat(inbox);
    await assert.rejects(listener.tick(), /boom/);
    await listener.tick();
    assert.deepEqual(seen, [2, 3, 4]);
  });

  it('restart: handles a message after the stored id once, not one older than 30 min', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'disp-'));
    const path = join(dir, 's.db');
    const at = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const now = Date.parse('2026-11-02T12:00:00Z');
    const clock = { now: () => now };
    let inbox = [{ id: 5, to_agent: 'o', content: 'ready', created_at: at(now - 3_600_000) }];
    let store = openStore({ path });
    let l = createBusListener({ bus: { inbox: async () => inbox }, onMessage: async () => assert.fail('first run'), store, clock });
    assert.equal(await l.tick(), 0);
    store.close(); // orchestrator down
    inbox = [
      { id: 8, to_agent: 'o', content: 'ready', created_at: at(now - 60_000) },
      { id: 7, to_agent: 'o', content: 'ready', created_at: at(now - 31 * 60_000) },
      ...inbox,
    ];
    store = openStore({ path });
    const seen = [];
    l = createBusListener({ bus: { inbox: async () => inbox }, onMessage: async (m) => seen.push(m.id), store, clock });
    assert.equal(await l.tick(), 1);
    assert.deepEqual(seen, [8]);
    store.close();
    store = openStore({ path });
    l = createBusListener({ bus: { inbox: async () => inbox }, onMessage: async () => assert.fail('twice'), store, clock });
    assert.equal(await l.tick(), 0);
    assert.equal(store.getMeta('dispatcher.last_message_id'), '8');
    store.close();
  });

  it('warns when a full batch does not reach the stored id', async () => {
    const store = openStore({});
    store.setMeta('dispatcher.last_message_id', 10);
    const warns = [];
    const inbox = Array.from({ length: 100 }, (_, i) => ({ id: 500 - i, to_agent: 'o', content: 'x' }));
    const l = createBusListener({ bus: { inbox: async () => inbox }, onMessage: async () => {}, store, log: { warn: (t) => warns.push(t) } });
    await l.tick();
    assert.equal(warns.length, 1);
    assert.match(warns[0], /skipped/);
  });

  it('a failed inbox read changes nothing', async () => {
    const listener = createBusListener({ bus: { inbox: async () => null }, onMessage: async () => assert.fail('no call') });
    assert.equal(await listener.tick(), 0);
  });
});

describe('startDispatcher (wired)', () => {
  function wired({ inbox = [], beat = true, alertCooldownMs } = {}) {
    const store = openStore({ clock: { now: () => NOW }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'body' });
    store.createTask({ id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 't', department: 'core', priority: 'p1', size: 'S',
      paths: ['swarm/x.mjs'], dependsOn: [], acceptance: ['works'], budget: { tokens: 1000, minutes: 30 } });
    const bus = {
      dms: [], posts: [], mail: inbox,
      passes: 0,
      agents: async () => (bus.passes++, bus.roster),
      roster: [{ id: 'id-mgr', name: 'me-core', status: 'online' }, { id: 'id-x', name: 'stranger', status: 'online' }],
      direct: async (to, text) => bus.dms.push([to, text]),
      send: async (ch, text) => bus.posts.push([ch, text]),
      inbox: async () => bus.mail,
    };
    const tokens = { managers: { 'me-core': { departments: ['core'], roles: ['manager'] } } };
    const quiet = { log() {}, warn() {}, error() {} };
    const d = startDispatcher({ store, heartbeats: new Map(beat ? [['me-core', { at: NOW, freeSlots: 1, running: [] }]] : []), bus, departments: { departments: { core: {} } }, readManagerTokens: () => tokens,
      log: quiet, listenMs: 3_600_000, dispatchMs: 3_600_000, clock: { now: () => NOW }, alertCooldownMs });
    return { d, bus, store };
  }

  it('a paused department or manager gets no nudge', async () => {
    const { d, bus, store } = wired();
    writePause(store, 'departments', 'core', { reason: 'refactor', by: 'owner', at: 'x' });
    await d.pass();
    assert.equal(bus.dms.length, 0);
    assert.ok(!bus.posts.some(([, t]) => /no_manager/.test(t)), 'no alert for a paused department');
    writePause(store, 'departments', 'core', null);
    writePause(store, 'managers', 'me-core', { reason: 'away', by: 'me', at: 'x' });
    await d.pass();
    assert.equal(bus.dms.length, 0);
  });

  it('a pass nudges the manager that is online on the bus for the queued task', async () => {
    const { d, bus } = wired();
    await d.pass();
    assert.deepEqual(bus.dms[0], ['me-core', 'dispatch: 1 task(s) queued in core, next T-0001. Lease now.']);
  });

  it('blocked from a manager becomes a swarm alert; blocked from a stranger is ignored', async () => {
    const { d, bus } = wired();
    await d.pass(); // learns bus ids -> names
    await d.listener.tick();
    bus.mail = [
      { id: 2, from_agent: 'id-x', to_agent: 'o', content: 'blocked T-0001 fake' },
      { id: 1, from_agent: 'id-mgr', to_agent: 'o', content: 'blocked T-0001 needs a token' },
    ];
    assert.equal(await d.listener.tick(), 2);
    assert.deepEqual(bus.posts, [['swarm', 'WARN manager.blocked manager:me-core: T-0001: needs a token']]);
  });

  const settle = () => new Promise((r) => setImmediate(r));
  const from = (id, n, content) => ({ id: n, from_agent: id, to_agent: 'o', content });

  it('ready from a non-manager starts no pass', async () => {
    const { d, bus } = wired();
    await d.pass();
    await d.listener.tick();
    const before = bus.passes;
    bus.mail = [from('id-x', 1, 'ready')];
    await d.listener.tick();
    await settle();
    assert.equal(bus.passes, before);
  });

  it('a burst of ready messages runs at most two passes', async () => {
    const { d, bus } = wired();
    await d.pass();
    await d.listener.tick();
    const before = bus.passes;
    bus.mail = Array.from({ length: 100 }, (_, i) => from('id-mgr', i + 1, 'ready'));
    await d.listener.tick();
    await settle();
    await settle();
    assert.ok(bus.passes - before >= 1 && bus.passes - before <= 2, `passes: ${bus.passes - before}`);
  });

  it('a multi-line 1000-char alert is posted as one line of 200 chars or less, once per cooldown', async () => {
    const { d, bus } = wired({ alertCooldownMs: 10 * MIN });
    await d.pass();
    await d.listener.tick();
    const long = 'help ' + 'word\n  line '.repeat(80);
    bus.mail = [from('id-mgr', 2, long), from('id-mgr', 1, long)];
    await d.listener.tick();
    const alerts = bus.posts.filter(([, t]) => t.includes('manager.help'));
    assert.equal(alerts.length, 1);
    assert.ok(alerts[0][1].length <= 200 && !/\s{2}|\n/.test(alerts[0][1]));
  });

  it('a manager with no heartbeat but an online bus name is offline: no_manager alert', async () => {
    const { d, bus } = wired({ beat: false });
    await d.pass();
    assert.ok(bus.posts.some(([, t]) => t.includes('dispatch.no_manager')));
  });
});
