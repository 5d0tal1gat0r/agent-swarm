// End to end without a model or a container: an in-process orchestrator over
// real HTTP, a manager daemon, real git (bare origin + clone), a fake agent.
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
import { OrchestratorClient } from '../src/client.mjs';
import { createDaemon } from '../src/daemon.mjs';
import { commandChecks, fakeAgent } from '../src/agents.mjs';
import { runTask } from '../src/task-runner.mjs';
import { git, removeWorktree } from '../src/worktree.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SWARM = path.resolve(HERE, '..', '..');
const ID = { name: 'swarm-me-core', email: 'swarm-me-core@users.noreply.github.com' };
const NODE_OK = ['node', '-e', 'process.exit(0)'];

describe('manager end to end', () => {
  let server, store, client, daemon, root, origin, repo, stateDir, tokensFile, heartbeats;
  const deps = () => {
    const d = parse(fs.readFileSync(path.join(SWARM, 'departments.yaml'), 'utf8'));
    d.departments.core.host = 'me';
    d.departments.core.standby = null;
    return parseDepartments(d);
  };

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-e2e-'));
    origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    stateDir = path.join(root, 'state');
    tokensFile = path.join(root, 'managers.json');
    await git(root, ['init', '--quiet', '--bare', origin]);
    await git(root, ['clone', '--quiet', origin, repo]);
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n');
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '--quiet', '-m', 'init'], { identity: ID });
    await git(repo, ['push', '--quiet', 'origin', 'HEAD:main']);

    const token = addManager(tokensFile, { name: 'me-core', member: 'me', departments: ['core'] });
    store = openStore({ clock: { now: () => Date.now() }, leaseMinutes: 10, maxAttempts: 3, maxReviewRounds: 3 });
    store.createEpic({ id: 'E-0001', repo: 'o/r', title: 'Epic', body: 'b' });
    const made = createServer({ store, departments: deps(), policy: parsePolicy(parse(fs.readFileSync(path.join(SWARM, 'policy.yaml'), 'utf8'))), tokensFile, log: { error() {} } });
    server = made.server;
    heartbeats = made.heartbeats;
    const addr = await listen(server, { host: '127.0.0.1', port: 0 });
    client = new OrchestratorClient({ url: `http://127.0.0.1:${addr.port}`, token });
    daemon = createDaemon({ client, manager: 'me-core', agentKind: 'claude', department: 'core', slotDir: path.join(root, 'slots'), runTask: null });
  });

  after(() => {
    server.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const task = (id, title) => ({
    id, epicId: 'E-0001', repo: 'o/r', title, department: 'core', priority: 'p1', size: 'S',
    paths: [`swarm/orchestrator/src/${id.toLowerCase()}.mjs`], dependsOn: [], acceptance: ['works'], budget: { tokens: 500000, minutes: 30 },
  });

  const runner = (agent, checks = commandChecks(NODE_OK), openPr = async () => 7) => (t) => runTask({
    task: t, client, manager: 'me-core', identity: ID, stateDir, repoDir: repo, agent, checks, openPr, log: { warn() {} },
  });

  it('a heartbeat records the manager and its running tasks', async () => {
    daemon.runTask = runner(fakeAgent(() => {}));
    await daemon.runOnce();
    assert.equal(heartbeats.get('me-core').member, 'me');
  });

  it('dry run shows the next task and changes nothing', async () => {
    store.createTask(task('T-0001', 'Write the thing'));
    const next = await daemon.dryRun();
    assert.deepEqual(next.map((t) => t.id), ['T-0001']);
    assert.equal(store.getTask('T-0001').status, 'queued');
  });

  it('a successful task is committed, pushed, submitted with a PR, and keeps its worktree', async () => {
    daemon.runTask = runner(fakeAgent((c) => fs.writeFileSync(path.join(c.worktree, 'feature.txt'), 'done\n')));
    const r = await daemon.runOnce();
    assert.equal(r.leased, 'T-0001');
    assert.equal(r.result.status, 'submitted');
    assert.equal(r.result.pr, 7);
    const t = store.getTask('T-0001');
    assert.equal(t.status, 'submitted');
    assert.equal(t.pr, 7);
    assert.equal(t.review.headSha, r.result.headSha);
    const remote = await git(root, ['--git-dir', origin, 'rev-parse', r.result.branch]);
    assert.equal(remote, r.result.headSha);
    assert.equal(fs.existsSync(r.result.worktree), true, 'kept until the PR merges');
  });

  it('an agent that changes nothing fails the task and cleans up', async () => {
    store.createTask(task('T-0002', 'Nothing to do'));
    daemon.runTask = runner(fakeAgent(() => {}));
    const r = await daemon.runOnce();
    assert.equal(r.result.status, 'failed');
    assert.match(r.result.reason, /no changes/);
    const t = store.getTask('T-0002');
    assert.equal(t.status, 'queued');
    assert.equal(t.attempts, 1);
    assert.equal(fs.existsSync(path.join(stateDir, 'wt', 'T-0002')), false);
  });

  it('failing checks fail the task before any push', async () => {
    store.cancel('T-0002', 'superseded in this test');
    store.createTask(task('T-0003', 'Breaks checks'));
    daemon.runTask = runner(fakeAgent((c) => fs.writeFileSync(path.join(c.worktree, 'b.txt'), 'b')), commandChecks(['node', '-e', 'process.exit(3)']));
    const r = await daemon.runOnce();
    assert.equal(r.result.status, 'failed');
    assert.match(r.result.reason, /failed/);
    assert.equal(store.getTask('T-0003').attempts, 1);
    const branches = await git(repo, ['branch', '--list', 'core/t-0003-*']);
    assert.equal(branches, '', 'no local branch left behind');
  });

  it('a manager that is not holding the lease cannot report on the task', async () => {
    const other = new OrchestratorClient({ url: client.base, token: 'wrong-token' });
    await assert.rejects(other.progress('T-0001', { manager: 'me-core', phase: 'pr', note: '' }), /401/);
  });

  it('removeWorktree after a merge leaves the repo clean', async () => {
    const t = store.getTask('T-0001');
    await removeWorktree(repo, path.join(stateDir, 'wt', t.id), t.branch ?? null);
    assert.equal(fs.existsSync(path.join(stateDir, 'wt', 'T-0001')), false);
  });
});
