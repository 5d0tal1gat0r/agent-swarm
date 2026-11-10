# Agent Swarm

Distributed development system for this repo: one orchestrator, one manager per
department, and short-lived subagents. Design and decisions: [ARCHITECTURE.md](ARCHITECTURE.md).
It runs as: the orchestrator on one workstation, the bus, watchdog and dashboard
(`http://<server-ip>:3424`) on a server, and managers on members' machines. A
solo setup runs one manager for all departments on the orchestrator's machine.
People can also develop the swarm by hand, as ordinary agents
(`prompts/start.md`); that needs no orchestrator or manager.

## Layout

- `protocol/` JSON Schemas for tasks, epics, API calls and events.
- `orchestrator/` task store, router, task API, review gates, monitor, dispatcher (orchestrator machine; ARCHITECTURE 42).
- `manager/` per-department daemon and task runner (member machines).
- `shared/` code copied from `autopilot/src` (GitHub, bus, sandbox, config).
- `dashboard/` the server dashboard on the server (read-only web UI).
- `managers/` one spec per department manager: what it owns, workflow, tools, checks, never-do list (ARCHITECTURE 45).
- `agents/` subagent role definitions (explorer, implementer, test-writer, fixer, checker, doc-writer).
- `prompts/` orchestrator and manager prompts.
- `departments.yaml`, `policy.yaml` configuration (added in M2).

