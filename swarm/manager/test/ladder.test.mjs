import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_LADDER, assertLadder, modelForAttempt } from '../src/ladder.mjs';

const allowed = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

describe('escalation ladder', () => {
  it('attempt 0 is the cheapest model, each retry steps up, the last step is kept', () => {
    assert.deepEqual([0, 1, 2, 3, 9].map((n) => modelForAttempt(DEFAULT_LADDER, n)), [
      'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5',
    ]);
  });

  it('rejects a negative or non-integer attempt count', () => {
    assert.throws(() => modelForAttempt(DEFAULT_LADDER, -1), /non-negative integer/);
    assert.throws(() => modelForAttempt(DEFAULT_LADDER, 1.5), /non-negative integer/);
  });

  it('accepts a ladder whose ids are all on the allow-list', () => {
    assert.deepEqual(assertLadder(DEFAULT_LADDER, allowed), DEFAULT_LADDER);
  });

  it('rejects an empty ladder, an unknown id, and a malformed id (leading dash)', () => {
    assert.throws(() => assertLadder([], allowed), /non-empty/);
    assert.throws(() => assertLadder(['claude-fake-9'], allowed), /not on the allow-list/);
    assert.throws(() => assertLadder(['--dangerously-skip'], allowed), /malformed/);
    assert.throws(() => assertLadder([42], allowed), /malformed/);
  });
});
