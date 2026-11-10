import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowedEdges, assertTransition, canTransition, STATES, TERMINAL } from '../src/transitions.mjs';

describe('task state machine', () => {
  it('allows every edge in the table', () => {
    const edges = allowedEdges();
    assert.ok(edges.length >= 25, `expected the full table, got ${edges.length}`);
    for (const [from, to] of edges) {
      assert.equal(canTransition(from, to), true, `${from} -> ${to}`);
      assert.doesNotThrow(() => assertTransition(from, to));
    }
  });

  it('rejects a sample of forbidden moves with a clear message', () => {
    const forbidden = [
      ['queued', 'merged'],
      ['queued', 'in_progress'],
      ['blocked', 'leased'],
      ['leased', 'merged'],
      ['in_progress', 'merged'],
      ['submitted', 'merged'],
      ['merged', 'queued'],
      ['cancelled', 'queued'],
      ['escalated', 'merged'],
      ['in_review', 'leased'],
    ];
    for (const [from, to] of forbidden) {
      assert.equal(canTransition(from, to), false, `${from} -> ${to} should be forbidden`);
      assert.throws(() => assertTransition(from, to), new RegExp(`forbidden transition: ${from} -> ${to}`));
    }
  });

  it('treats merged and cancelled as terminal', () => {
    assert.deepEqual([...TERMINAL].sort(), ['cancelled', 'merged']);
    for (const state of TERMINAL) {
      for (const to of STATES) {
        if (to !== state) assert.equal(canTransition(state, to), false, `${state} -> ${to}`);
      }
    }
  });

  it('rejects unknown states', () => {
    assert.throws(() => canTransition('nope', 'queued'), /unknown state: nope/);
    assert.throws(() => canTransition('queued', 'nope'), /unknown state: nope/);
  });
});
