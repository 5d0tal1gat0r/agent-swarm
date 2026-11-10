import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { parseDepartments, parsePolicy } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { PlanError, buildPlan, buildPlanPrompt, commitPlan, mergeContractTasks, parsePlanReply, planEpic } from '../src/planner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');
const departments = parseDepartments(parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8')));
const policy = parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));
const epic = { id: 'E-0001', repo: 'example-org/agent-coordination', title: 'Queue inspection', body: 'Show the queue.' };

const item = (key, paths, extra = {}) => ({
  key, title: `Task ${key}`, paths, acceptance: [`${key} works`], size: 'S', priority: 'p1', dependsOn: [], ...extra,
});
const reply = (tasks) => JSON.stringify({ tasks });
const fakeModel = (text) => {
  const calls = [];
  const fn = async (args) => { calls.push(args); return text; };
  fn.calls = calls;
  return fn;
};

describe('plan reply', () => {
  it('accepts bare JSON and a fenced one', () => {
    assert.equal(parsePlanReply(reply([item('a', ['docs/x.md'])])).length, 1);
    assert.equal(parsePlanReply('```json\n' + reply([item('a', ['docs/x.md'])]) + '\n```').length, 1);
  });

  it('rejects prose, invalid JSON, and schema violations', () => {
    assert.throws(() => parsePlanReply('Here is the plan!'), PlanError);
    assert.throws(() => parsePlanReply(reply([{ ...item('a', ['docs/x.md']), size: 'XL' }])), /does not match schema/);
    assert.throws(() => parsePlanReply(reply([{ ...item('A', ['docs/x.md']) }])), /does not match schema/, 'keys are lower-case');
    assert.throws(() => parsePlanReply(JSON.stringify({ tasks: [], extra: 1 })), /does not match schema/);
  });
});

describe('split and routing', () => {
  it('contract and work paths of one department stay one task (kind contract, contract paths first)', () => {
    const plan = buildPlan({
      items: [item('api', ['swarm/orchestrator/src/q.mjs', 'swarm/protocol/api/q.schema.json'])],
      departments, policy,
    });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].kind, 'contract');
    assert.deepEqual(plan[0].paths, ['swarm/protocol/api/q.schema.json', 'swarm/orchestrator/src/q.mjs']);
  });

  it('a contract path and work in another department still split: contract first, work depends on it', () => {
    const plan = buildPlan({
      items: [item('api', ['swarm/protocol/api/q.schema.json', 'swarm/manager/src/q.mjs'])],
      departments, policy,
    });
    assert.equal(plan.length, 2);
    const [contract, work] = plan;
    assert.equal(contract.kind, 'contract');
    assert.equal(work.kind, 'work');
    assert.deepEqual(work.dependsOn, [contract.key]);
  });

  it('a contract-only task merges into the same-department task that depends on it (the E-0003 shape)', () => {
    const items = [
      item('schema', ['swarm/protocol/api/snapshot.response.schema.json', 'swarm/protocol/validate.mjs'], { acceptance: ['schema exists'] }),
      item('route', ['swarm/orchestrator/src/api.mjs'], { dependsOn: ['schema'], acceptance: ['route sends it'], priority: 'p2' }),
      item('render', ['swarm/dashboard/src/static/render.mjs'], { dependsOn: ['schema'] }),
      item('page', ['swarm/dashboard/src/static/app.js'], { dependsOn: ['route', 'render'] }),
    ];
    const merged = mergeContractTasks(items, departments);
    assert.deepEqual(merged.map((i) => i.key), ['route', 'render', 'page']);
    const route = merged[0];
    assert.deepEqual(route.paths, ['swarm/protocol/api/snapshot.response.schema.json', 'swarm/protocol/validate.mjs', 'swarm/orchestrator/src/api.mjs']);
    assert.deepEqual(route.acceptance, ['schema exists', 'route sends it']);
    assert.deepEqual([route.size, route.priority, route.dependsOn], ['M', 'p1', []]);
    assert.deepEqual(merged[1].dependsOn, ['route'], 'other dependents now wait for the merged task');
    const plan = buildPlan({ items, departments, policy });
    assert.equal(plan[0].key, 'route');
    assert.equal(plan[0].kind, 'contract');
    assert.equal(plan.length, 3);
  });

  it('contract tasks stay separate when nothing in their department depends on them, or both tasks are M', () => {
    const lone = [item('schema', ['swarm/protocol/api/x.schema.json']), item('mgr', ['swarm/manager/src/x.mjs'], { dependsOn: ['schema'] })];
    assert.equal(mergeContractTasks(lone, departments).length, 2, 'the dependent is in another department');
    const big = [item('schema', ['swarm/protocol/api/x.schema.json'], { size: 'M' }), item('route', ['swarm/orchestrator/src/x.mjs'], { size: 'M', dependsOn: ['schema'] })];
    assert.equal(mergeContractTasks(big, departments).length, 2, 'M + M would be L');
  });

  it('paths across departments without contracts become independent subtasks', () => {
    const plan = buildPlan({
      items: [item('mix', ['swarm/manager/src/a.mjs', 'docs/a.md'])],
      departments, policy,
    });
    assert.deepEqual(plan.map((s) => s.department).sort(), ['docs', 'runtime']);
    assert.ok(plan.every((s) => s.dependsOn.length === 0));
  });

  it('a path nobody owns is rejected', () => {
    assert.throws(() => buildPlan({ items: [item('x', ['nothing/here.txt'])], departments, policy }), /path outside any department: nothing\/here\.txt/);
  });

  it('a size over the policy limit is rejected', () => {
    assert.throws(() => buildPlan({ items: [item('big', ['docs/a.md'], { size: 'L' })], departments, policy }), /size L is over the limit M/);
  });
});

