// Picks the worker's next job from a snapshot of GitHub state. Pure: no I/O,
// so every coordination rule is covered by test/decide.test.mjs.
//
// Rules (autopilot/policy.json):
//   1. Finish own work first: fix own PRs (changes requested, red checks,
//      conflicts); escalate after maxChangeRounds.
//   2. Triage: every open PR gets exactly `approvalsRequired` reviewers
//      requested and GitHub auto-merge enabled (when main is protected).
//   3. Merge own PR at `approvalsRequired` member approvals + green checks, only when GitHub
//      cannot do it (no protection rule).
//   4. Review PRs where this member was requested (or any PR whose head is
//      older than reviewTimeoutHours). Order: owner's PRs, `security`, PRs on
//      main, oldest.
//   5. Build a new task only when nothing above applies, the member has no
//      open PR, and the team has fewer than maxOpenPrsTotal open PRs.

export const DEFAULT_POLICY = {
  owner: '',
  approvalsRequired: 1,
  maxOpenPrsPerMember: 1,
  maxOpenPrsTotal: 3,
  reviewTimeoutHours: 2,
  maxChangeRounds: 3,
};
const BLOCKING_LABELS = ['blocked', 'needs-human'];

const lc = (s) => String(s).toLowerCase();
const hasLabel = (item, label) => item.labels.some((l) => lc(l) === label);

/** Approvals and change requests on the head commit, counting each member's latest review there. */
export function headReviewState(pr, members) {
  const author = lc(pr.author);
  const latest = new Map();
  for (const r of [...pr.reviews].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))) {
    const who = lc(r.author);
    if (who === author || !members.has(who) || r.commitId !== pr.headSha) continue;
    if (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED') latest.set(who, r.state);
  }
  const approvedBy = [...latest].filter(([, s]) => s === 'APPROVED').map(([who]) => who);
  return { approvals: approvedBy.length, approvedBy, changesRequested: [...latest.values()].includes('CHANGES_REQUESTED') };
}

/** Number of distinct commits on which a member requested changes. */
export function changeRounds(pr, members) {
  const author = lc(pr.author);
  return new Set(
    pr.reviews
      .filter((r) => r.state === 'CHANGES_REQUESTED' && members.has(lc(r.author)) && lc(r.author) !== author)
      .map((r) => r.commitId),
  ).size;
}

/** Requested reviewers (members, not the author) who have not approved the head yet. */
function pendingRequests(pr, members) {
  const { approvedBy } = headReviewState(pr, members);
  return (pr.requested ?? []).map(lc).filter((r) => members.has(r) && r !== lc(pr.author) && !approvedBy.includes(r));
}

function reviewersNeeded(pr, members, policy) {
  return Math.max(0, policy.approvalsRequired - headReviewState(pr, members).approvals - pendingRequests(pr, members).length);
}

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/**
 * Chooses `count` reviewers for `pr`: never the author or someone already
 * requested/approving. Prefers members who reviewed this PR before
 * (continuity), then members online on the bus, then the fewest pending
 * review requests, then a stable per-PR rotation. Deterministic.
 */
export function pickReviewers(snapshot, pr, count) {
  if (count <= 0) return [];
  const members = new Set(snapshot.members.map(lc));
  const online = new Set((snapshot.online ?? []).map(lc));
  const taken = new Set([lc(pr.author), ...pendingRequests(pr, members), ...headReviewState(pr, members).approvedBy]);
  const reviewedBefore = new Set(pr.reviews.map((r) => lc(r.author)));
  const load = new Map();
  for (const p of snapshot.prs) for (const r of p.requested ?? []) load.set(lc(r), (load.get(lc(r)) ?? 0) + 1);
  const key = (m) => [reviewedBefore.has(m) ? 0 : 1, online.has(m) ? 0 : 1, load.get(m) ?? 0, hash(`${pr.number}:${m}`)];
  const cmp = (a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i];
    return 0;
  };
  return [...members].filter((m) => !taken.has(m)).sort(cmp).slice(0, count);
}

/** Identifies a job for retry backoff: same kind, target and commit. */
export function jobKey(job) {
  return `${job.kind}:${job.pr ?? job.issue}:${job.sha ?? ''}`;
}