## Manager (member machine)

    node manager/bin/manager.mjs init --url <origin|bus> --name <agent> --member <login> \
      --department <dept>[,<dept>...] --token-file <file> --repo-dir <clone> --checks "<args>" [--agent-command "<args>"] \
      [--bus-url http://<server-ip>:3422/mcp]
    node manager/bin/manager.mjs doctor
    node manager/bin/manager.mjs once --dry-run   # reads the queue, changes nothing
    node manager/bin/manager.mjs once             # leases one task and runs it
    node manager/bin/manager.mjs run              # loop, one task at a time

`--url` is the orchestrator origin (no path). The token comes from a file, never a flag.
`--department core,runtime` lets one config serve several departments (the token must cover them all,
`token add ... --departments core,runtime`): each tick leases from them in that order, and `doctor` checks each one.
The config (`~/.swarm/manager.json`) must be mode 0600; `init` writes it that way.

## Monitor (orchestrator)

Runs inside `orchestrator start`, every 60 s. Alerts go to the `swarm` channel (`--no-bus` prints them). Rules and thresholds: ARCHITECTURE 35.

## Dispatcher (orchestrator)

Runs inside `orchestrator start`. It reads its bus inbox every 10 s for manager messages (`ready`, `blocked <task> <reason>`, `help <text>`) and, every 2 min and on each `ready`, nudges idle online managers whose departments have queued tasks. Flags: `--no-dispatch`, `--dispatch-interval <s>`, `--listen-interval <s>`. Managers join in with `manager init ... --bus-url http://<server-ip>:3422/mcp`. Rules: ARCHITECTURE 41.

## Where it runs, and moving it

The orchestrator runs on the orchestrator machine (all its model calls happen there); the server runs the bus and a watchdog. The orchestrator publishes its URL on the bus; managers started with `--url bus` follow it after verifying it (`POST /whoami`). Move it with `swarmctl export <file>` on the old machine and `swarmctl import <file>` on the new one. Rules: ARCHITECTURE 42, 43. Steps: `deploy/RUNBOOK.md`.

## Dashboard read API (orchestrator)

`GET /snapshot` (tasks, epics, managers, metrics), `GET /tasks/:id/history` and `GET /me`, for a manager token or a read-only `dashboard` token (`orchestrator token add server-dashboard --member <login> --dashboard`). Rules: ARCHITECTURE 46.

## Operator controls API (orchestrator)

`POST /operator/tasks/:id/{resolve,replan,cancel}`, `/operator/pause|resume`, `/operator/departments/:id/pause|resume`, `/operator/managers/:name/pause|resume`, `/operator/epics`. Body `{ "reason": "..." }`. The owner token (`token add <name> --member <login> --owner`) may do all; a member's token only acts on its own managers and their tasks. Rules: ARCHITECTURE 48.

## Owner administration API (orchestrator)

Owner token only: `POST /operator/epics/:id/plan` (dry run, then real run), `POST /operator/intake`, `POST /operator/backup`, `GET|POST /operator/tokens`, `POST /operator/tokens/:name/revoke`, `GET /operator/jobs/:id`. Rules: ARCHITECTURE 51.

## Server dashboard (server)

`swarm/dashboard/`: a read-only web UI for everyone on the tailnet at `http://<server>:3424`. Sign in with your dashboard user and password (the owner creates accounts). Sections: tasks (filters, history, actions), managers (pause/resume), controls (swarm and department pause, new epic), epics, alerts, queue and metrics. Buttons show only what your token may do, and each asks for a reason. The owner also plans epics (dry run, then commit), runs intake and backups, and manages tokens from the page. `/graph` shows agents, conversations, memory and work as a node graph. During an upgrade or restart every page shows a maintenance bar and reloads itself when the dashboard is back (`swarmctl maintenance on|off` sets it by hand; ARCHITECTURE 77). `/chat` is a text chat for signed-in members: `#general` plus channels that owners create with `+` and delete; history is kept on the server in `DASH_CHAT_DIR` (default `~/.swarm/dashboard-chat/`) and the chat works while the orchestrator is offline. The top-bar notification bell uses session-authenticated SSE (`/api/notifications/stream?after=<id>`), persists per-user kind preferences and read-through state (`/api/notifications/preferences`, `/api/notifications/read`), and keeps a bounded in-page replay; browser push is intentionally deferred until HTTPS. A merge to `main` is live on the server within about 5 minutes (`swarm-autodeploy.timer`, ARCHITECTURE 76). Install: `deploy/RUNBOOK.md` section 2b. Rules: ARCHITECTURE 47, chat 72, maintenance 77, notifications 75, auto-deploy 76.

## Agent cockpit (dashboard)

Set `SWARM_AGENT_COCKPIT=1` on the dashboard service to expose `/agents` and its **Agents** navigation link. The page starts on the orchestrator, shows the hierarchy and redacted live feed, and lets an owner or owning manager prompt an assignment, edit goal/current task/skills/guardrails, request status, pause or replan it. Interrupt and stop are owner-only, reason-gated actions. The orchestrator must be running for privileged detail and writes; while it is off, the dashboard serves the summary cache as read-only.

The orchestrator operator worker is optional. Start it with `orchestrator start --operator-cmd "<model command>"` to execute owner prompts; without it, the API returns 501 and the rest of the cockpit remains readable. The dashboard cache path is `DASH_AGENT_CACHE_FILE` (default `~/.swarm/dashboard-agents.json`, mode 0600). The cache contains only member-visible summaries and redacted feed frames; delete it while the dashboard is stopped to recover from corruption. Old managers that do not report sessions/events remain visible as assignments with an honest “not reported” context and do not block the page.

Retention is bounded in memory and on disk (the bridge keeps the latest 2,000 feed frames and the orchestrator store keeps its configured agent event/message retention). No chain-of-thought, raw prompt, model response, command output or authentication material is emitted to the common feed/cache. This cockpit was implemented manually on the feature branch; it is not generated by the swarm.

## Metrics and dashboard (orchestrator)

`GET /metrics` with a manager token returns JSON. `GET /dashboard` serves a page that asks for the token and reads `/metrics` in the browser. Daily summary to `swarm`. Definitions: ARCHITECTURE 36.

## Main red (orchestrator)

When main's checks go red, the monitor opens a p0 revert task for the PR at the head (platform department). It goes through the normal gates and review. Rules: ARCHITECTURE 37.

## Subagent sandbox

Build the image once: `podman build -t swarm-subagent:1 swarm/sandbox`. The manager config sets `subagentRuntime: container` (default for production), `subagentImage`, `containerRuntime` (podman or docker) and `subagentAuth` (host paths of each CLI's login; defaults under the home directory). `subagentRuntime: host` is for local checks only. Rules: ARCHITECTURE 38.

## Review model command

Start the orchestrator with `--review-cmd "claude -p --output-format text"`. The command gets the prompt on stdin and `--model <id>` appended. It must print only the review JSON. Live check: needs a token for real PRs.

## Planner (orchestrator)

    node orchestrator/bin/orchestrator.mjs plan E-0001 --dry-run --plan-cmd "<model command>"
    node orchestrator/bin/orchestrator.mjs plan E-0001 --plan-cmd "<model command>"

The model command reads the prompt on stdin and gets `--model <planModel>` appended. `--dry-run` prints the plan and writes nothing. A real run creates the tasks; an epic is planned only once.

## Intake and MCP endpoint (orchestrator)

    node orchestrator/bin/orchestrator.mjs intake --once [--plan-cmd "<model command>"]

`start` polls open issues labelled `epic` every 5 minutes (`--intake-interval <min>`, `--no-intake`). An epic is made only when the issue author and the person who applied the label are members (`autopilot/members.json`). One issue gives one epic, also after a restart. With `--plan-cmd` the new epic is planned at once; without it, run `plan` yourself. `POST /mcp` is the orchestrator's own MCP endpoint (bearer token): tools `swarm_status`, `swarm_queue`, `swarm_task_get` (manager token) and `swarm_epic_create` (intake token). Rules: ARCHITECTURE 39.
## Deploy

User units, env templates and the admin runbook: `swarm/deploy/RUNBOOK.md` (ARCHITECTURE 40).

## Tests

    cd swarm && npm ci --ignore-scripts && npm test

Runtime: Node 22.13 or newer (`node:sqlite`, no native build). Dependencies: `ajv`, `yaml`.
