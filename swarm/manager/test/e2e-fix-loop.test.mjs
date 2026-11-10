// M4 end to end, no model and no container: an in-process orchestrator over
// HTTP, the review loop, a manager daemon, real git (bare origin + clone). The
// fake GitHub reads the bare origin for PR head, files, diff and behind count.
// Scenario: out-of-scope file -> changes_requested -> same manager fixes via
// force-with-lease -> re-review passes -> auto-merge armed on the new head -> merged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import { parseDepartments, parsePolicy } from '../../orchestrator/src/config.mjs';
import { openStore } from '../../orchestrator/src/store.mjs';
import { addManager } from '../../orchestrator/src/tokens.mjs';
import { createServer, listen } from '../../orchestrator/src/api.mjs';
import { createReviewLoop } from '../../orchestrator/src/review-loop.mjs';
import { OrchestratorClient } from '../src/client.mjs';
import { createDaemon } from '../src/daemon.mjs';
import { commandChecks } from '../src/agents.mjs';
import { runTask } from '../src/task-runner.mjs';
import { branchName, git, removeWorktree } from '../src/worktree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');
const ID = { name: 'swarm-me-core', email: 'swarm-me-core@users.noreply.github.com' };
const NODE_OK = ['node', '-e', 'process.exit(0)'];
const BRANCH = branchName('core', 'T-0001', 'Thing');
const APPROVE = JSON.stringify({ verdict: 'approve', summary: 'in scope now', findings: [] });

