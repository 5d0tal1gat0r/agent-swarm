# Autopilot

> **Status: paused.** The swarm (`swarm/`) replaces the autopilot. It is kept
> for reference; work is done by hand meanwhile (see `TASKS.md`).

Hands-off development for this repo. Every member runs one **worker** on their
own machine. All workers follow the same rules (`autopilot/policy.json`,
`src/decide.mjs`), so they agree on who does what without talking. Each cycle a
worker does the first of these that applies:

1. **Finish its own work:** fix its pull request when reviewers requested
   changes, checks fail or it conflicts with `main`. After 3 rounds of changes
   requested it labels the PR `needs-human` and stops.
2. **Triage:** every open pull request gets exactly 2 reviewers requested on
   GitHub (never the author; members who reviewed it before, then online
   members, then the least busy) and GitHub auto-merge turned on.
3. **Review** pull requests it was requested on, in this order: the maintainer's
   first, then `security`, then PRs on `main` before stacked
   ones, then oldest. If a requested reviewer has not acted within 2 hours,
   anyone may review. Each commit is reviewed once per member.
4. **Start a new task** (oldest open issue labelled `task`; `p1` first, then
   the maintainer's) only if the member has no open pull request and the team has
   fewer than 3 open pull requests. Finishing beats starting.
5. Otherwise wait and check again a minute later.

**Merging:** `main` is protected: a green `check` and 0 required approvals
(`policy.json` `approvalsRequired: 0`), for everyone. Auto-merge is always on,
so GitHub merges by itself once the check passes.

**Status:** paused. Members' agents work by hand with `prompts/start.md`, and
the swarm (`swarm/`) replaces the autopilot.

Each agent job runs your agent (Claude Code or Codex) with no approvals, inside
a throwaway Docker container that only has a fresh clone of the repo and your
tokens. It never sees the rest of your machine. Everything is announced on the
agent-comm bus (`#general`, dashboard http://<server-ip>:3421).


## Using it (everyone)

- **Add work:** open a GitHub issue, describe what you want and how to check
  it, and add the label `task` (add `p1` to make it go first). That's all.
- **Stop one task:** add the label `blocked`.
- **Pause everything:** open an issue with the label `autopilot-pause`. Close
  it to resume.
- **When agents disagree:** after 3 rounds of changes requested, the PR gets
  `needs-human`. Read it, decide, and remove the label.

## Setting up your worker

You need Node 22+, Git, the GitHub CLI (`gh auth login` as yourself) and
Docker:

- Linux: install Docker Engine, then `sudo usermod -aG docker $USER` and log
  in again (`docker run hello-world` must work without sudo).
- macOS / Windows: Docker Desktop.

Then, in your clone of this repo:

```bash
cd autopilot
node bin/autopilot.mjs init <your-github-login>
```

This writes `~/.config/autopilot/config.json`. Fill in the two secret files it
names (one line each, then `chmod 600` them):

1. **GitHub token for the sandbox** (`github-token`). While the repo belongs
   to a personal account, fine-grained tokens cannot select it, so create a
   classic token at https://github.com/settings/tokens/new with only the
   `repo` scope and an expiry date. If the repo moves to an organization, use
   a fine-grained token limited to this repository instead (contents, issues
   and pull requests: read and write).
2. **Agent login:**
   - Claude Code: run `claude setup-token` and save the token it prints in
     `claude-token`.
   - Codex: set `"agent": "codex"` in the config and run `codex login`; the
     worker copies `~/.codex/auth.json` into each job.

Then:

```bash
node bin/autopilot.mjs build-image     # once, and after sandbox/ changes
node bin/autopilot.mjs doctor          # every line must say ok
node bin/autopilot.mjs once --dry-run  # shows what it would do, changes nothing
node bin/autopilot.mjs run             # keep this running
```

On Linux, `node bin/autopilot.mjs install-service` runs it in the background
from login (`journalctl --user -u autopilot -f` for logs).

Limits in `config.json`: `maxJobsPerDay` (default 20) and `maxMinutesPerJob`
(default 45). Job logs: `~/.local/state/autopilot/logs/`. A job that failed
is not retried for 2 hours.

**Models (save usage):** `models` in `config.json` picks the model per agent
and job kind (`build`, `review`, `fix`). Only the entry for your `agent` is
used. Defaults:

| agent | build | review | fix |
|---|---|---|---|
| `claude` | `claude-sonnet-5-5` | `claude-sonnet-5-5` | `claude-haiku-5-5` |
| `gemini` | `gemini-3-flash-preview` | `gemini-3-flash-preview` | `gemini-2.5-flash-lite` |
| `codex` | agent default | agent default | agent default |

Override one kind, keep the rest:
`"models": { "claude": { "fix": "claude-sonnet-5-5" } }`. Set a kind to `null`
to use the agent's default. Do not use Opus or the largest Gemini model for
worker jobs unless a job needs it.

Codex: no default, because cheap-versus-strong is your call. Model ids
available to your account are in `~/.codex/models_cache.json` (for example
`gpt-6.1-sol`, `gpt-6-astra`, `gpt-6.1-terra`, `gpt-6-luna`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`). Pick one per kind:
`"models": { "codex": { "fix": "gpt-6-luna" } }`.

Gemini: set `geminiAuthFile` (default `~/.gemini/oauth_creds.json`, the login
of `gemini` on your machine). The sandbox image installs `@google/gemini-cli`;
run `node bin/autopilot.mjs build-image` after this change. The headless run
(`gemini -p ... -m <model> --yolo --skip-trust -o text`) has not been run in
the sandbox yet. Check one job log before you rely on it.

Antigravity: it has no headless worker runner, so workers cannot run it.
Antigravity members follow the model advice in `AGENTS.md` ("Model use") by
hand: its `agentapi new-conversation --model=` takes `flash_lite`, `flash` or
`pro`. Use `flash_lite` for small chores and `flash` for coding and review.

Ids must be plain (letters, digits, `.`, `_`, `-`). Changes take effect on the
next job.

## Owner only

- `node bin/autopilot.mjs setup-repo`: creates the labels and the `main`
  protection rule (approvals from `policy.json`, currently 1; stale approvals dismissed, check `check`
  required). If GitHub's plan does not allow the rule, workers still enforce
  it themselves.
- Workers do not deploy.
- `autopilot/members.json` lists who counts as a member (issues, reviews and
  approvals from anyone else are ignored). Change it by pull request.

## How it decides

`src/decide.mjs` (pure, fully tested) picks one job per cycle from a GitHub
snapshot. `src/worker.mjs` runs it. Prompts for the three agent roles are in
`prompts/`; improve them by pull request like any other code.
