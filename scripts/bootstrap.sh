#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SOURCE_DIR="$BASE_DIR/source"
RUNTIME_DIR="$BASE_DIR/runtime"
ENV_FILE="$BASE_DIR/.env"
REPO_URL="https://github.com/keshrath/agent-comm.git"

die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "node is required"
command -v npm >/dev/null 2>&1 || die "npm is required"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 20 )) || die "Node.js 20 or newer is required"

if ss -ltnH 2>/dev/null | awk '{print $4}' | grep -Eq '(^|:)3421$'; then
  ss -ltnp 2>/dev/null | sed -n '1,20p' >&2 || true
  die "TCP port 3421 is already in use; nothing was changed"
fi

mkdir -p "$RUNTIME_DIR/home/.agent-comm"

if [[ ! -d "$SOURCE_DIR/.git" ]]; then
  if [[ -e "$SOURCE_DIR" ]]; then
    die "$SOURCE_DIR exists but is not an agent-comm Git checkout"
  fi
  git clone --depth 1 "$REPO_URL" "$SOURCE_DIR"
fi

(
  cd "$SOURCE_DIR"
  npm ci
  npm run build
)

if [[ ! -f "$ENV_FILE" ]]; then
  TAILSCALE_IP=""
  if command -v tailscale >/dev/null 2>&1; then
    TAILSCALE_IP="$(tailscale ip -4 2>/dev/null | sed -n '1p' || true)"
  fi

  if [[ -n "$TAILSCALE_IP" ]]; then
    LISTEN_HOST="$TAILSCALE_IP"
    printf 'Detected Tailscale address: %s\n' "$TAILSCALE_IP"
  else
    LISTEN_HOST="127.0.0.1"
    printf 'Tailscale is not active; defaulting to localhost.\n'
  fi

  cat > "$ENV_FILE" <<EOF
AGENT_COMM_HOST=$LISTEN_HOST
AGENT_COMM_PORT=3421
AGENT_COMM_HOME=$RUNTIME_DIR/home
AGENT_COMM_DB=$RUNTIME_DIR/home/.agent-comm/agent-comm.db
AGENT_COMM_INDEX_JS=$SOURCE_DIR/dist/index.js
AGENT_COMM_MCP_HOST=$LISTEN_HOST
AGENT_COMM_MCP_PORT=3422
EOF
  chmod 600 "$ENV_FILE"
fi

printf '\nBootstrap complete. Files created only under:\n  %s\n\n' "$BASE_DIR"
printf 'Review %s, then test with:\n  bash %s/scripts/run.sh\n' "$ENV_FILE" "$BASE_DIR"

