import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildGraph } from '../src/static/graph.mjs';
import { formatDuration, modelOf, nodeCard, renderCard, taskTiming } from '../src/static/graph-card.mjs';

const HISTORY = [
  { from: null, to: 'blocked', at: '2026-11-02T22:32:42.941Z', reason: 'created' },
  { from: 'blocked', to: 'queued', at: '2026-11-03T11:44:10.676Z', reason: 'dependencies merged: T-0006, T-0003' },
  { from: 'queued', to: 'leased', at: '2026-11-03T11:44:35.611Z', reason: 'leased by owner-laptop' },
  { from: 'leased', to: 'in_progress', at: '2026-11-03T11:44:36.923Z', reason: 'first progress report' },
  { from: 'in_progress', to: 'cancelled', at: '2026-11-03T13:12:56.550Z', reason: 'monitor: minutes budget spent: 88 of 30 min' },
];
const cancelled = {
  id: 'T-0007', epicId: 'E-0003', title: 'ARCHITECTURE entry', department: 'docs', priority: 'p3', size: 'S',
  paths: ['swarm/ARCHITECTURE.md'], dependsOn: ['T-0006', 'T-0003'], acceptance: ['has an entry', 'no new endpoint'],
  budget: { tokens: 500000, minutes: 30 }, status: 'cancelled', attempts: 0, usedTokens: 0, holder: 'owner-laptop',
  branch: null, pr: null, lastPhase: 'planning', lastNote: 'worktree docs/t-0007 model claude-haiku-5-5',
  createdAt: '2026-11-02T22:32:42.941Z', updatedAt: '2026-11-03T13:12:56.550Z',
};
const merged = {
  id: 'T-0006', epicId: 'E-0003', title: 'Departments panel', department: 'dashboard', status: 'merged', usedTokens: 120000,
  budget: { tokens: 400000 }, holder: 'owner-laptop', pr: 250, repo: 'org/repo', paths: ['swarm/dashboard/**'],
  createdAt: '2026-11-02T22:32:00Z', updatedAt: '2026-11-03T11:40:00Z',
};
const epic = { id: 'E-0003', title: 'Departments panel', status: 'open', issue: 186, repo: 'org/repo',
  body: '**Goal.** The dashboard shows how the swarm is set up.\nSecond line.\n\n**What.**\n- more' };
const snapshot = {
  departments: ['docs', 'dashboard'],
  departmentInfo: [{ id: 'docs', agent: 'claude', paths: ['**/*.md'], concurrency: 1, maxSubagents: 2, host: null }],
  managers: [{ name: 'owner-laptop', state: 'idle', member: 'owner', departments: ['docs', 'dashboard'], lastHeartbeat: 1, freeSlots: 1, running: [] }],
  epics: [epic],
  tasks: [cancelled, merged],
};
const bus = {
  agents: [{ id: 'a1', name: 'owner-laptop', status: 'online', status_text: 'idle', last_heartbeat: '2026-11-03 13:00:00' }],
  channels: [{ id: 'c1', name: 'swarm', description: 'swarm events' }],
  messages: { swarm: [
    { id: 1, from_agent: 'a1', content: 'task.merged T-0006 PR #250', created_at: '2026-11-03T11:40:00Z' },
    { id: 2, from_agent: 'a1', content: 'leased T-0007', created_at: '2026-11-03T11:44:35Z' },
  ] },
  state: [{ namespace: 'locks', key: 'swarm/ARCHITECTURE.md', value: 'owner-laptop', updated_by: 'a1', updated_at: '2026-11-03T11:45:00Z' }],
};
const graph = buildGraph(bus, snapshot);
const ctx = { graph, bus, snapshot, now: Date.parse('2026-11-04T00:00:00Z') };
const fact = (card, label) => card.facts.find(([l]) => l === label)?.[1];
const node = (id) => graph.nodes.find((n) => n.id === id);

