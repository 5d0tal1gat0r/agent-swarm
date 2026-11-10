// GitHub access for the orchestrator, through the gh CLI. Arguments are arrays
// (no shell). Auth comes from the orchestrator's environment (a fine-grained
// token scoped to this repo). The token never reaches a container.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LABEL_RE = /^[A-Za-z0-9 _.-]{1,50}$/;
const SHA_RE = /^[a-f0-9]{40}$/;

export async function defaultExec(args) {
  const { stdout } = await run('gh', args, { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } });
  return stdout;
}

export class GitHub {
  constructor({ repo, base = 'main', exec = defaultExec }) {
    if (!REPO_RE.test(repo)) throw new Error(`bad repo name: ${repo}`);
    this.repo = repo;
    this.base = base;
    this.exec = exec;
    this.api = `repos/${repo}`;
  }

  /** Normalised PR snapshot. state is OPEN, CLOSED or MERGED. */
  async pr(number) {
    const data = JSON.parse(await this.exec([
      'pr', 'view', String(number), '--repo', this.repo,
      '--json', 'number,title,baseRefName,headRefOid,state,mergeCommit,autoMergeRequest,additions,deletions',
    ]));
    return {
      number: data.number,
      title: data.title,
      baseRefName: data.baseRefName,
      headSha: data.headRefOid,
      state: data.state,
      mergeCommit: data.mergeCommit?.oid ?? null,
      autoMergeEnabled: data.autoMergeRequest != null,
      additions: data.additions,
      deletions: data.deletions,
    };
  }

  /** PR numbers that contain a commit (for mapping main's head back to its PR). */
  async pullsForCommit(sha) {
    assertSha(sha);
    const out = await this.exec(['api', `${this.api}/commits/${sha}/pulls`, '--jq', '.[].number']);
    return out.split('\n').filter(Boolean).map(Number);
  }

  async files(number) {
    const out = await this.exec(['api', '--paginate', `${this.api}/pulls/${number}/files`, '--jq', '.[].filename']);
    return out.split('\n').filter(Boolean);
  }

  /** Changed files with status and patch (patch is absent for binary or very large files). */
  async fileChanges(number) {
    const out = await this.exec(['api', '--paginate', `${this.api}/pulls/${number}/files`, '--jq', '.[] | {filename, status, patch, previous_filename} | tostring']);
    return out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  /**
   * Workflow jobs on one commit, as [{ name, conclusion }] (conclusion '' while running). Read through
   * the Actions API, not check-runs: fine-grained tokens have no Checks permission (ARCHITECTURE 59).
   * The jobs of a workflow are its check runs, so the `check` job is the required `check`.
   */
  async #jobs(sha) {
    const ids = (await this.exec(['api', '--paginate', `${this.api}/actions/runs?head_sha=${sha}&per_page=100`, '--jq', '.workflow_runs[].id'])).split('\n').filter(Boolean);
    const jobs = [];
    for (const id of ids) {
      if (!/^\d+$/.test(id)) throw new Error(`bad workflow run id: ${id}`);
      const out = await this.exec(['api', '--paginate', `${this.api}/actions/runs/${id}/jobs?per_page=100`, '--jq', '.jobs[] | [.name, .conclusion // ""] | @tsv']);
      for (const line of out.split('\n').filter(Boolean)) {
        const [name, conclusion = ''] = line.split('\t');
        jobs.push({ name, conclusion });
      }
    }
    return jobs;
  }

  /** Check runs (workflow jobs) on one commit, as [{ name, headSha, conclusion }]. In progress reads as "pending". */
  async checks(sha) {
    assertSha(sha);
    return (await this.#jobs(sha)).map(({ name, conclusion }) => ({ name, headSha: sha, conclusion: conclusion || 'pending' }));
  }

  /** Commits on the base branch that the head does not have. */
  async behindBy(headSha) {
    assertSha(headSha);
    const out = await this.exec(['api', `${this.api}/compare/${this.base}...${headSha}`, '--jq', '.behind_by']);
    return Number(out.trim());
  }

  /**
   * Brings a PR branch up to date with the base: GitHub merges the base into it (ARCHITECTURE 68). Pinned
   * to the head we saw, so GitHub refuses (422) when the head moved or the update conflicts.
   */
  async updateBranch(number, headSha) {
    assertSha(headSha);
    if (!Number.isInteger(Number(number))) throw new Error(`bad PR number: ${number}`);
    await this.exec(['api', '-X', 'PUT', `${this.api}/pulls/${Number(number)}/update-branch`, '-f', `expected_head_sha=${headSha}`]);
  }

  /** Health of the base branch: { sha, status } where status is green, red or pending. */
  async mainHealth() {
    const sha = (await this.exec(['api', `${this.api}/commits/${this.base}`, '--jq', '.sha'])).trim();
    assertSha(sha);
    const conclusions = (await this.#jobs(sha)).map((j) => j.conclusion || 'pending');
    const bad = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure']);
    const status = conclusions.some((c) => bad.has(c)) ? 'red' : conclusions.includes('pending') || conclusions.length === 0 ? 'pending' : 'green';
    return { sha, status };
  }

  async diff(number) {
    return this.exec(['pr', 'diff', String(number), '--repo', this.repo]);
  }

  /** Open issues (not PRs) carrying a label, as [{ number, title, body, author }]. author is null for a deleted account. */
  async openIssuesWithLabel(label) {
    if (!LABEL_RE.test(label ?? '')) throw new Error(`bad label: ${label}`);
    const out = await this.exec([
      'api', '--paginate', `${this.api}/issues?state=open&per_page=100&labels=${encodeURIComponent(label)}`,
      '--jq', '.[] | select(.pull_request == null) | {number, title, updated_at, author: .user.login}',
    ]);
    // Bodies are fetched later, only for issues that pass the membership checks. Parse errors are fixed text: no issue content in logs.
    return out.split('\n').filter(Boolean).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error('cannot parse the issue list from gh');
      }
    });
  }

  /** Body of one issue, fetched after the membership checks pass. */
  async issueBody(number) {
    if (!Number.isInteger(number) || number < 1) throw new Error(`bad issue number: ${number}`);
    return String((await this.exec(['api', `${this.api}/issues/${number}`, '--jq', '.body // ""'])).replace(/\n$/, ''));
  }

  /** Label events of an issue, oldest first, as [{ event: 'labeled' | 'unlabeled', label, actor, at }]. */
  async labelEvents(number) {
    if (!Number.isInteger(number) || number < 1) throw new Error(`bad issue number: ${number}`);
    const out = await this.exec([
      'api', '--paginate', `${this.api}/issues/${number}/events`,
      '--jq', '.[] | select(.event == "labeled" or .event == "unlabeled") | {event, label: .label.name, actor: .actor.login, at: .created_at}',
    ]);
    return out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  /**
   * Arms squash auto-merge pinned to headSha. Throws if GitHub did not arm it.
   * A PR that is already mergeable can be merged by the call itself (no
   * auto-merge request is left behind), so MERGED counts as success.
   */
  async enableAutoMerge(number, headSha) {
    assertSha(headSha);
    await this.exec(['pr', 'merge', String(number), '--repo', this.repo, '--squash', '--auto', '--match-head-commit', headSha]);
    const after = await this.pr(number);
    if (after.state === 'MERGED') return;
    if (!after.autoMergeEnabled) throw new Error(`auto-merge did not arm on PR #${number} (state ${after.state})`);
  }
}

function assertSha(sha) {
  if (!SHA_RE.test(sha ?? '')) throw new Error(`bad commit sha: ${sha}`);
}
