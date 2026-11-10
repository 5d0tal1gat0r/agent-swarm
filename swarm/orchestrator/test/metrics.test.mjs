import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DASHBOARD_CSP, DASHBOARD_HTML, computeMetrics, dailySummary } from '../src/metrics.mjs';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const at = (min) => new Date(Date.parse('2026-11-01T10:00:00Z') + min * 60_000).toISOString();
const task = (patch = {}) => ({
  id: 'T-0001', department: 'core', status: 'queued', lease: null, usedTokens: 0,
  budget: { tokens: 1000, minutes: 30 }, review: null, createdAt: at(0), updatedAt: at(0),
  history: [{ from: null, to: 'queued', at: at(0), reason: 'created' }], ...patch,
});
const merged = (id, mergedAtMin, tokens) => task({
  id, status: 'merged', usedTokens: tokens, updatedAt: at(mergedAtMin),
  history: [{ from: null, to: 'queued', at: at(0), reason: 'created' }, { from: 'in_review', to: 'merged', at: at(mergedAtMin), reason: 'merged' }],
});

describe('computeMetrics', () => {
  it('an empty store gives zeros and nulls, not errors', () => {
    const m = computeMetrics([], { now: NOW });
    assert.equal(m.tasks, 0);
    assert.equal(m.merged.count, 0);
    assert.equal(m.merged.leadTimeMinutes, null);
    assert.equal(m.merged.tokensPerMerged, null);
  });

  it('lead time is created to merged, median and mean over merged tasks', () => {
    const m = computeMetrics([merged('T-1', 30, 100), merged('T-2', 60, 300), merged('T-3', 90, 200)], { now: NOW });
    assert.deepEqual(m.merged.leadTimeMinutes, { median: 60, mean: 60, count: 3 });
    assert.deepEqual(m.merged.tokensPerMerged, { median: 200, mean: 200, count: 3 });
  });

  it('an even count takes the midpoint for the median', () => {
    const m = computeMetrics([merged('T-1', 10, 0), merged('T-2', 30, 0)], { now: NOW });
    assert.equal(m.merged.leadTimeMinutes.median, 20);
  });

  it('counts queued by department, leases held, over-budget tasks, and review rounds', () => {
    const tasks = [
      task({ id: 'T-1', department: 'core' }),
      task({ id: 'T-2', department: 'core' }),
      task({ id: 'T-3', department: 'docs', status: 'queued' }),
      task({ id: 'T-4', status: 'in_progress', lease: { manager: 'm', expiresAt: at(10) }, usedTokens: 900 }),
      task({ id: 'T-5', status: 'changes_requested', review: { headSha: 'a'.repeat(40), evidence: [], rounds: 2, findings: [] } }),
    ];
    const m = computeMetrics(tasks, { now: NOW });
    assert.deepEqual(m.queueDepth, { core: 2, docs: 1 });
    assert.equal(m.leasesHeld, 1);
    assert.equal(m.overBudget, 1, 'T-4 is at 90% of its budget');
    assert.deepEqual(m.reviewRounds, { total: 2, tasks: 1 });
    assert.equal(m.totalTokens, 900);
    assert.deepEqual(m.statusCounts, { queued: 3, in_progress: 1, changes_requested: 1 });
  });
});

describe('daily summary line', () => {
  it('names the merged count, lead time, tokens, queue, leases, budget and rounds', () => {
    const line = dailySummary(computeMetrics([merged('T-1', 30, 100), task({ id: 'T-2' })], { now: NOW }));
    assert.match(line, /^daily: 1 merged, median lead 30 min, median tokens\/merged 100, queued 1, leases 0, over budget 0, review rounds 0$/);
  });

  it('says n/a when nothing merged yet', () => {
    assert.match(dailySummary(computeMetrics([], { now: NOW })), /median lead n\/a/);
  });
});

describe('dashboard page', () => {
  it('has no external resources and no data inside', () => {
    assert.doesNotMatch(DASHBOARD_HTML, /<script[^>]+src=/i);
    assert.doesNotMatch(DASHBOARD_HTML, /<link[^>]+href=/i);
    assert.doesNotMatch(DASHBOARD_HTML, /https?:\/\//);
    assert.doesNotMatch(DASHBOARD_HTML, /T-\d{4}/, 'no task ids in the static page');
  });

  it('ships a CSP with hashes of the inline script and style, no unsafe-inline', () => {
    assert.match(DASHBOARD_CSP, /default-src 'none'/);
    assert.match(DASHBOARD_CSP, /connect-src 'self'/);
    assert.match(DASHBOARD_CSP, /frame-ancestors 'none'/);
    assert.doesNotMatch(DASHBOARD_CSP, /unsafe-inline/);
    for (const [tag, directive] of [['script', 'script-src'], ['style', 'style-src']]) {
      const body = DASHBOARD_HTML.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))[1];
      const hash = createHash('sha256').update(body, 'utf8').digest('base64');
      assert.ok(DASHBOARD_CSP.includes(`${directive} 'sha256-${hash}'`), `${directive} hash matches the inline ${tag}`);
    }
  });

  it('keeps [hidden] working on the flex form, and forgets a refused token', () => {
    assert.match(DASHBOARD_HTML, /\[hidden\] \{ display: none !important; \}/);
    assert.match(DASHBOARD_HTML, /forget\(\); form\.hidden = false/);
    assert.match(DASHBOARD_HTML, /if \(save\) remember\(t\)/);
  });
});
