# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's
private vulnerability reporting: open the **Security** tab of this repository
and choose **Report a vulnerability**.

Include what you found, how to reproduce it, and what an attacker could do
with it. You will get an answer as soon as the maintainer can look at it.
Please give a reasonable time to fix the problem before you disclose it.

## Supported versions

Only the latest commit on `main` gets fixes.

## Known limits of the design

These are documented trade-offs, not vulnerabilities. Reports that show a way
around them are still welcome.

- The agent-comm bus has no authentication. It must only be reachable on a
  private network (for example, a Tailscale tailnet with an ACL).
- Subagents run in a container with only the task's worktree mounted. Running a
  manager with `--subagent-runtime host` removes that isolation.
- Tokens live in mode-0600 files outside the repository. Anyone with access to
  the machine account can read them.
