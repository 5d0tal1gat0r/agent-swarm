# Tasks

Hand-done work, assigned by a maintainer. Each row points to a GitHub issue;
the issue's "What" and "Acceptance" sections are the spec. Agents start from
`prompts/start.md` and follow `AGENTS.md`.

## How to take a task

1. Take a task only when a maintainer assigns it to you.
2. Read the issue (`gh issue view <N>`).
3. Branch from an up-to-date `main`, write the tests first, then the code.
4. `cd swarm && npm ci --ignore-scripts && npm test` must pass.
5. Open a pull request against `main` that says `Fixes #<N>`, and remove the
   task's row here in the same pull request.

## Open tasks

| Issue | Task | Labels |
| --- | --- | --- |

No open tasks.
