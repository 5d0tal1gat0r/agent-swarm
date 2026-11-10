#!/usr/bin/env bash
set -Eeuo pipefail

BASE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
USER_HOME="$(getent passwd "$(id -u)" | cut -d: -f6)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$USER_HOME/.config}/systemd/user"
SERVICE_FILE="$CONFIG_DIR/agent-comm.service"
BRIDGE_FILE="$CONFIG_DIR/agent-comm-mcp.service"
NODE_BIN="$(command -v node)"

[[ -f "$BASE_DIR/.env" ]] || {
  printf 'Run scripts/bootstrap.sh first.\n' >&2
  exit 1
}

mkdir -p "$CONFIG_DIR"

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Private multi-agent coordination bus
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$BASE_DIR/runtime
EnvironmentFile=$BASE_DIR/.env
ExecStart=$NODE_BIN $BASE_DIR/source/dist/server.js --port \${AGENT_COMM_PORT} --db \${AGENT_COMM_DB}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

cat > "$BRIDGE_FILE" <<EOF
[Unit]
Description=agent-comm MCP HTTP bridge for remote agents
After=network-online.target agent-comm.service

[Service]
Type=simple
WorkingDirectory=$BASE_DIR/runtime
EnvironmentFile=$BASE_DIR/.env
ExecStart=$NODE_BIN $BASE_DIR/scripts/mcp-bridge.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable agent-comm.service agent-comm-mcp.service
systemctl --user restart agent-comm.service agent-comm-mcp.service

printf 'Installed and started user services:\n  %s\n  %s\n' "$SERVICE_FILE" "$BRIDGE_FILE"
systemctl --user --no-pager --full status agent-comm.service agent-comm-mcp.service | sed -n '1,40p'
