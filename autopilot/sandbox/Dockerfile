# Sandbox for autopilot jobs: one throwaway container per job, with only the
# repo clone, the agent CLI and the credentials passed in by the worker.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl python3 make g++ \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code @openai/codex @google/gemini-cli && npm cache clean --force

RUN useradd --create-home --uid 1001 agent
COPY entrypoint.sh /usr/local/bin/autopilot-entrypoint
USER agent
WORKDIR /home/agent
ENTRYPOINT ["/usr/local/bin/autopilot-entrypoint"]
