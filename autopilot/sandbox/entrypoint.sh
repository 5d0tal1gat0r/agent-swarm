#!/usr/bin/env bash
# Runs inside the sandbox. Inputs (from the worker):
#   env:   REPO, MEMBER, AGENT (claude|codex|gemini), JOB_KIND, MODEL (optional), PR (optional),
#          BUS_MCP_URL, GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN (claude only)
#   /job:  prompt.md, mcp.json, codex-auth.json (codex only), gemini-auth.json (gemini only)
set -Eeuo pipefail

gh auth setup-git
git config --global user.name "$MEMBER (autopilot)"
git config --global user.email "$MEMBER@users.noreply.github.com"

git clone --quiet "https://github.com/$REPO.git" work
cd work
if [[ -n "${PR:-}" ]]; then
  gh pr checkout "$PR" --repo "$REPO"
fi

case "$AGENT" in
  claude)
    model=()
    if [[ -n "${MODEL:-}" ]]; then model=(--model "$MODEL"); fi
    exec claude -p "$(cat /job/prompt.md)" \
      --dangerously-skip-permissions \
      --mcp-config /job/mcp.json \
      --output-format text \
      "${model[@]}"
    ;;
  codex)
    mkdir -p "$HOME/.codex"
    cp /job/codex-auth.json "$HOME/.codex/auth.json"
    model=()
    if [[ -n "${MODEL:-}" ]]; then model=(-m "$MODEL"); fi
    exec codex exec \
      --dangerously-bypass-approvals-and-sandbox \
      -c "mcp_servers.agent-comm.url=\"$BUS_MCP_URL\"" \
      "${model[@]}" \
      "$(cat /job/prompt.md)"
    ;;
  gemini)
    mkdir -p "$HOME/.gemini"
    cp /job/gemini-auth.json "$HOME/.gemini/oauth_creds.json"
    node -e 'require("fs").writeFileSync(process.env.HOME + "/.gemini/settings.json", JSON.stringify({ mcpServers: { "agent-comm": { httpUrl: process.argv[1] } } }))' "$BUS_MCP_URL"
    model=()
    if [[ -n "${MODEL:-}" ]]; then model=(-m "$MODEL"); fi
    exec gemini -p "$(cat /job/prompt.md)" \
      --yolo \
      --skip-trust \
      -o text \
      "${model[@]}"
    ;;
  *)
    echo "unknown AGENT: $AGENT" >&2
    exit 2
    ;;
esac
