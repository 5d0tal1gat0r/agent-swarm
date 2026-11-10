// The worker loop: snapshot GitHub, decide, act, announce, repeat.

import fs from 'node:fs';
import path from 'node:path';
import { decide, DEFAULT_POLICY, headReviewState } from './decide.mjs';

const approvalsRequired = (snapshot) => ({ ...DEFAULT_POLICY, ...snapshot.policy }).approvalsRequired;
import { STATE_DIR } from './config.mjs';
import { Bus } from './bus.mjs';
import { GitHub } from './github.mjs';
import { Ledger } from './ledger.mjs';
import { runJob } from './sandbox.mjs';

const NUDGE_AFTER_MS = 12 * 3_600_000;

const slug = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'task';

export class Worker {
  constructor(config, { gh, bus, ledger, log = console, runJobFn = runJob, onlineFn } = {}) {
    this.onlineFn = onlineFn;
    this.config = config;
    this.gh = gh ?? new GitHub(config.repo);
    this.bus = bus ?? new Bus(config.busMcpUrl, `${config.member.toLowerCase()}-${config.agent}-worker`, log);
    this.ledger = ledger ?? new Ledger(path.join(STATE_DIR, 'ledger.jsonl'));
    this.log = log;
    this.runJobFn = runJobFn;
    this.logDir = path.join(STATE_DIR, 'logs');
    this.nudged = new Map();
    fs.mkdirSync(this.logDir, { recursive: true });
  }

