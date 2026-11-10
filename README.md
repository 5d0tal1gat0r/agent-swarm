# Agent Swarm

A self-hosted system that lets a small team run coding agents (Claude Code,
Codex, Gemini CLI and others) against one GitHub repository, without the
agents stepping on each other.

You describe work as an **epic**: a goal, acceptance criteria and the paths it
may touch. An **orchestrator** plans it into tasks. **Managers**, one per
department, lease the tasks and run them in short-lived, sandboxed
**subagents**. Each subagent opens a pull request, and a review loop checks it
before it merges. Everyone sees the work on a live **dashboard**. The agents
talk to each other over a shared MCP message bus.

> **Status:** experimental, built and used by one small team. Expect rough
> edges, and read [`swarm/ARCHITECTURE.md`](swarm/ARCHITECTURE.md) before you
> rely on any behaviour.

## How it fits together

```
                 ┌──────────────────────────────┐
  GitHub  ◀──────│ orchestrator                 │  task queue, planner, review
  issues / PRs   │ (one machine, makes the      │  gates, monitor, dispatcher
                 │  model calls for planning)   │
                 └──────────────┬───────────────┘
                                │ HTTP + bus
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
 ┌─────────────┐         ┌─────────────┐         ┌─────────────┐
 │ manager     │         │ manager     │         │ manager     │  one per department,
 │ (core)      │         │ (docs)      │   ...   │ (qa)        │  on members' machines
 └──────┬──────┘         └──────┬──────┘         └──────┬──────┘
        ▼                       ▼                       ▼
   subagents in containers: one task, one git worktree, one pull request

 server: agent-comm bus (MCP)  ·  watchdog  ·  dashboard (web UI)
```

- **Orchestrator** (`swarm/orchestrator/`): stores tasks and epics in SQLite,
  routes each task to the department that owns its paths, runs the review
  gates, watches budgets and stuck work, and wakes idle managers.
- **Managers** (`swarm/manager/`): one daemon per department. A manager leases
  a task, creates a worktree, starts a subagent, runs the department's checks
  and reports progress.
- **Subagents** (`swarm/agents/`, `swarm/sandbox/`): role-specific agents
  (implementer, test-writer, fixer, checker, doc-writer) that run in a
  container with only the worktree mounted.
- **Bus** (`scripts/`): [agent-comm](https://github.com/keshrath/agent-comm)
  behind a small MCP-over-HTTP bridge, so agents on different machines share
  channels, direct messages and key-value state (file locks, for example).
- **Dashboard** (`swarm/dashboard/`): control room, work queue, epics,
  departments, a live graph of who works on what, an agent cockpit and a chat.
  Members sign in with their own account.

## Requirements

- Node.js 22.13 or newer.
- A private network between your machines. The project assumes
  [Tailscale](https://tailscale.com/): every service binds to the machine's
  Tailscale address, never to a public interface.
- On the orchestrator machine: the `claude` CLI (logged in) and `gh`.
- On manager machines: an agent CLI and Podman (or Docker) for the subagent
  sandbox.
- A GitHub repository for the swarm to work on, and a fine-grained token for
  it (Contents, Pull requests: read and write; Checks, Actions: read).

## Getting started

Everything is driven by `swarm/scripts/swarmctl` (run `swarmctl help`). The
full, step-by-step guide is [`swarm/deploy/RUNBOOK.md`](swarm/deploy/RUNBOOK.md).
In short:

1. **Bus, on the server.** Run `scripts/bootstrap.sh`, then
   `scripts/install-user-service.sh`. This installs agent-comm and the MCP
   bridge as user services. `.env.example` shows the settings.
2. **Orchestrator, on one machine.**
   ```bash
   cd swarm && npm ci --ignore-scripts
   scripts/swarmctl install orchestrator   # writes ~/.config/swarm/orchestrator.env (mode 0600)
   # put the GitHub token in that env file, never in the repo or on a command line
   scripts/swarmctl doctor && scripts/swarmctl start orchestrator
   ```
3. **Departments.** Edit `swarm/departments.yaml` (who owns which paths, and
   which agent each department uses) and `swarm/policy.yaml` (budgets, review
   rules).
4. **Managers, on members' machines.** The owner creates a token for each
   manager (`node orchestrator/bin/orchestrator.mjs token add <name> ...`).
   The member saves it to a file with mode 0600, runs
   `node manager/bin/manager.mjs init --url bus ...`, builds the sandbox image
   and starts the manager with `swarmctl`.
5. **Watchdog and dashboard, on the server.** Run
   `swarmctl install watchdog|dashboard`, then add dashboard users with
   `node swarm/dashboard/bin/dashboard.mjs user add <name> --token-file <file>`.

Then open an epic, either from the dashboard or as a GitHub issue labelled
`epic`, and watch the dashboard.

## Connecting an agent to the bus

The bus is a Streamable HTTP MCP server at `http://<bus-host>:3422/mcp`.

```bash
# Claude Code
claude mcp add --transport http --scope user agent-comm http://<bus-host>:3422/mcp
```

```toml
# Codex CLI: ~/.codex/config.toml
[mcp_servers.agent-comm]
url = "http://<bus-host>:3422/mcp"
```

```json
// Gemini CLI: ~/.gemini/settings.json (httpUrl, not url)
{ "mcpServers": { "agent-comm": { "httpUrl": "http://<bus-host>:3422/mcp" } } }
```

Any other MCP client works with the same URL. To check the connection, ask the
agent to call `comm_agents` with `action: "list"`. The rules agents follow on
the bus (registering, file locks, status updates) are in
[`AGENTS.md`](AGENTS.md).

## Security model

- **The network is the boundary.** agent-comm has no authentication, so anyone
  who can reach the bus ports can read and wipe it. Keep it on a private
  network, and limit who may reach which ports (for example, with a Tailscale
  ACL that allows only `tcp:3421-3424` to the server).
- **Tokens never enter the repo.** Orchestrator, manager and dashboard tokens
  live in mode-0600 files under `~/.swarm` or `~/.config/swarm`. CI runs a
  tracked-file secret check (`swarm/test/repo-secrets.test.mjs`) and gitleaks.
- **Subagents are sandboxed.** They run in a container with the worktree and
  nothing else from your home directory. Do not run a manager with
  `--subagent-runtime host` on a shared machine.
- **The dashboard is sign-in only**, with a strict Content Security Policy
  (no inline scripts or styles).

## Repository map

- `swarm/`: the swarm. `ARCHITECTURE.md` holds the design and every numbered
  decision, `deploy/RUNBOOK.md` install and operations, `managers/` one spec per department manager.
- `scripts/`: install and run the agent-comm bus and its MCP HTTP bridge.
- `autopilot/`: the earlier, simpler hands-off workers, kept for reference.
  The swarm replaces them.
- `prompts/start.md`: the first message for an agent doing a hand-picked task.
- `docs/`: design specs and implementation plans for larger features.
- `AGENTS.md`: rules every agent follows. `CLAUDE.md` and `GEMINI.md` load it.
- `.github/workflows/ci.yml`: the required `check` job.

Run the tests with `cd swarm && npm ci --ignore-scripts && npm test`.

## License

[PolyForm Shield 1.0.0](LICENSE). You may use, change and contribute to the
software, but you may not use it to offer a product that competes with it.
Contributions need a DCO sign-off; see [CONTRIBUTING.md](CONTRIBUTING.md).
This summary is not legal advice; the license text is what counts.
