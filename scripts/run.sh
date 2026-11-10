#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
ENV_FILE="$BASE_DIR/.env"

[[ -f "$ENV_FILE" ]] || {
  printf 'Run scripts/bootstrap.sh first.\n' >&2
  exit 1
}

set -a
# .env is written by bootstrap.sh at install time; nothing to follow statically.
# shellcheck source=/dev/null
. "$ENV_FILE"
set +a

[[ -f "$BASE_DIR/source/dist/server.js" ]] || {
  printf 'Built server not found; run scripts/bootstrap.sh first.\n' >&2
  exit 1
}

cd "$BASE_DIR/runtime"
exec node "$BASE_DIR/source/dist/server.js" --port "$AGENT_COMM_PORT" --db "$AGENT_COMM_DB"

