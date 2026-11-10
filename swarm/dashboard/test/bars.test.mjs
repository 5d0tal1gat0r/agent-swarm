import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyBars, barWidth } from '../src/static/bars.mjs';

// The dashboard CSP is style-src 'self': inline style="" attributes are ignored by the browser,
// so bars carry data-w (a percentage) or data-flex and get their size through the CSSOM.
describe('bars', () => {
  it('barWidth clamps to a whole percentage', () => {
    assert.equal(barWidth('42'), '42%');
    assert.equal(barWidth('140'), '100%');
    assert.equal(barWidth('-3'), '0%');
    assert.equal(barWidth('x'), '0%');
  });

  it('applyBars sets width and flex from data attributes', () => {
    const el = (attrs) => ({ dataset: attrs, style: {} });
    const w = el({ w: '30' }); const f = el({ flex: '0.25' }); const bad = el({ flex: 'calc(1)' });
    const root = { querySelectorAll: (sel) => (sel === '[data-w]' ? [w] : [f, bad]) };
    applyBars(root);
    assert.equal(w.style.width, '30%');
    assert.equal(f.style.flexGrow, '0.25');
    assert.equal(bad.style.flexGrow, undefined, 'only plain numbers are applied');
  });
});
