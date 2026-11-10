# Swarm runbook

Where things run (ARCHITECTURE 42, 43):

| Machine | Runs | Model calls |
| --- | --- | --- |
| Orchestrator machine (any tailnet device) | orchestrator: task API, review loop, planner, monitor, dispatcher, dashboard; nightly DB backup | yes, on the owner's own `claude` and `gh` logins |
| Server (server `<server>`) | bus (`agent-comm`, `agent-comm-mcp`), watchdog, copies of the orchestrator backups | none |
| Member machines | one manager per department, subagents in containers | yes, on each member's logins |

Nobody hard-codes the orchestrator's address. It publishes its URL on the bus (state `swarm/orchestrator`). Managers and the watchdog set to `bus` follow it, and a manager trusts a new address only after `/whoami` proves the server holds its token hash. Moving the orchestrator is therefore `export`, copy, `import`, `start` (section 3).

Human-review paths: `swarm/deploy/**` and `scripts/install-user-service.sh`.

## 0. swarmctl

`swarm/scripts/swarmctl help` lists everything. Main commands:

- `install orchestrator|manager|watchdog|dashboard|autodeploy`: copy the units, `npm ci`, write the env template. Starts nothing.
- `start|stop|restart|reboot [orchestrator|manager|watchdog|bus|all]`, `status`, `health`, `logs [-f]`, `doctor`.
- `backup [--nightly]`: DB backup, plus a copy to `SWARM_BACKUP_PUSH` when set.
- `upgrade`: backup, fast-forward pull, `npm ci`, restart, health check; rolls the code back to the old sha when `npm ci` or the restart fails, the orchestrator stays down, or (manager-only hosts) the manager is not active. `rollback <sha>`.
- `autodeploy`: fetch, and run `upgrade` when `origin/main` moved; a sha that failed is skipped until `main` moves (ARCHITECTURE 76). Run by `swarm-autodeploy.timer` on the server.
- `maintenance on [reason]|off|status`: the dashboard's maintenance banner on this machine (ARCHITECTURE 77). `upgrade` and `restart` of the dashboard set it by themselves and clear it once the dashboard answers `/health`; a failed upgrade leaves it on with the error, so clear it by hand after checking (`swarmctl --remote <server> maintenance off`). A flag set by hand is never cleared by them.
- `export <file>` / `import <file>`: move the orchestrator to another machine.
- `--remote <ssh-host> <command>` runs any of these on another machine.

It reads only non-secret keys from the env files (`SWARM_HOST`, `SWARM_PORT`, `SWARM_BUS_MCP_URL`, `SWARM_ORCH_URL`, `SWARM_BACKUP_PUSH`), never the token line.

## 1. Orchestrator (orchestrator machine, first install)

Needs: Node 22.13+, Tailscale, `claude` logged in, `gh` installed.

