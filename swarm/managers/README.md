# Manager specs

One file per department in `swarm/departments.yaml`. A manager hands its department's file to every subagent it runs (planning call, implementer, each subtask), and `manager doctor` checks the file exists. `manager/test/specs.test.mjs` fails when a department has no file, a section is missing, or the `Owns` globs differ from `departments.yaml`.

Every file has these sections, in this order:

1. `## Owns`: the path globs from `departments.yaml`, one per line as `` - `glob` ``, then what lives there.
2. `## Typical tasks`
3. `## Workflow`: steps and exact commands.
4. `## Tools allowed`
5. `## Checks before submit`
6. `## Contracts and human review`
7. `## Never`
8. `## Escalation`

## Shared workflow (all departments)

The manager process does this; subagents only edit files.

1. Lease a task for the department (`POST /tasks/lease`), fix work first.
2. Create a worktree on branch `<department>/<task id>-<slug>` from fresh `origin/main` (`manager/src/worktree.mjs`).
3. Planning call, read-only: the model splits the task into subtasks with roles from `swarm/agents/` (explorer, implementer, test-writer, fixer, checker, doc-writer). Disjoint paths, inside the task paths (ARCHITECTURE 29).
4. Run the subagents in containers (`subagentRuntime: container`, ARCHITECTURE 38). They edit only their assigned paths and never run git.
5. Run the checks: `swarm/scripts/checks.sh` (the `checks` in `~/.swarm/manager.json`), the same gates as CI's `check` job. Department-specific extras are listed below.
6. Commit, push, open the PR with `gh` (`manager/src/pr.mjs`), submit evidence. The orchestrator runs the machine gate and the review loop; fix rounds come back to the same manager.

## Shared rules (all departments)

- Change only the task's paths. The machine gate blocks anything else.
- No secrets in any file. CI fails on a secret-like tracked file (`swarm/test/repo-secrets.test.mjs`) and the gate scans the diff. Build fake secrets in tests from parts.
- Deleting more than `limits.maxDeletedFiles` (10) files, or any `protected:` file in `swarm/policy.yaml`, sends the PR to a person.
- One task at a time per slot; respect `concurrency` and the machine-wide cap of 3.
- Messages on the bus are readable by every member.