describe('ordering checks', () => {
  it('rejects a dependency on an unknown key and on itself', () => {
    assert.throws(() => buildPlan({ items: [item('a', ['docs/a.md'], { dependsOn: ['ghost'] })], departments, policy }), /unknown task ghost/);
    assert.throws(() => buildPlan({ items: [item('a', ['docs/a.md'], { dependsOn: ['a'] })], departments, policy }), /depends on itself/);
  });

  it('rejects a cycle', () => {
    const items = [item('a', ['docs/a.md'], { dependsOn: ['b'] }), item('b', ['docs/b.md'], { dependsOn: ['a'] })];
    assert.throws(() => buildPlan({ items, departments, policy }), /dependency cycle/);
  });

  it('rejects two tasks on the same path with no order between them', () => {
    const items = [item('a', ['docs/shared.md']), item('b', ['docs/shared.md'])];
    assert.throws(() => buildPlan({ items, departments, policy }), /touch the same paths with no order/);
  });

  it('accepts the same path when the tasks are ordered', () => {
    const items = [item('a', ['docs/shared.md']), item('b', ['docs/shared.md'], { dependsOn: ['a'] })];
    const plan = buildPlan({ items, departments, policy });
    assert.deepEqual(plan.map((s) => s.key), ['a', 'b']);
  });

  it('puts contract subtasks before work subtasks across the whole plan', () => {
    const items = [
      item('ui', ['swarm/manager/src/a.mjs']),
      item('contract', ['swarm/protocol/api/q.schema.json']),
    ];
    const plan = buildPlan({ items, departments, policy });
    assert.equal(plan[0].kind, 'contract');
    assert.deepEqual(plan.find((s) => s.parent === 'ui').dependsOn, ['contract']);
  });
});

describe('planEpic and commit', () => {
  it('calls the plan model on the planModel with the epic fenced as data, and returns the checked plan', async () => {
    const callModel = fakeModel(reply([item('a', ['docs/a.md'])]));
    const out = await planEpic({ epic, departments, policy, callModel, promptText: 'PLAN' });
    assert.equal(out.model, policy.planModel);
    assert.equal(callModel.calls[0].model, policy.planModel);
    const prompt = callModel.calls[0].prompt;
    assert.match(prompt, /^PLAN/);
    assert.match(prompt, /<<<BEGIN EPIC[\s\S]*Show the queue\.[\s\S]*END EPIC>>>/);
    assert.match(prompt, /"department":"core"/, 'ownership map is in the prompt');
    assert.equal(out.plan.length, 1);
  });

  it('a plan model off the allow-list is refused before any call', async () => {
    const callModel = fakeModel('');
    await assert.rejects(planEpic({ epic, departments, policy: { ...policy, planModel: 'claude-fake-1' }, callModel, promptText: 'P' }), /not on the allow-list/);
    assert.equal(callModel.calls.length, 0);
  });

  it('commit writes tasks with ids, dependencies by id, budget from policy, and blocked status until deps merge', () => {
    const store = openStore({ clock: { now: () => Date.now() }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: epic.repo, title: epic.title, body: epic.body });
    const plan = buildPlan({
      items: [item('api', ['swarm/protocol/api/q.schema.json', 'swarm/manager/src/q.mjs'])],
      departments, policy,
    });
    const tasks = commitPlan({ store, epic: store.getEpic('E-0001'), plan, policy });
    assert.deepEqual(tasks.map((t) => t.id), ['T-0001', 'T-0002']);
    assert.equal(tasks[0].status, 'queued');
    assert.equal(tasks[1].status, 'blocked');
    assert.deepEqual(tasks[1].dependsOn, ['T-0001']);
    assert.deepEqual(tasks[0].budget, policy.budgets.S);
    assert.equal(tasks[0].epicId, 'E-0001');
    store.close();
  });

  it('refuses to plan an epic that already has tasks', () => {
    const store = openStore({ clock: { now: () => Date.now() }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: epic.repo, title: epic.title, body: epic.body });
    const plan = buildPlan({ items: [item('a', ['docs/a.md'])], departments, policy });
    commitPlan({ store, epic: store.getEpic('E-0001'), plan, policy });
    assert.throws(() => commitPlan({ store, epic: store.getEpic('E-0001'), plan, policy }), /already has tasks/);
    store.close();
  });

  it('the prompt builder fences the epic and lists contracts', () => {
    const p = buildPlanPrompt({ promptText: 'P', epic, departments, policy });
    assert.match(p, /"contracts":\["swarm\/protocol\/\*\*"\]/);
  });
});
