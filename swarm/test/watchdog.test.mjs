import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runOnce, transition } from '../scripts/watchdog.mjs';

const MIN = 60_000;

describe('watchdog', () => {
  it('transition: first run records, a change posts, no change is quiet', () => {
    assert.deepEqual(transition(null, true, 0), { state: { state: 'up', since: 0 }, message: null });
    const down = transition({ state: 'up', since: 0 }, false, 30 * MIN);
    assert.match(down.message, /orchestrator DOWN \(up 30 min before\)/);
    assert.equal(transition(down.state, false, 40 * MIN).message, null);
    assert.equal(transition(down.state, false, 40 * MIN).state.since, 30 * MIN, 'since kept while unchanged');
    assert.match(transition(down.state, true, 45 * MIN).message, /back up \(was down 15 min\)/);
  });

  it('runOnce follows the bus location and posts state changes to swarm', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-')), 'state.json');
    const posts = [];
    const bus = {
      getState: async () => JSON.stringify({ url: 'http://192.0.2.1:3423', host: 'pc' }),
      send: async (ch, text) => posts.push([ch, text]),
    };
    let up = true;
    const fetchImpl = async (url) => {
      assert.equal(url, 'http://192.0.2.1:3423/health');
      if (!up) throw new Error('refused');
      return new Response('{}');
    };
    await runOnce({ url: 'bus', file, now: 0, fetchImpl, bus });
    up = false;
    await runOnce({ url: 'bus', file, now: 5 * MIN, fetchImpl, bus });
    assert.equal(posts.length, 1);
    assert.equal(posts[0][0], 'swarm');
    assert.match(posts[0][1], /DOWN .*\[http:\/\/192\.0\.2\.1:3423\]/);
  });
});
