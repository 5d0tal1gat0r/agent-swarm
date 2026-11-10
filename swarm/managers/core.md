# Manager spec: core

## Owns

- `swarm/orchestrator/**`
- `swarm/protocol/**`
- `swarm/prompts/orchestrator-*.md`
- `swarm/dashboard/**`

The orchestrator: task store (SQLite), router, task API, review gates and review loop, monitor, dispatcher, planner, intake, metrics and dashboard page. The protocol JSON Schemas every component validates against. The orchestrator's model prompts (plan, review). The server dashboard on the server (`swarm/dashboard/`).

## Typical tasks

- New or changed API route (`orchestrator/src/api.mjs`) with its schema in `protocol/api/`.
- Monitor or dispatcher rules (`monitor.mjs`, `dispatcher.mjs`), gate rules (`gates.mjs`).
- Store changes with a migration (`PRAGMA user_version` in `store.mjs`).
- Planner and review prompt changes.
- Server dashboard sections and API proxy (`swarm/dashboard/`); render functions escape every value.

## Workflow

1. Read the task and the ARCHITECTURE entries for the files it touches (core decisions: 5, 6, 21-23, 32, 34-37, 39, 41, 43).
2. Plan: tests in `swarm/orchestrator/test/` or `swarm/protocol/test/` first (test-writer), then code (implementer).
3. Store changes: add a migration step; never edit an old one.
4. API changes: update the schema in `protocol/api/`, validate the body with `checked(...)`, keep `authenticate` on every non-public route.
5. Run the checks below, then submit.

## Tools allowed

- Subagent roles: explorer, test-writer, implementer, fixer, checker.
- Commands: `node`, `npm test` inside `swarm/`, `grep`, `sed -n`.
- No network calls except the model API.

## Checks before submit

- `cd swarm && npm ci --ignore-scripts && npm test` (all green).
- `node --check` on every changed `.mjs` file.

## Contracts and human review

- `swarm/protocol/**` is a contract glob: a change there is planned as a contract task that lands before the work that uses it (ARCHITECTURE 7, 34).
- No humanReview paths in this department.

## Never

- Change `managers.json` handling so raw tokens are stored, logged or returned.
- Add an unauthenticated route that returns task, epic or manager data (only `/health`, `/dashboard` page and `/whoami` are public).
- Edit `swarm/policy.yaml` or `swarm/departments.yaml` (platform owns them).
- Rewrite an existing store migration.

## Escalation

- Ambiguous acceptance, or the task needs a file outside the paths: send `blocked <task> <reason>` to `swarm-orchestrator` on the bus and stop.
- A schema change that breaks managers in the field: `help <text>` and wait for the owner.
