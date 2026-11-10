# Subagent sandbox. One throwaway container per subagent run:
# the worktree at /work and only the auth file of the CLI being run (mounted
# read-only at run time). No GitHub token, no gh CLI, no docker socket.
FROM node:22-bookworm-slim

ARG CLAUDE_CODE_VERSION=2.1.312
ARG CODEX_VERSION=0.165.0
ARG GEMINI_CLI_VERSION=0.66.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
      @google/gemini-cli@${GEMINI_CLI_VERSION} \
 && npm cache clean --force

# Fixed uid matches the host's --user mapping (podman --userns=keep-id). HOME is writable: the CLIs keep config there, and it is discarded with the container.
RUN useradd --create-home --uid 1001 agent \
 && mkdir -p /work && chmod 1777 /work
ENV HOME=/home/agent
USER agent
WORKDIR /work
