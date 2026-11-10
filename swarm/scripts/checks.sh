#!/usr/bin/env bash
# Department checks a manager runs in a task worktree before it opens a PR (`manager init --checks
# swarm/scripts/checks.sh`). Run from the worktree root. Same gates as CI's `check` job.
set -Eeuo pipefail
cd "$(dirname -- "${BASH_SOURCE[0]}")/../.."
(cd swarm && npm ci --ignore-scripts --silent --no-audit --no-fund && npm test)
(cd autopilot && node --test 'test/*.test.mjs')
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck swarm/scripts/swarmctl swarm/scripts/checks.sh scripts/*.sh
else
  echo "checks: shellcheck not installed; CI runs it"
fi
