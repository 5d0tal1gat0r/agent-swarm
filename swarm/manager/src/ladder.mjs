// Escalation ladder: attempt 0 uses the first (cheapest) model; each retry
// moves one step up; the last step is kept. Model ids are checked against the
// policy allow-list before any agent runs.
export const DEFAULT_LADDER = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'];

export function assertLadder(ladder, allowedModels) {
  if (!Array.isArray(ladder) || ladder.length === 0) throw new Error('ladder must be a non-empty array');
  for (const id of ladder) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new Error(`ladder model id is malformed: ${JSON.stringify(id)}`);
    if (!allowedModels.includes(id)) throw new Error(`ladder model not on the allow-list: ${id}`);
  }
  return ladder;
}

/** Model for a task that has already spent `attempts` attempts. */
export function modelForAttempt(ladder, attempts) {
  if (!Number.isInteger(attempts) || attempts < 0) throw new Error('attempts must be a non-negative integer');
  return ladder[Math.min(attempts, ladder.length - 1)];
}

/** Default ladders per agent kind. Codex has none: its ids are the owner's pick, so the config must set one. */
export const DEFAULT_LADDERS = {
  claude: DEFAULT_LADDER,
  gemini: ['gemini-2.5-flash-lite', 'gemini-3-flash-preview'],
  codex: ['gpt-5.6-luna'], // owner pick: one step until more ids are allowed
  antigravity: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
};

export function ladderFor(kind, configured) {
  if (configured) return configured;
  if (DEFAULT_LADDERS[kind]) return DEFAULT_LADDERS[kind];
  throw new Error(`no default escalation ladder for ${kind}; set ladder in the manager config`);
}
