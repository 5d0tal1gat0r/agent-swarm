import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bannerState, nextProbe } from '../src/static/maint.mjs';

const since = '2026-11-03T17:30:00Z';

describe('maintenance banner', () => {
  it('nothing to show when reachable and not in maintenance', () => {
    assert.equal(bannerState({ reachable: true, maintenance: null }), null);
  });

  it('maintenance on: reason, time and that actions are paused', () => {
    const b = bannerState({ reachable: true, maintenance: { reason: 'upgrade abc -> def', since, overrun: false } }, { timeZone: 'UTC' });
    assert.equal(b.kind, 'on');
    assert.equal(b.text, 'Maintenance: upgrade abc -> def · since 17:30 · actions are paused');
  });

  it('overrun says so and points at swarmctl', () => {
    const b = bannerState({ reachable: true, maintenance: { reason: 'upgrade', since, overrun: true } }, { timeZone: 'UTC' });
    assert.equal(b.kind, 'overrun');
    assert.match(b.text, /^Maintenance overrun: upgrade · since 17:30/);
    assert.match(b.text, /swarmctl status/);
  });

  it('unreachable: restarting, whatever the last flag said', () => {
    assert.deepEqual(bannerState({ reachable: false, maintenance: null }), { kind: 'down', text: 'Dashboard restarting… this page reloads when it is back.' });
  });

  it('nextProbe: reload only when the server comes back after being unreachable', () => {
    assert.deepEqual(nextProbe({ wasDown: false }, true), { wasDown: false, reload: false });
    assert.deepEqual(nextProbe({ wasDown: false }, false), { wasDown: true, reload: false });
    assert.deepEqual(nextProbe({ wasDown: true }, false), { wasDown: true, reload: false });
    assert.deepEqual(nextProbe({ wasDown: true }, true), { wasDown: false, reload: true });
  });
});