  /** One cycle. Returns the job it handled (or null). `dryRun` only decides. */
  /** Members with an agent online on the bus (agent names start with the login). */
  async onlineMembers(members) {
    try {
      const url = new URL('/api/agents', this.config.busMcpUrl.replace(':3422/mcp', ':3421'));
      const agents = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).json();
      const names = agents.filter((a) => a.status === 'online').map((a) => a.name.toLowerCase());
      return members.filter((m) => names.some((n) => n.startsWith(m.toLowerCase())));
    } catch {
      return [];
    }
  }

  async cycle({ dryRun = false, now = new Date() } = {}) {
    const snapshot = await this.gh.snapshot();
    snapshot.online = this.onlineFn ? await this.onlineFn(snapshot.members) : await this.onlineMembers(snapshot.members);
    if (snapshot.paused) {
      this.log.info('paused (open autopilot-pause issue)');
      return null;
    }
    const job = decide(snapshot, this.config.member, { skip: this.ledger.recentFailures(now) });
    if (dryRun || !job) {
      if (!job) await this.nudgeStalePrs(snapshot, now);
      return job;
    }
    const agentJob = ['build', 'review', 'fix'].includes(job.kind);
    if (agentJob && this.ledger.jobsToday(now) >= this.config.maxJobsPerDay) {
      this.log.info(`daily limit of ${this.config.maxJobsPerDay} jobs reached`);
      await this.bus.status(`daily limit reached (${this.config.maxJobsPerDay} jobs)`);
      return null;
    }
    const ok = await this.act(job, snapshot);
    this.ledger.record(job, ok, now);
    return job;
  }

  async act(job, snapshot) {
    const who = this.config.member;
    const pr = job.pr ? snapshot.prs.find((p) => p.number === job.pr) : null;
    const ref = pr ? `PR #${pr.number} "${pr.title}"` : `issue #${job.issue}`;
    try {
      switch (job.kind) {
        case 'merge': {
          await this.gh.mergePr(job.pr, job.sha);
          await this.bus.say(`Merged ${ref} (${approvalsRequired(snapshot)} approval(s), checks green). [${who} autopilot]`);
          return true;
        }
        case 'triage': {
          if (job.reviewers.length) await this.gh.requestReviewers(job.pr, job.reviewers);
          if (job.autoMerge) await this.gh.enableAutoMerge(job.pr);
          const parts = [
            job.reviewers.length ? `reviewers ${job.reviewers.join(', ')}` : '',
            job.autoMerge ? `auto-merge on (merges itself at ${approvalsRequired(snapshot)} approval(s) + green checks)` : '',
          ].filter(Boolean);
          await this.bus.say(`${ref}: ${parts.join('; ')}. [${who} autopilot]`);
          return true;
        }
        case 'escalate': {
          await this.gh.addLabel('pr', job.pr, 'needs-human');
          await this.gh.comment('pr', job.pr, 'Autopilot stopped: 3 rounds of changes requested without agreement. A person needs to decide; remove the `needs-human` label to let the agents continue.');
          await this.bus.say(`${ref} needs a human: 3 review rounds without agreement. [${who} autopilot]`);
          return true;
        }
        case 'build': {
          const issue = await this.gh.issue(job.issue);
          const branch = `${who}/issue-${job.issue}-${slug(issue.title)}`;
          await this.bus.say(`Starting ${ref} "${issue.title}" on branch ${branch}. [${who} autopilot]`);
          const result = await this.runAgent(job, { issue: job.issue, issueTitle: issue.title, issueBody: issue.body || '(no description)', branch });
          if (!result.ok) {
            await this.gh.releaseIssue(job.issue, who, `${who}'s autopilot could not finish this task (${result.timedOut ? 'time limit' : `exit ${result.code}`}). Released for someone else.`);
            await this.bus.say(`Gave up on ${ref}; released it. [${who} autopilot]`);
          }
          return result.ok;
        }
        case 'review':
        case 'fix': {
          await this.bus.say(`${job.kind === 'review' ? 'Reviewing' : 'Fixing'} ${ref}. [${who} autopilot]`);
          const result = await this.runAgent(job, { pr: job.pr, sha: job.sha });
          if (!result.ok) await this.bus.say(`${job.kind} of ${ref} failed (${result.timedOut ? 'time limit' : `exit ${result.code}`}); will retry later. [${who} autopilot]`);
          return result.ok;
        }
      }
    } catch (err) {
      this.log.error(`${job.kind} ${ref} failed: ${err.stderr || err.message}`);
      await this.bus.say(`${job.kind} of ${ref} hit an error: ${String(err.message).slice(0, 200)} [${who} autopilot]`);
      return false;
    }
    return false;
  }

  async runAgent(job, vars) {
    const logFile = path.join(this.logDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${job.kind}-${job.pr ?? job.issue}.log`);
    await this.bus.status(`${job.kind} #${job.pr ?? job.issue}`);
    this.log.info(`${job.kind} #${job.pr ?? job.issue} → log ${logFile}`);
    const result = await this.runJobFn(job, this.config, vars, { logFile });
    await this.bus.status('idle');
    return result;
  }

  /** Once per 12 h, ask for reviewers on own PRs that wait for approvals. */
  async nudgeStalePrs(snapshot, now) {
    const members = new Set(snapshot.members.map((m) => m.toLowerCase()));
    for (const p of snapshot.prs) {
      if (p.author.toLowerCase() !== this.config.member.toLowerCase() || p.draft) continue;
      const waiting = now.getTime() - Date.parse(p.updatedAt);
      const last = this.nudged.get(p.number) ?? 0;
      if (waiting > NUDGE_AFTER_MS && now.getTime() - last > NUDGE_AFTER_MS && headReviewState(p, members).approvals < approvalsRequired(snapshot)) {
        this.nudged.set(p.number, now.getTime());
        await this.bus.say(`PR #${p.number} "${p.title}" has waited ${Math.round(waiting / 3_600_000)} h for reviews. Turn on your autopilot to help.`);
      }
    }
  }

  async loop() {
    await this.bus.say(`${this.config.member}'s autopilot is online (${this.config.agent}).`);
    let stop = false;
    for (const sig of ['SIGINT', 'SIGTERM']) {
      process.once(sig, async () => {
        stop = true;
        await this.bus.say(`${this.config.member}'s autopilot is going offline.`);
        await this.bus.close();
        process.exit(0);
      });
    }
    while (!stop) {
      try {
        const job = await this.cycle();
        if (job && job.kind !== 'merge') continue; // more work may be waiting
      } catch (err) {
        this.log.error(`cycle failed: ${err.stderr || err.message}`);
      }
      await new Promise((r) => setTimeout(r, this.config.pollSeconds * 1000));
    }
  }
}
