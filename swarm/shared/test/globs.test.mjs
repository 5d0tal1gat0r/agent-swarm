import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { intersects, matchGlob, overlaps, splitGlob, unmatched } from '../globs.mjs';

describe('glob matching', () => {
  it('* stays inside one segment', () => {
    assert.equal(matchGlob('docs/*.md', 'docs/a.md'), true);
    assert.equal(matchGlob('docs/*.md', 'docs/x/a.md'), false);
  });

  it('** matches zero or more segments', () => {
    assert.equal(matchGlob('swarm/protocol/**', 'swarm/protocol'), true);
    assert.equal(matchGlob('swarm/protocol/**', 'swarm/protocol/api/a.json'), true);
    assert.equal(matchGlob('swarm/protocol/**', 'swarm/orchestrator/x.mjs'), false);
    assert.equal(matchGlob('a/**/b.mjs', 'a/b.mjs'), true);
    assert.equal(matchGlob('a/**/b.mjs', 'a/x/y/b.mjs'), true);
  });

  it('literal names match only themselves', () => {
    assert.equal(matchGlob('autopilot/README.md', 'autopilot/README.md'), true);
    assert.equal(matchGlob('autopilot/README.md', 'autopilot/readme.md'), false);
  });

  it('rejects globs that escape the repo or misuse **', () => {
    assert.throws(() => splitGlob('../x/**'), /stay inside the repo/);
    assert.throws(() => splitGlob('/etc/**'), /stay inside the repo/);
    assert.throws(() => splitGlob('a/x**y'), /whole path segment/);
    assert.throws(() => splitGlob(''), /non-empty/);
  });
});

describe('overlap detection', () => {
  it('detects nested and identical ownership', () => {
    assert.equal(overlaps('swarm/**', 'swarm/orchestrator/**'), true);
    assert.equal(overlaps('autopilot/*.json', 'autopilot/**'), true);
    assert.equal(overlaps('swarm/x/**', 'swarm/x/**'), true);
  });

  it('keeps disjoint trees and sibling files apart', () => {
    assert.equal(overlaps('docs/**', '*.md'), false);
    assert.equal(overlaps('autopilot/README.md', 'autopilot/src/**'), false);
    assert.equal(overlaps('swarm/orchestrator/**', 'swarm/protocol/**'), false);
  });

  it('single-segment patterns intersect exactly', () => {
    assert.equal(intersects('*.md', 'README.*'), true);
    assert.equal(intersects('*.md', '*.mjs'), false);
    assert.equal(intersects('a*', '*b'), true);
    assert.equal(intersects('ab', 'a*c'), false);
  });
});

describe('coverage', () => {
  it('lists files that no glob owns', () => {
    assert.deepEqual(unmatched(['docs/**'], ['docs/a.md', 'src/b.mjs']), ['src/b.mjs']);
  });
});
