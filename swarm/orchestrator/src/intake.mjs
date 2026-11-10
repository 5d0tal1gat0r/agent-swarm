// Intake: turns GitHub issues labelled `epic` into epics (PLAN P7.1, ARCHITECTURE 39).
//
// Prompt-injection rule: issue text reaches the planner (a model) only when
// BOTH the issue author AND the person who applied the label are members
// (autopilot/members.json). Anything else is skipped before its text is used
// for anything but a log line with the issue number.
// Dedupe: the issue number is stored with the epic (store.findEpicByIssue), so
// restarts and parallel runs never create a second epic for one issue.
import { readFileSync } from 'node:fs';
import { nextEpicId } from './api.mjs';

export const DEFAULT_LABEL = 'epic';
export const DEFAULT_INTERVAL_MINUTES = 5;

export function loadMembers(file) {
  const list = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(list) || list.length === 0 || !list.every((m) => typeof m === 'string' && m)) {
    throw new Error(`${file}: expected a non-empty JSON array of GitHub logins`);
  }
  return list;
}

/** When `label` was last applied (ISO), or null. */
export function labelTime(events, label) {
  const wanted = String(label).toLowerCase();
  const mine = events.filter((e) => String(e.label ?? '').toLowerCase() === wanted);
  const last = mine[mine.length - 1];
  return last && last.event === 'labeled' ? (last.at ?? null) : null;
}

/** Who applied `label` last, or null when it is not on the issue now (an `unlabeled` came after). */
export function labelApplier(events, label) {
  const wanted = String(label).toLowerCase();
  const mine = events.filter((e) => String(e.label ?? '').toLowerCase() === wanted);
  const last = mine[mine.length - 1];
  return last && last.event === 'labeled' ? (last.actor ?? null) : null;
}

/**
 * planEpic, when given, is async (epic) => void and runs the M6 planner on a new epic.
 * Its failure is logged; the epic stays `open` and `orchestrator plan <epic>` can retry.
 */
/**
 * members: an array, or a function that returns the current list. A function is
 * called at the start of every pass, so a membership change in members.json takes
 * effect on the next pass. If the call throws, that pass is skipped (logged) and
 * no epic is created; the orchestrator keeps running.
 */
export function createIntake({ store, gh, members, repo = gh.repo, label = DEFAULT_LABEL, planEpic = null, announce = null, log = console }) {
  let memberSet = new Set();
  const isMember = (login) => typeof login === 'string' && memberSet.has(login.toLowerCase());
  const logged = new Set(); // skip reasons are logged once per issue and reason, not on every poll

  const skip = (result, number, reason) => {
    result.skipped.push({ number, reason });
    const key = `${number}:${reason}`;
    if (!logged.has(key)) {
      logged.add(key);
      log.warn?.(`[intake] skip #${number}: ${reason}`);
    }
  };

  async function intakeOnce() {
    const result = { created: [], skipped: [], errors: [] };
    try {
      const list = typeof members === 'function' ? members() : members;
      memberSet = new Set(list.map((m) => m.toLowerCase()));
    } catch (err) {
      log.error?.(`[intake] members list unreadable, skipping this pass: ${err.message}`);
      result.errors.push(`members: ${err.message}`);
      return result;
    }
    let issues;
    try {
      issues = await gh.openIssuesWithLabel(label);
    } catch (err) {
      log.error?.(`[intake] cannot list issues: ${err.message}`);
      result.errors.push(`list: ${err.message}`);
      return result;
    }
    for (const issue of issues) {
      const { number } = issue;
      try {
        if (store.findEpicByIssue(repo, number)) continue; // already an epic: nothing to do, nothing to log
        if (!isMember(issue.author)) { skip(result, number, `author ${issue.author ?? '(deleted)'} is not a member`); continue; }
        const events = await gh.labelEvents(number);
        const applier = labelApplier(events, label);
        if (!isMember(applier)) { skip(result, number, `label "${label}" applied by ${applier ?? 'nobody or unknown'}, not a member`); continue; }
        const labelledAt = labelTime(events, label);
        // An edit after labelling could change the text a member did not approve. Re-label to accept it.
        if (labelledAt && issue.updated_at && Date.parse(issue.updated_at) > Date.parse(labelledAt)) {
          skip(result, number, 'changed after it was labelled; re-label to accept');
          continue;
        }
        const body = issue.body !== undefined ? issue.body : await gh.issueBody(number);
        const epic = store.createEpic({
          id: nextEpicId(store),
          repo,
          title: (String(issue.title ?? '').trim() || `Issue #${number}`).slice(0, 200),
          body: String(body ?? '').slice(0, 20000),
          status: 'open',
          source: 'github',
          issue: number,
        });
        result.created.push(epic);
        log.log?.(`[intake] #${number} -> ${epic.id} (author ${issue.author}, labelled by ${applier})`);
        announce?.(`epic ${epic.id} created from issue #${number}: ${epic.title}`);
        if (planEpic) {
          try {
            await planEpic(epic);
          } catch (err) {
            log.error?.(`[intake] planning ${epic.id} failed: ${err.message}; epic stays open`);
            result.errors.push(`plan ${epic.id}: ${err.message}`);
          }
        }
      } catch (err) {
        log.error?.(`[intake] issue #${number} failed: ${err.message}`);
        result.errors.push(`#${number}: ${err.message}`);
      }
    }
    return result;
  }

  return { intakeOnce, isMember };
}

/** Polling loop. Never overlaps itself and never throws. Returns { stop }. */
export function startIntakeLoop({ intake, intervalMinutes = DEFAULT_INTERVAL_MINUTES, log = console, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await intake.intakeOnce();
    } catch (err) {
      log.error?.(`[intake] tick failed: ${err.message}`);
    } finally {
      running = false;
    }
  };
  const timer = setIntervalFn(tick, intervalMinutes * 60_000);
  timer.unref?.();
  tick();
  return { stop: () => clearIntervalFn(timer), tick };
}
