import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { amendRequest, renderFixForm, stuckReason } from '../src/static/fix.mjs';

const task = (o = {}) => ({ id: 'T-0004', title: 'Route', status: 'escalated', paths: ['swarm/orchestrator/src/api.mjs'], acceptance: ['route works'], dependsOn: [], ...o });
const history = [{ from: 'in_progress', to: 'failed', reason: 'checks failed: /pauses must be array' }, { from: 'failed', to: 'escalated', reason: 'attempt 3 of 3 failed: /pauses must be array' }];

describe('fix and retry form', () => {
  it('only the owner sees it, and only on stuck or blocked tasks', () => {
    assert.equal(renderFixForm(task(), { owner: false, history }), '');
    assert.equal(renderFixForm(task({ status: 'in_progress' }), { owner: true }), '');
    for (const status of ['escalated', 'needs-human', 'failed', 'blocked']) assert.match(renderFixForm(task({ status }), { owner: true, history }), /id="fix-form"/);
  });

  it('shows why it is stuck, prefills paths and acceptance, lists dependencies to drop, escapes everything', () => {
    const html = renderFixForm(task({ title: '<b>', acceptance: ['<img src=x>'] }), { owner: true, history });
    assert.match(html, /attempt 3 of 3 failed: \/pauses must be array/);
    assert.match(html, /swarm\/orchestrator\/src\/api\.mjs<\/textarea>/);
    assert.doesNotMatch(html, /<img|<b>/);
    const blocked = renderFixForm(task({ status: 'blocked', dependsOn: ['T-0003'] }), { owner: true, tasks: [{ id: 'T-0003', status: 'escalated', title: 'Schema' }] });
    assert.match(blocked, /value="T-0003"> drop T-0003 <span class="mut">Escalated · Schema/);
    assert.match(blocked, /waits for T-0003 \(Escalated\)/);
  });

  it('stuckReason falls back sensibly', () => {
    assert.equal(stuckReason(task(), []), 'no reason recorded');
    assert.match(stuckReason(task({ status: 'blocked', dependsOn: ['T-1'] }), [], [{ id: 'T-1', status: 'merged' }]), /all dependencies merged/);
  });

  it('the request carries only what changed, one line per entry', () => {
    const t = task({ dependsOn: ['T-0003'] });
    assert.deepEqual(amendRequest(t, { paths: 'swarm/orchestrator/src/api.mjs\n', acceptance: 'route works', reason: ' fix ' }), { reason: 'fix' });
    assert.deepEqual(amendRequest(t, { paths: 'swarm/orchestrator/src/api.mjs\n\n swarm/protocol/api/s.schema.json ', acceptance: 'route works\nschema agrees', drop: ['T-0003'], reason: 'widen' }), {
      reason: 'widen', paths: ['swarm/orchestrator/src/api.mjs', 'swarm/protocol/api/s.schema.json'], acceptance: ['route works', 'schema agrees'], dropDependsOn: ['T-0003'],
    });
  });
});
