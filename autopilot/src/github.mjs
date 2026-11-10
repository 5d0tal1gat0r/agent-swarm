// GitHub adapter. Everything goes through the `gh` CLI, authenticated as the
// worker's member. `exec` is injectable so tests run without the network.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Default exec: runs `gh <args>` and returns stdout. */
export async function ghExec(args, { input } = {}) {
  if (input !== undefined) {
    return new Promise((resolve, reject) => {
      const child = execFile('gh', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stderr })) : resolve(stdout),
      );
      child.stdin.end(input);
    });
  }
  const { stdout } = await run('gh', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

const lc = (s) => String(s).toLowerCase();

export function checksState(rollup = []) {
  if (rollup.length === 0) return 'none';
  const outcome = (c) => (c.__typename === 'StatusContext' ? c.state : c.status === 'COMPLETED' ? c.conclusion : 'PENDING');
  const states = rollup.map(outcome);
  if (states.some((s) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s))) {
    return 'failure';
  }
  if (states.some((s) => !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s))) return 'pending';
  return 'success';
}

export function mapPr(p) {
  return {
    number: p.number,
    title: p.title,
    author: p.author.login,
    headSha: p.headRefOid,
    headRef: p.headRefName,
    baseRef: p.baseRefName,
    headCommittedAt: p.commits?.at(-1)?.committedDate ?? p.updatedAt,
    requested: (p.reviewRequests ?? []).map((r) => r.login).filter(Boolean),
    autoMerge: Boolean(p.autoMergeRequest),
    draft: p.isDraft,
    labels: p.labels.map((l) => l.name),
    linkedIssue: p.closingIssuesReferences?.[0]?.number ?? null,
    checks: checksState(p.statusCheckRollup),
    mergeable: p.mergeable !== 'CONFLICTING',
    updatedAt: p.updatedAt,
    reviews: p.reviews.map((r) => ({
      author: r.author?.login ?? '',
      state: r.state,
      commitId: r.commit?.oid ?? '',
      submittedAt: r.submittedAt ?? '',
    })),
  };
}

export function mapIssue(i) {
  return {
    number: i.number,
    title: i.title,
    author: i.author.login,
    labels: i.labels.map((l) => l.name),
    assignees: i.assignees.map((a) => a.login),
    createdAt: i.createdAt,
  };
}

export class GitHub {
  constructor(repo, exec = ghExec) {
    this.repo = repo;
    this.exec = exec;
  }

  async json(args) {
    return JSON.parse(await this.exec(args));
  }

  /** A JSON file from the default branch (members and policy are only trusted from main). */
  async mainJson(file) {
    const meta = await this.json(['api', `repos/${this.repo}/contents/${file}`]);
    return JSON.parse(Buffer.from(meta.content, 'base64').toString('utf8'));
  }

  members() {
    return this.mainJson('autopilot/members.json');
  }

  async policy() {
    try {
      return await this.mainJson('autopilot/policy.json');
    } catch {
      return {};
    }
  }

  /** Whether main has a protection rule (then GitHub enforces approvals and auto-merges). */
  async protectedMain() {
    return (await this.exec(['api', `repos/${this.repo}/branches/main`, '--jq', '.protected'])).trim() === 'true';
  }

  async snapshot() {
    const members = await this.members();
    const policy = await this.policy();
    const protectedMain = await this.protectedMain();
    const memberSet = new Set(members.map(lc));
    const pauses = await this.json(['issue', 'list', '-R', this.repo, '--state', 'open', '--label', 'autopilot-pause', '--json', 'author']);
    const issues = await this.json([
      'issue', 'list', '-R', this.repo, '--state', 'open', '--label', 'task', '--limit', '100',
      '--json', 'number,title,author,labels,assignees,createdAt',
    ]);
    const prs = await this.json([
      'pr', 'list', '-R', this.repo, '--state', 'open', '--limit', '30',
      '--json', 'number,title,author,headRefOid,headRefName,baseRefName,isDraft,labels,closingIssuesReferences,statusCheckRollup,mergeable,updatedAt,reviews,reviewRequests,autoMergeRequest,commits',
    ]);
    return {
      members,
      policy,
      protectedMain,
      paused: pauses.some((p) => memberSet.has(lc(p.author.login))),
      issues: issues.map(mapIssue),
      prs: prs.map(mapPr),
    };
  }

  async issue(n) {
    return this.json(['issue', 'view', String(n), '-R', this.repo, '--json', 'number,title,body,labels,assignees,author,url']);
  }

  async releaseIssue(n, me, reason) {
    await this.exec(['issue', 'edit', String(n), '-R', this.repo, '--remove-assignee', me]);
    if (reason) await this.comment('issue', n, reason);
  }

  async comment(kind, n, body) {
    await this.exec([kind, 'comment', String(n), '-R', this.repo, '--body-file', '-'], { input: body });
  }

  /** Squash-merges only if the head is still `sha` (no push slipped in after the approvals). */
  async mergePr(n, sha) {
    await this.exec(['pr', 'merge', String(n), '-R', this.repo, '--squash', '--delete-branch', '--match-head-commit', sha]);
  }

  async requestReviewers(n, logins) {
    if (logins.length) await this.exec(['pr', 'edit', String(n), '-R', this.repo, '--add-reviewer', logins.join(',')]);
  }

  /** GitHub merges by itself once the protection rule is satisfied. */
  async enableAutoMerge(n) {
    await this.exec(['pr', 'merge', String(n), '-R', this.repo, '--auto', '--squash', '--delete-branch']);
  }

  async addLabel(kind, n, label) {
    await this.exec([kind, 'edit', String(n), '-R', this.repo, '--add-label', label]);
  }

  async ensureLabels() {
    const labels = [
      ['task', '0e8a16', 'Work for the autopilot workers'],
      ['p1', 'b60205', 'Do first'],
      ['security', 'ee0701', 'Security fix: reviewed before other PRs'],
      ['blocked', '5319e7', 'Workers skip this task'],
      ['needs-human', 'd93f0b', 'Workers stopped; a person must decide'],
      ['autopilot-pause', '000000', 'Open issue with this label pauses all workers'],
    ];
    for (const [name, color, description] of labels) {
      await this.exec(['label', 'create', name, '-R', this.repo, '--color', color, '--description', description, '--force']);
    }
  }
}
