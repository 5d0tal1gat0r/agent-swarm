# Agent instructions

Rules for every coding agent (Claude Code, Codex, Gemini CLI and others) that
works in this repository. `CLAUDE.md` and `GEMINI.md` load this file.

Several people may work here at once, each with their own agent. Agents
coordinate through the `agent-comm` MCP bus (`http://<server-ip>:3422/mcp` on
your private network). `README.md` explains how to connect.

## What is here

The main code is the **agent swarm** (`swarm/`): one orchestrator, one manager
per department on members' machines, and short-lived subagents in containers.
The server runs the bus, a watchdog and the dashboard. `autopilot/` holds the
earlier, simpler workers.

Before you change the swarm, read:

1. `swarm/ARCHITECTURE.md`: the design and every numbered decision. A change
   in behaviour adds a numbered entry there.
2. `swarm/managers/<department>.md`: what each department's manager owns,
   does and must never do.
3. `swarm/README.md` for CLI usage, and `swarm/deploy/RUNBOOK.md` for install,
   upgrade, rollback and backup.

Operate the services with `swarm/scripts/swarmctl` (`status`, `start`, `stop`,
`restart`, `logs`, `doctor`, `upgrade`, `rollback`, `export`, `import`, and
`--remote <ssh-host>` for another machine). The orchestrator publishes its
address on the bus (state `swarm/orchestrator`), and managers use `--url bus`,
so no address is hard-coded. Managers talk to the orchestrator with direct
messages to `swarm-orchestrator` (`ready`, `blocked <task> <reason>`,
`help <text>`). The orchestrator answers `dispatch: ...` when work is queued
(ARCHITECTURE 41).

## Picking work

Work reaches the repository in two ways:

1. **Epics, built by the swarm.** Anyone can propose an epic, in the dashboard
   or as a GitHub issue labelled `epic`. Write it as a goal, acceptance
   criteria and the paths it may touch. The orchestrator plans it into tasks,
   the managers' subagents build them, and the review loop merges them. Do not
   edit files of a task the swarm is building (the dashboard shows its paths);
   comment on the epic instead.
2. **Tasks done by hand.** Some work should not go to the swarm, for example
   changes to the swarm's own core. A maintainer assigns it as an issue listed
   in `TASKS.md`. Start your agent with `prompts/start.md`, take only a task
   assigned to you, and unassign yourself if you give it up.

Never start a second orchestrator. Run a manager on your machine only with a
manager token from a maintainer (`swarmctl install manager`, see the runbook).

## At session start

1. `comm_register({ name: "<user>-<agent>", channels: ["general"] })`, for
   example `ana-claude`. Use the same name every session.
2. `comm_inbox` to read messages from other agents.
3. `comm_send({ channel: "general", content: "..." })` to say what you are
   going to work on.

## Pull requests

- `main` is protected: a pull request merges only with a green `check`.
- Turn on auto-merge right after you open a pull request:

  ```bash
  gh pr merge <N> --auto --squash --delete-branch
  ```

  GitHub then merges it as soon as the required checks and reviews pass.
  Open a **draft** if it must not merge yet; GitHub never auto-merges a draft.
  To stop a queued merge: `gh pr merge <N> --disable-auto`.
- Keep at most one open pull request per person, and finish it before you
  start the next task.
- Pull requests target `main` only. Do not stack a pull request on another
  feature branch: those branches are not protected.
- If you are a requested reviewer, review before anything else, security
  changes first. Review for correctness and security, and approve only what
  you would deploy.

## While working

- Before you edit a file, check and claim its lock:
  `comm_state({ action: "get", namespace: "locks", key: "<path>" })`, then
  `comm_state({ action: "cas", namespace: "locks", key: "<path>", expected: null, new_value: "<your name>" })`.
  If someone else holds the lock, message them instead of editing.
- Release locks when you are done:
  `comm_state({ action: "delete", namespace: "locks", key: "<path>" })`.
- Call `comm_inbox` before each new task and every few minutes.
- Keep your status current: `comm_agents({ action: "status", status_text: "..." })`.
- If you are blocked, ask in `general` or use `comm_send({ broadcast: true, ... })`.

## Git

- Work on one branch per task (`<user>/<topic>`). Never push directly to `main`.
- Pull before you start, and open a pull request to merge.
- Announce in `general` when you open or merge a pull request.

## Model use

- Use a mid-tier model for routine work (coding, review, fixes), and the
  smallest model for mechanical edits, status posts and bus chores.
- Use the largest model only for hard design or debugging, after a smaller
  model has failed.
- Autopilot workers read their models from `autopilot/README.md` ("Models").

## At session end

1. Post a short summary of what you did to `general`.
2. Release all your locks.
3. `comm_agents({ action: "unregister" })`.

## Safety

- Never commit secrets or `.env` files.
- Every teammate can read the bus. Do not post secrets there.
- Do not change the server's services by hand unless you administer them.
  Merging to `main` deploys to the server; that is the normal path.