1. Any checkout works: `swarmctl install` writes the units pointing at the checkout it runs from, and at the real path of `~/.swarm` (it may be a symlink into the checkout's gitignored `.swarm/`). On a branch, `swarmctl upgrade` fast-forwards it instead of detaching HEAD. A separate clone such as `~/swarm-app/repo` works well.
2. `~/swarm-app/repo/swarm/scripts/swarmctl install orchestrator`. This writes `~/.config/swarm/orchestrator.env` (mode 0600) with this machine's Tailscale address and a `PATH` line, so the service finds `node`, `claude` and `gh`.
3. Token: a fine-grained token for `<owner>/<repo>` only (Contents rw, Pull requests rw, Checks r, Actions r). Uncomment `GH_TOKEN=` in the env file and paste it there. Never in the repo, a flag, or a container.
4. Optional off-machine backups: set `SWARM_BACKUP_PUSH=<owner>@<server>:backups/swarm/` in the env file (ssh key login; create the folder on the server once).
5. Manager tokens: `cd ~/swarm-app/repo/swarm && node orchestrator/bin/orchestrator.mjs token add <name> --member <login> --departments core,runtime`. The raw token is shown once. `~/.swarm/managers.json` stays mode 0600.
6. `swarmctl doctor` (every line `ok`), then `swarmctl start orchestrator`.
7. Check: `swarmctl status` shows the orchestrator `ok`. The log line `location http://<ip>:3423 published on the bus` confirms the address is shared. Dashboard: `http://<ip>:3423/dashboard`.

Tailscale ACL: members' managers must reach the orchestrator machine on `tcp:3423` (README, ACL example; add the machine next to the server).

The service runs with a read-only system and home, except `~/.swarm` and the state the `claude` and `gh` CLIs write (`~/.claude`, `~/.claude.json`, `~/.cache`, `~/.config/gh`, `~/.local/state`). Planning stays manual unless you start with `--plan-cmd`: run `node orchestrator/bin/orchestrator.mjs plan E-0001 --plan-cmd "claude -p --output-format text"` when you want an epic planned.

When the machine sleeps or is off, the swarm pauses: managers keep polling, running leases expire and retry, and the watchdog posts `orchestrator DOWN` on `swarm`.

## 2. Server (server): watchdog

1. `git clone git@github.com:<owner>/<repo>.git ~/swarm-app/repo` (read-only deploy key).
2. `~/swarm-app/repo/swarm/scripts/swarmctl install watchdog` (env `~/.config/swarm/watchdog.env`, default `SWARM_ORCH_URL=bus`), then `swarmctl start watchdog`.
3. Every 2 min it checks the orchestrator and posts to `swarm` only when it goes down or comes back. No token, no model.
4. Backup copies land in `~/backups/swarm/` when the orchestrator sets `SWARM_BACKUP_PUSH`. Prune by hand.

The bus itself stays as installed by `scripts/install-user-service.sh` (`swarmctl restart bus` restarts it).

## 2b. Server (server): dashboard

1. On the orchestrator machine: `node orchestrator/bin/orchestrator.mjs token add server-dashboard --member <owner login> --dashboard`. Copy the raw token.
2. On the server: `install -m 600 /dev/stdin ~/.swarm/dashboard.token`, paste, Ctrl-D.
3. `~/swarm-app/repo/swarm/scripts/swarmctl install dashboard`. Check `~/.config/swarm/dashboard.env`: `DASH_HOST` is the server Tailscale address, `DASH_TOKEN_NAME` matches step 1.
4. Accounts (ARCHITECTURE 54): for each person, put their member token in a temporary file and run `node dashboard/bin/dashboard.mjs user add <name> --token-file <file>`; type their password (10+ characters), then delete the file. `user list` and `user remove <name>` manage the rest.
5. `swarmctl start dashboard`, then open `http://<server-ip>:3424` and sign in with the user name and password.
6. Tailscale ACL: members need `tcp:3424` on the server.
7. Auto-deploy (ARCHITECTURE 76): `swarmctl install autodeploy && swarmctl start autodeploy`. Every 5 minutes it upgrades the server to `origin/main` when `main` moved, so merged pull requests go live without the owner. Check with `swarmctl status` and `swarmctl logs autodeploy`. A failed sha is kept in `~/.swarm/autodeploy-failed` and skipped until the next merge; delete the file to retry it. Pause with `swarmctl stop autodeploy`.

Controls: actions go to the orchestrator with the viewer's own token. Give yourself an owner token for full control: `node orchestrator/bin/orchestrator.mjs token add <name> --member <login> --owner`. Members use their manager tokens and can act on their own managers and tasks. The dashboard keeps the last snapshot and shows an "offline since" banner while the orchestrator machine is off.

Chat (ARCHITECTURE 72): `/chat` keeps its history in `DASH_CHAT_DIR` (default `~/.swarm/dashboard-chat/`, mode 0700). Nothing backs it up automatically; back it up by hand on the server with `mkdir -p ~/backups && tar -czf ~/backups/dashboard-chat-$(date +%F).tgz -C ~/.swarm dashboard-chat`. Restore by stopping the dashboard, extracting the archive into `~/.swarm`, and starting it again.

Agent cockpit (ARCHITECTURE 73): upgrade in dependency order — orchestrator first, then each manager, then the server dashboard. Keep `SWARM_AGENT_COCKPIT` unset or `0` during the upgrade; after the orchestrator and at least one manager report healthy, set `SWARM_AGENT_COCKPIT=1` and `DASH_AGENT_CACHE_FILE=~/.swarm/dashboard-agents.json` in `dashboard.env`, then restart the dashboard. Open `/agents` and verify the owner can select the orchestrator, see a redacted feed, prompt it, select a manager/subagent, open Context, and queue a reasoned safe command. Dangerous interrupt/stop controls must require the owner role and a reason.

The bridge cache is mode 0600 and contains no prompt, response, command, goal or token material. If it is corrupt, stop the dashboard, move `DASH_AGENT_CACHE_FILE` aside for recovery, start the dashboard with the feature flag disabled, then enable it again once the orchestrator is healthy; the bridge will repopulate the summary. If a directive is stale or the manager is too old to understand it, cancel it from the orchestrator store/API, leave the assignment read-only, and upgrade that manager before retrying. To roll back, disable `SWARM_AGENT_COCKPIT`, restart the dashboard, and run `swarmctl rollback <sha>` in the normal order; the cockpit's SQLite tables are additive and the prior dashboard remains usable.

## 3. Move the orchestrator to another machine

1. New machine: Node 22.13+, Tailscale, `claude` and `gh` logged in, clone to `~/swarm-app/repo`, `npm ci --ignore-scripts` in `swarm/`.
2. Old machine: `~/swarm-app/repo/swarm/scripts/swarmctl export ~/swarm-move.tgz`. This stops the orchestrator and packs the DB, the manager token hashes and the env file. The file holds the GitHub token: mode 0600, copy it only over ssh or Tailscale (`scp ~/swarm-move.tgz <new>:`).
3. Old machine: `systemctl --user disable swarm-orchestrator.service swarm-backup.timer`. Only one orchestrator may run.
4. New machine: `swarmctl import ~/swarm-move.tgz`. This installs the units and writes the env with the new Tailscale address and `PATH`, keeping `GH_TOKEN`, port, bus URL and backup target. Then `swarmctl doctor && swarmctl start orchestrator`.
5. Delete `~/swarm-move.tgz` on both machines.
6. Managers with `--url bus` find the new address within one poll and log `orchestrator moved to ...`. The watchdog follows on its next run. Managers set to a fixed `--url` need a new `manager init`.

## 4. Managers on member machines

1. Same clone at `~/swarm-app/repo`, `npm ci --ignore-scripts` in `swarm/`.
2. Save the manager token in a file, mode 0600 (`install -m 600 /dev/stdin ~/.swarm/manager.token`, paste, Ctrl-D).
3. `node manager/bin/manager.mjs init --url bus --bus-url http://<server-ip>:3422/mcp --name <agent> --member <login> --department <dept> --token-file ~/.swarm/manager.token --repo-dir ~/swarm-app/repo --checks swarm/scripts/checks.sh --subagent-runtime container`. With `--url bus` the manager follows the orchestrator wherever it runs. The bus URL also lets the orchestrator wake the manager when work is queued (ARCHITECTURE 41).
4. Sandbox image: `podman build -t swarm-subagent:1 ~/swarm-app/repo/swarm/sandbox`.
5. `swarmctl install manager`, `swarmctl doctor`, `swarmctl start manager`.

Never start a manager with `--subagent-runtime host` on a shared machine: host runs can read the user's home directory.

## 5. Upgrade

The server upgrades itself every 5 minutes (section 2b step 7). `swarmctl upgrade` on each other machine. By hand: `git -C ~/swarm-app/repo pull --ff-only`, `npm ci --ignore-scripts` in `swarm/`, `swarmctl restart`. Store migrations run on start (`PRAGMA user_version`); `upgrade` takes a backup first.

## 6. Rollback

1. `swarmctl rollback <previous-sha>` (checks out and runs `npm ci` first, leaving the services running if that fails; refuses a dirty tree; then stops and starts).
2. If a migration broke the DB: stop the orchestrator, copy the newest backup from `~/.swarm/backups/` over `~/.swarm/swarm.db` (keep the broken file), start, `swarmctl doctor`.

## 7. Backup

- Nightly by `swarm-backup.timer` at 03:17 (catches up after downtime): `~/.swarm/backups/swarm-YYYYMMDD-HHMMSS.db`, plus a copy to `SWARM_BACKUP_PUSH` when set.
- Manual: `swarmctl backup`. Backups never overwrite. Nothing is deleted automatically.

## 8. Stop everything

- Orchestrator machine: `swarmctl stop orchestrator`.
- Managers: `swarmctl stop manager` on each member machine. Their running tasks expire after `leaseMinutes` and retry (attempt spent).
- Server: `swarmctl stop watchdog`.

## 9. What to watch

- `swarm` on the bus: monitor alerts (manager_down, stalled, budget, main_red), dispatcher alerts, watchdog up/down, the daily summary.
- Dashboard `/dashboard` on the orchestrator machine: queue depth, leases, over-budget tasks, review rounds.
