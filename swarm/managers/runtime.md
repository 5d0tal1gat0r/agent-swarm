# Manager spec: runtime

## Owns

- `swarm/manager/**`
- `swarm/agents/**`
- `swarm/shared/**`
- `swarm/prompts/manager-*.md`
- `autopilot/src/**`
- `autopilot/bin/**`
- `autopilot/test/**`
- `autopilot/prompts/**`
- `autopilot/sandbox/**`
- `autopilot/*.json`

The manager daemon and CLI, task runner, worktrees, subagent runner and container sandbox args, escalation ladder, waker. Subagent role files. Shared code (bus client, GitHub helpers, globs, location lookup). The paused autopilot.

## Typical tasks

- Manager loop and lease handling (`manager/src/daemon.mjs`, `manager/bin/manager.mjs`).
- Subagent runner and token parsing (`manager/src/subagents.mjs`).
- Bus client behaviour (`shared/bus.mjs`), location lookup (`shared/locate.mjs`).
- Role file changes in `swarm/agents/` (linted).

## Workflow

1. Read the task and ARCHITECTURE entries 8, 24-31, 33, 38, 41, 43.
2. Tests first in `swarm/manager/test/` or `swarm/shared/test/`; inject fakes (`runner`, `spawnFn`, `fetchFn`, clocks) instead of real CLIs or network.
3. Implement; keep the container argument list minimal (worktree rw, one auth file ro, no host env).
4. Autopilot changes only for fixes; it is paused and replaced at the end of M7.
5. Run the checks below, then submit.

## Tools allowed

- Subagent roles: explorer, test-writer, implementer, fixer, checker.
- Commands: `node`, `npm test` in `swarm/`, `node --test` in `autopilot/`, `grep`.
- Never start a real manager, container or model CLI from a subagent; live checks are manual (`SWARM_LIVE=1`, `manager/live/`).

## Checks before submit

- `cd swarm && npm ci --ignore-scripts && npm test`.
- If `autopilot/**` changed: `cd autopilot && node --test 'test/*.test.mjs'`.

## Contracts and human review

- Consumes `swarm/protocol/**` (core owns it). Needs a protocol change: ask for a contract task first.
- No humanReview paths in this department.

## Never

- Mount the home directory, `.git`, the docker/podman socket or host environment into a subagent container.
- Let a subagent run git, or push from anywhere but the manager's own task branch.
- Send the manager token to a URL that has not passed `/whoami` (ARCHITECTURE 43).
- Log raw tokens or auth file contents.

## Escalation

- `blocked <task> <reason>` to `swarm-orchestrator` when a fake cannot reproduce the behaviour and a live check is needed.
- `help <text>` for anything touching container isolation or token handling.
