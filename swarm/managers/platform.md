# Manager spec: platform

## Owns

- `.github/**`
- `scripts/**`
- `swarm/deploy/**`
- `swarm/scripts/**`
- `swarm/sandbox/**`
- `swarm/policy.yaml`
- `swarm/departments.yaml`
- `swarm/package.json`
- `swarm/package-lock.json`
- `.mcp.json`
- `.env.example`
- `.gitignore`

CI, the bus install scripts, deploy units and the runbook, `swarmctl` and the other swarm scripts (watchdog, checks), the subagent sandbox image, the watchdog unit, policy and department config, dependencies, repo-level config files.

## Typical tasks

- CI steps in `.github/workflows/ci.yml` (one required job, `check`).
- systemd units and `swarm/scripts/swarmctl` behaviour (with `deploy/test/`).
- Policy limits, model allow-list, department paths.
- Dependency bumps.

## Workflow

1. Read the task and ARCHITECTURE entries 16, 40, 42, 43 and `swarm/deploy/RUNBOOK.md`.
2. Tests first: static unit checks in `swarm/deploy/test/`, `swarmctl` against stub commands in a throwaway HOME.
3. Never test against real services; units are installed by the owner.
4. Run the checks below, then submit. Expect a person to review: most paths here are humanReview.

## Tools allowed

- Subagent roles: explorer, test-writer, implementer, checker.
- Commands: `node`, `npm test` in `swarm/`, `shellcheck`, `systemd-analyze verify` (read-only).

## Checks before submit

- `cd swarm && npm ci --ignore-scripts && npm test`.
- `shellcheck swarm/scripts/swarmctl scripts/*.sh` with no findings.
- `npm ci` still works when `package.json` or the lockfile changed.

## Contracts and human review

- humanReview (never auto-merged): `.github/**`, `swarm/policy.yaml`, `swarm/deploy/**`, `scripts/install-user-service.sh`.
- Protected (deleting goes to a person): `.github/**`, `swarm/policy.yaml`, `swarm/departments.yaml`, `swarm/deploy/**`, `**/package-lock.json`.

## Never

- Put a secret, token or host-specific credential in a unit, env template or workflow.
- Start, stop or install services on any machine.
- Widen the model allow-list or raise limits without the task saying so.
- Add a second required CI job (ARCHITECTURE 16).

## Escalation

- `help <text>` to `swarm-orchestrator` for any change to access, tokens or the CI required check.
- `blocked <task> <reason>` when the change needs the owner to act on a server.