/**
 * @param {object} snapshot  { members, policy, protectedMain, online, paused, issues, prs }
 * @param {string} me        this worker's member login
 * @returns {object|null}    { kind: fix|escalate|triage|merge|review|build, ... }
 */
export function decide(snapshot, me, { skip = new Set(), now = new Date() } = {}) {
  if (snapshot.paused) return null;
  const policy = { ...DEFAULT_POLICY, ...(snapshot.policy ?? {}) };
  const members = new Set(snapshot.members.map(lc));
  const self = lc(me);
  const owner = lc(policy.owner);
  const first = (jobs) => jobs.find((j) => !skip.has(jobKey(j))) ?? null;
  const job = (kind, p, extra = {}) => ({ kind, pr: p.number, sha: p.headSha, ...extra });

  const open = snapshot.prs.filter((p) => !p.draft && !hasLabel(p, 'needs-human') && members.has(lc(p.author)));
  const order = (a, b) =>
    Number(lc(b.author) === owner) - Number(lc(a.author) === owner) ||
    Number(hasLabel(b, 'security')) - Number(hasLabel(a, 'security')) ||
    Number(b.baseRef === 'main') - Number(a.baseRef === 'main') ||
    a.number - b.number;
  const mine = open.filter((p) => lc(p.author) === self).sort(order);
  const others = open.filter((p) => lc(p.author) !== self).sort(order);

  // 1. Finish own work.
  const fix = first(
    mine.flatMap((p) => {
      const { changesRequested } = headReviewState(p, members);
      if (changesRequested && changeRounds(p, members) >= policy.maxChangeRounds) return [job('escalate', p)];
      if (changesRequested || p.checks === 'failure' || p.mergeable === false) return [job('fix', p)];
      return [];
    }),
  );
  if (fix) return fix;

  // 2. Triage: reviewers + auto-merge for every PR that is not red.
  const triage = first(
    [...mine, ...others].sort(order).flatMap((p) => {
      if (p.checks === 'failure') return [];
      const reviewers = pickReviewers(snapshot, p, reviewersNeeded(p, members, policy));
      // Only PRs into the protected main: on any other base GitHub would merge
      // with no review at all. Stacked PRs get it once retargeted to main.
      const autoMerge = Boolean(snapshot.protectedMain) && p.baseRef === 'main' && !p.autoMerge;
      return reviewers.length > 0 || autoMerge ? [job('triage', p, { reviewers, autoMerge })] : [];
    }),
  );
  if (triage) return triage;

  // 3. Merge own PR ourselves only when GitHub's protection rule cannot.
  if (!snapshot.protectedMain) {
    const merge = first(
      mine
        .filter((p) => {
          const { approvals, changesRequested } = headReviewState(p, members);
          return approvals >= policy.approvalsRequired && !changesRequested && p.checks === 'success' && p.mergeable;
        })
        .map((p) => job('merge', p)),
    );
    if (merge) return merge;
  }

  // 4. Review what was asked of us (or anything waiting too long).
  const timeoutMs = policy.reviewTimeoutHours * 3_600_000;
  const review = first(
    others
      .filter((p) => p.checks !== 'failure')
      .filter((p) => !p.reviews.some((r) => lc(r.author) === self && r.commitId === p.headSha))
      .filter((p) => headReviewState(p, members).approvals < policy.approvalsRequired)
      .filter(
        (p) =>
          (p.requested ?? []).some((r) => lc(r) === self) ||
          now.getTime() - Date.parse(p.headCommittedAt ?? p.updatedAt) > timeoutMs,
      )
      .map((p) => job('review', p)),
  );
  if (review) return review;

  // 5. Start something new only when the team is not already juggling work.
  if (mine.length >= policy.maxOpenPrsPerMember || open.length >= policy.maxOpenPrsTotal) return null;
  const tasks = snapshot.issues
    .filter((i) => hasLabel(i, 'task') && !BLOCKING_LABELS.some((l) => hasLabel(i, l)))
    .filter((i) => i.assignees.length === 0 && members.has(lc(i.author)))
    .sort(
      (a, b) =>
        Number(hasLabel(b, 'p1')) - Number(hasLabel(a, 'p1')) ||
        Number(lc(b.author) === owner) - Number(lc(a.author) === owner) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  return first(tasks.map((i) => ({ kind: 'build', issue: i.number })));
}

/** Kept for the worker's stale-PR nudges. */