describe('M4 fix loop end to end', () => {
  let server, store, client, daemon, root, origin, repo, stateDir, loop, ghState, modelCalls, agentSeen, prHead;

  // Fake GitHub backed by the bare origin: PR head is the branch tip there.
  const gh = {
    async pr(n) {
      const head = await git(root, ['--git-dir', origin, 'rev-parse', `refs/heads/${BRANCH}`]);
      return { number: n, baseRefName: 'main', headSha: head, state: ghState.merged ? 'MERGED' : 'OPEN', mergeCommit: ghState.merged ? 'f'.repeat(40) : null, autoMergeEnabled: ghState.armed, additions: 5, deletions: 0 };
    },
    async fileChanges() {
      const out = await git(root, ['--git-dir', origin, 'diff', '--name-only', `main...${BRANCH}`]);
      return out.split('\n').filter(Boolean).map((filename) => ({ filename, status: 'modified' }));
    },
    async checks(sha) { return [{ name: 'check', headSha: sha, conclusion: 'success' }]; },
    async behindBy(sha) { return Number(await git(root, ['--git-dir', origin, 'rev-list', '--count', `${sha}..main`])); },
    async diff() { return git(root, ['--git-dir', origin, 'diff', `main...${BRANCH}`]); },
    async enableAutoMerge(n, sha) { ghState.armed = true; ghState.armedSha = sha; },
  };

  const deps = () => {
    const d = parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8'));
    d.departments.core.host = 'me';
    d.departments.core.standby = null;
    return parseDepartments(d);
  };
  const policy = () => parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8')));

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-fixloop-'));
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    stateDir = path.join(root, 'state');
    const tokensFile = path.join(root, 'managers.json');
    await git(root, ['init', '--quiet', '--bare', origin]);
    await git(root, ['clone', '--quiet', origin, repo]);
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--quiet', '-m', 'init'], { identity: ID });
    await git(repo, ['push', '--quiet', 'origin', 'HEAD:main']);

    const token = addManager(tokensFile, { name: 'me-core', member: 'me', departments: ['core'] });
    store = openStore({ clock: { now: () => Date.now() }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    store.createTask({
      id: 'T-0001', epicId: 'E-0001', repo: 'o/r', title: 'Thing', department: 'core', priority: 'p1', size: 'S',
      paths: ['swarm/orchestrator/src/t1.mjs'], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 },
    });
    const made = createServer({ store, departments: deps(), policy: policy(), tokensFile, log: { error() {} } });
    server = made.server;
    const addr = await listen(server, { host: '127.0.0.1', port: 0 });
    client = new OrchestratorClient({ url: `http://127.0.0.1:${addr.port}`, token });
    daemon = createDaemon({ client, manager: 'me-core', agentKind: 'claude', department: 'core', slotDir: path.join(root, 'slots'), runTask: null });
    loop = createReviewLoop({
      store, gh, callModel: async () => { modelCalls += 1; return APPROVE; }, policy: policy(), departments: deps(), promptText: 'REVIEW', log: { error() {}, info() {} },
    });
    ghState = { merged: false, armed: false, armedSha: null };
    modelCalls = 0;
    agentSeen = [];
    prHead = null;
  });

  after(() => {
    server.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  // First attempt: correct file plus an out-of-scope file. Fix attempt: deletes the out-of-scope file.
  const agent = async ({ task, worktree, findings }) => {
    agentSeen.push(findings);
    fs.mkdirSync(path.join(worktree, 'swarm/orchestrator/src'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'swarm/orchestrator/src/t1.mjs'), 'export const t1 = 1;\n');
    if (findings.length === 0) {
      fs.mkdirSync(path.join(worktree, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(worktree, 'docs/oops.md'), 'out of scope\n');
    } else {
      fs.rmSync(path.join(worktree, 'docs'), { recursive: true, force: true });
    }
    return { tokens: 1000, evidence: task.acceptance.map((criterion) => ({ criterion, met: true, detail: 'e2e' })) };
  };
  const runOnce = () => {
    daemon.runTask = (t) => runTask({
      task: t, client, manager: 'me-core', identity: ID, stateDir, repoDir: repo, agent,
      checks: commandChecks(NODE_OK), openPr: async () => 9, log: { warn() {} },
    });
    return daemon.runOnce();
  };

  it('first submit reaches the review loop, which sends it back for the out-of-scope file', async () => {
    const r = await runOnce();
    assert.equal(r.result.status, 'submitted');
    assert.equal(store.getTask('T-0001').status, 'submitted');
    await loop.tick();
    const t = store.getTask('T-0001');
    assert.equal(t.status, 'changes_requested');
    assert.equal(t.review.rounds, 1, 'a gate failure is a changes_requested round, counted toward maxReviewRounds');
    assert.match(t.review.findings[0], /^#1 blocker docs\/oops\.md: file outside task paths/);
    assert.equal(modelCalls, 0);
    assert.equal(ghState.armed, false);
  });

  it('the same manager gets the fix back first, in progress, with the findings in hand', async () => {
    const r = await runOnce();
    assert.equal(r.leased, 'T-0001');
    assert.equal(r.result.status, 'submitted');
    assert.equal(r.result.fix, true);
    assert.equal(r.result.pr, 9, 'same PR, no new one');
    assert.equal(agentSeen.at(-1).length, 1, 'fix agent received the review findings');
    assert.match(agentSeen.at(-1)[0], /docs\/oops\.md/);
    const files = await git(root, ['--git-dir', origin, 'ls-tree', '-r', '--name-only', BRANCH]);
    assert.doesNotMatch(files, /docs\/oops\.md/);
    const commits = await git(root, ['--git-dir', origin, 'rev-list', '--count', BRANCH]);
    assert.equal(commits, '3', 'init, first attempt, fix on top: history kept');
    prHead = r.result.headSha;
    assert.equal(store.getTask('T-0001').status, 'submitted');
  });

  it('re-review passes on the new head, arms auto-merge pinned to it, and merge marks the task merged', async () => {
    await loop.tick();
    assert.equal(store.getTask('T-0001').status, 'in_review');
    assert.equal(ghState.armed, true);
    assert.equal(ghState.armedSha, prHead, 'auto-merge pinned to the fixed head');
    assert.equal(modelCalls, 1);

    ghState.merged = true;
    await loop.tick();
    assert.equal(store.getTask('T-0001').status, 'merged');
  });

  it('the fix round is counted, and merged work is cleaned up', async () => {
    const t = store.getTask('T-0001');
    assert.equal(t.review.headSha, prHead);
    assert.equal(t.review.rounds, 1);
    await removeWorktree(repo, path.join(stateDir, 'wt', t.id), BRANCH);
    assert.equal(fs.existsSync(path.join(stateDir, 'wt', 'T-0001')), false);
  });
});
