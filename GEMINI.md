# Instructions for Gemini

Read and follow `AGENTS.md` before doing anything else; it applies to you
exactly as to every other agent here. The import below loads it.

@AGENTS.md

In short, at the start of every session:

1. Call `comm_register` (agent-comm MCP server) with a name like
   `<github-user>-gemini` and `channels: ["general"]`.
2. Call `comm_inbox`, then announce in `general` what you will work on.