describe('graph node cards', () => {
  it('formatDuration reads like a person wrote it', () => {
    assert.equal(formatDuration(45_000), '45 s');
    assert.equal(formatDuration(88 * 60_000 + 20_000), '1 h 28 min');
    assert.equal(formatDuration(3 * 86400_000 + 5 * 3600_000), '3 d 5 h');
    assert.equal(formatDuration(null), '-');
  });

  it('modelOf reads the model from the last note', () => {
    assert.equal(modelOf(cancelled), 'claude-haiku-5-5');
    assert.equal(modelOf({ lastNote: 'no model here' }), null);
  });

  it('taskTiming splits waiting from working and finds the end', () => {
    const t = taskTiming(HISTORY);
    assert.equal(t.startedAt, '2026-11-03T11:44:35.611Z');
    assert.equal(t.endedAt, '2026-11-03T13:12:56.550Z');
    assert.equal(formatDuration(t.workMs), '1 h 28 min');
    assert.equal(formatDuration(t.waitMs), '13 h 11 min');
    assert.equal(t.outcome, 'monitor: minutes budget spent: 88 of 30 min');
    const open = taskTiming(HISTORY.slice(0, 4), Date.parse('2026-11-03T12:44:36.923Z'));
    assert.equal(open.endedAt, null);
    assert.equal(formatDuration(open.workMs), '1 h');
    assert.deepEqual(taskTiming([]), { createdAt: null, startedAt: null, endedAt: null, waitMs: null, workMs: null, outcome: null, steps: [] });
  });

  it('task card: tags, who, what it affects, tokens, summary, timeline once history is known', () => {
    const card = nodeCard(node('task:T-0007'), { ...ctx, history: HISTORY });
    assert.deepEqual(card.tags.map((t) => t.text), ['Cancelled', 'docs', 'p3', 'size S', 'claude-haiku-5-5']);
    assert.equal(card.tags[0].tone, 'bad');
    assert.equal(fact(card, 'Who'), 'owner-laptop');
    assert.equal(fact(card, 'Affects'), 'swarm/ARCHITECTURE.md');
    assert.equal(fact(card, 'Depends on'), 'T-0006, T-0003');
    assert.match(fact(card, 'Time'), /worked 1 h 28 min/);
    assert.deepEqual(card.tokens, { used: 0, budget: 500000 });
    assert.match(card.summary, /Part of E-0003 Departments panel/);
    assert.match(card.summary, /Cancelled: monitor: minutes budget spent/);
    assert.match(card.summary, /No pull request/);
    assert.equal(card.sections.find((s) => s.title === 'Acceptance').items.length, 2);
    assert.equal(card.sections.find((s) => s.title === 'Timeline').items.length, 5);
    const long = nodeCard(node('task:T-0007'), { ...ctx, history: [{ to: 'failed', at: HISTORY[0].at, reason: 'x'.repeat(500) }] });
    assert.ok(long.sections.find((s) => s.title === 'Timeline').items[0].text.length < 170, 'long reasons are clipped');
  });

  it('merged task card links the pull request and says so', () => {
    const card = nodeCard(node('task:T-0006'), ctx);
    assert.equal(card.tags[0].tone, 'good');
    assert.match(card.summary, /Merged in PR #250/);
    assert.deepEqual(card.links.map((l) => l.href), ['/#tasks', 'https://github.com/org/repo/pull/250']);
  });

  it('epic card: goal paragraph, progress, affected paths and summed tokens', () => {
    const card = nodeCard(node('epic:E-0003'), ctx);
    assert.equal(card.summary, 'Goal. The dashboard shows how the swarm is set up. Second line.');
    assert.equal(fact(card, 'Progress'), '1 merged · 1 cancelled of 2 tasks');
    assert.equal(fact(card, 'Affects'), 'swarm/ARCHITECTURE.md, swarm/dashboard/**');
    assert.equal(fact(card, 'Who'), 'owner-laptop');
    assert.deepEqual(card.tokens, { used: 120000, budget: 900000 });
    assert.ok(card.tags.some((t) => t.text === 'issue #186'));
    assert.deepEqual(card.progress, [{ status: 'merged', count: 1 }, { status: 'cancelled', count: 1 }]);
    const many = { ...snapshot, tasks: [{ ...merged, paths: Array.from({ length: 11 }, (_, i) => `p${i}`) }] };
    assert.match(fact(nodeCard(node('epic:E-0003'), { ...ctx, snapshot: many }), 'Affects'), /p7, \+3 more$/);
  });

  it('manager card counts held work; department card shows its setup', () => {
    const m = nodeCard(node('manager:owner-laptop'), ctx);
    assert.match(m.summary, /Holds 2 tasks: 1 merged, 1 cancelled/);
    assert.equal(fact(m, 'Departments'), 'docs, dashboard');
    assert.deepEqual(m.tokens, { used: 120000, budget: 900000 });
    const d = nodeCard(node('department:docs'), ctx);
    assert.equal(fact(d, 'Agent'), 'claude');
    assert.equal(fact(d, 'Owns paths'), '**/*.md');
    assert.equal(fact(d, 'Managers'), 'owner-laptop (idle)');
    assert.match(d.summary, /1 task: 1 cancelled/);
  });

  it('agent, channel and memory cards say what happened there', () => {
    const a = nodeCard(node('agent:owner-laptop'), ctx);
    assert.equal(a.tags[0].text, 'online');
    assert.match(a.summary, /Wrote 2 messages in #swarm/);
    assert.match(a.summary, /1 memory key/);
    assert.match(a.summary, /Also manager: holds 2 tasks/);
    assert.equal(a.sections[0].items.length, 2);
    const c = nodeCard(node('channel:swarm'), ctx);
    assert.match(c.summary, /swarm events/);
    assert.equal(fact(c, 'Top posters'), 'owner-laptop ×2');
    const mem = nodeCard(node('memory:locks/swarm/ARCHITECTURE.md'), ctx);
    assert.equal(fact(mem, 'Written by'), 'owner-laptop');
    assert.equal(fact(mem, 'Value'), 'owner-laptop');
  });

  it('renderCard lays the card out in a main and a side column, with a close button', () => {
    const html = renderCard(nodeCard(node('task:T-0007'), { ...ctx, history: HISTORY }), { side: '<p id="extra">links</p>' });
    const main = html.indexOf('class="g-card-main"');
    const side = html.indexOf('class="g-card-side"');
    assert.ok(main >= 0 && side > main, 'main column, then side column');
    assert.ok(html.indexOf('g-summary') < side, 'summary stays in the main column');
    assert.ok(html.indexOf('Acceptance') > side, 'sections go to the side column');
    assert.ok(html.indexOf('id="extra"') > side, 'extra side html is appended');
    assert.match(html, /<button[^>]*data-close/);
    assert.ok(!html.includes('✕'), 'close icon is an svg, not a glyph');
    assert.match(html, /role="meter"[^>]*aria-valuenow="0"/);
    assert.match(html, /<li class="g-item"><span class="g-item-meta">[^<]+<\/span><span class="st g-tone-bad">Cancelled<\/span>/, 'timeline items: time, status pill, reason');
    assert.equal(renderCard(null), '<p class="mut">No node selected.</p>');
  });

  it('renderCard escapes every value', () => {
    const html = renderCard({
      title: '<b>x</b>', kind: 'task', tags: [{ text: '<i>', tone: 'bad' }], summary: '"s"&',
      facts: [['<k>', '<v>']], tokens: { used: 5, budget: 10 }, progress: [{ status: 'merged', count: 1 }],
      sections: [{ title: '<t>', items: ['<li>'] }], links: [{ href: 'javascript:alert(1)', text: 'x' }],
    });
    assert.ok(!/<b>|<i>|<k>|<v>|<t>/.test(html));
    assert.match(html, /<li class="g-bullet">&lt;li&gt;<\/li>/);
    assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
    assert.ok(!html.includes('javascript:'), 'only http(s) and same-site links');
    assert.match(html, /<span class="g-num">5<\/span> <span class="mut">of 10 · 50%<\/span>/);
  });
});
