import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createAgentCache } from '../src/agent-cache.mjs';

const summary = {
  assignments: [{ id: 'orchestrator', kind: 'orchestrator', parentId: null, manager: null, taskId: null, role: null, status: 'running', createdAt: 'x', updatedAt: 'x', endedAt: null }],
  sessions: [],
};

describe('agent summary cache', () => {
  it('writes atomically at 0600, reloads, bounds the feed, and never accepts privileged fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cache-'));
    const file = path.join(dir, 'cache.json');
    const cache = createAgentCache({ file, maxItems: 2, clock: { now: () => 123 } });
    cache.replaceSummary(summary);
    cache.appendFeed([{ seq: 1, kind: 'assignment', data: { id: 'a' } }, { seq: 2, kind: 'session', data: { id: 'b' } }, { seq: 3, kind: 'agent-event', data: { summary: 'safe' } }]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(cache.snapshot().feed.map((item) => item.seq), [2, 3]);
    assert.equal(createAgentCache({ file }).load().lastSeq, 3);
    assert.throws(() => cache.replaceSummary({ assignments: [{ ...summary.assignments[0], currentTask: 'private' }], sessions: [] }), /privileged field/);
    assert.throws(() => cache.appendFeed([{ seq: 4, kind: 'message', data: { text: 'private conversation' } }]), /not cacheable|privileged/);
  });
});
