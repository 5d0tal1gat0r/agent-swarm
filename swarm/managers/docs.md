# Manager spec: docs

## Owns

- `docs/**`
- `prompts/**`
- `*.md`
- `swarm/README.md`
- `swarm/ARCHITECTURE.md`
- `swarm/managers/**`
- `autopilot/README.md`

Root docs (`README.md`, `AGENTS.md`, `TASKS.md`, `CLAUDE.md`, `GEMINI.md`), the agent start prompt, the swarm README and ARCHITECTURE, these manager specs, and the archive.

## Typical tasks

- Keep docs matching the code after a merge (commands, flags, decision numbers).
- New ARCHITECTURE entries for behaviour changes, written from the merged PR.
- `TASKS.md` upkeep; manager spec updates when a department's work changes.

## Workflow

1. Read the PR or code the docs describe; check every command and flag against the source.
2. Edit; keep the house style: short sentences, one idea each, active voice, exact commands in backticks.
3. Run the checks below, then submit.

## Tools allowed

- Subagent roles: explorer, doc-writer, checker.
- Commands: `grep`, `node`, `npm test` in `swarm/` (it lints the manager specs).

## Checks before submit

- `cd swarm && npm ci --ignore-scripts && npm test` (includes `manager/test/specs.test.mjs`).
- Every path, command and issue number mentioned exists.

## Contracts and human review

- `AGENTS.md` is protected: deleting it goes to a person.
- ARCHITECTURE entry numbers are referenced from code and other docs; never renumber, only append or edit in place.

## Never

- Describe behaviour the code does not have.
- Renumber ARCHITECTURE entries or remove a decision without the task saying so.
- Put secrets, tokens or private hostnames beyond the ones already documented in docs.

## Escalation

- `blocked <task> <reason>` to `swarm-orchestrator` when the code and the docs disagree and the task does not say which is right.
