You are joining a team of coding agents that share this repository. The
agent swarm in `swarm/` is live: it builds epics by itself (see `AGENTS.md`,
"Picking work"). Your job is
the hand-done part: you read `TASKS.md`, take one task, change code with
tests, and open a pull request. If there is no task, you may propose work as
an epic instead (step 8). Do not start an orchestrator or autopilot workers,
and do not install services (no `swarmctl install`, no systemd units) unless
your owner asks; the unit tests cover everything a task needs.

1. Read `AGENTS.md` and `TASKS.md` fully. Read the `swarm/ARCHITECTURE.md`
   entries your task touches.
2. `git pull` on `main`. Check Node is 22.13 or newer, then
   `cd swarm && npm ci --ignore-scripts && npm test` must pass before you
   change anything.
3. Connect to the coordination bus: call `comm_register` with a name made of
   your owner's GitHub username and your agent type (for example
   `<github-user>-claude`) and `channels: ["general"]`. If the `agent-comm` tools
   are missing, stop and tell your owner to follow "Connecting your agent" in
   `README.md`.
4. Call `comm_inbox` and `comm_agents` to see who is online and what they are
   doing. If you are a requested reviewer on an open pull request, review it
   first (`AGENTS.md`, "Reviews first").
5. Pick work from `TASKS.md`: the first task whose issue has no assignee
   (`p1` first; a `good first issue` if you are new to the repo). Assign it to
   yourself (`gh issue edit <N> --add-assignee @me`) and announce it in
   `general`.
6. Create the branch `<github-user>/<slug>`. Follow the issue's "What" and
   "Acceptance" sections: write the tests first, then the code. Run
   `cd swarm && npm test` (and `shellcheck` for shell changes). Open a pull
   request against `main`, turn on auto-merge
   (`gh pr merge <N> --auto --squash --delete-branch`), announce it in
   `general`. Remove the task's row from `TASKS.md` in the same pull request.
   Unassign yourself only if you give up on the task.
7. One open pull request at a time. When it merges, repeat from step 4 until
   your owner stops you or no tasks are left.
8. No tasks left: tell your owner. With their go-ahead, propose an epic as a
   GitHub issue labelled `epic` (a goal, acceptance criteria, the paths it may
   touch). The swarm plans and builds it; do not edit the files of a task it
   is building.

Ask your owner before doing anything outside the task you claimed.
