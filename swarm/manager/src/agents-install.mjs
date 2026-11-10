// Subagent role files (swarm/agents/*.md). Each file has YAML frontmatter with
// name, description, model and tools. Lint checks the model against the policy
// allow-list and rejects git write instructions. Install copies the files to a
// Claude Code agents folder (.claude/agents/ in the repo is gitignored).
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const GIT_WRITE = /\bgit\s+(push|commit|merge|rebase|reset|tag)\b|\bgh\s+pr\s+(create|merge|review)\b|--force\b/i;

export function parseAgentFile(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error('missing frontmatter');
  return { meta: parse(m[1]) ?? {}, body: m[2].trim() };
}

/** Problems with one role file. Empty array means it passes. */
export function lintAgent({ file, meta, body }, allowedModels) {
  const problems = [];
  const expectName = path.basename(file, '.md');
  if (meta.name !== expectName) problems.push(`name "${meta.name}" must match file name "${expectName}"`);
  if (typeof meta.description !== 'string' || meta.description.trim() === '') problems.push('description is required');
  if (!allowedModels.includes(meta.model)) problems.push(`model "${meta.model}" is not on the allow-list`);
  if (typeof meta.tools !== 'string' || meta.tools.trim() === '') problems.push('tools is required');
  if (GIT_WRITE.test(body)) problems.push('body gives git write instructions; the manager commits and pushes');
  if (body === '') problems.push('body is empty');
  return problems.map((p) => `${file}: ${p}`);
}

/** Reads and lints every role file in srcDir. Throws listing all problems. */
export function loadAgents(srcDir, allowedModels) {
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.md')).sort();
  const agents = [];
  const problems = [];
  for (const file of files) {
    const text = readFileSync(path.join(srcDir, file), 'utf8');
    try {
      const parsed = { file, ...parseAgentFile(text) };
      problems.push(...lintAgent(parsed, allowedModels));
      agents.push(parsed);
    } catch (err) {
      problems.push(`${file}: ${err.message}`);
    }
  }
  if (problems.length) throw new Error(`agent files failed lint:\n  - ${problems.join('\n  - ')}`);
  return agents;
}

/** Copies the lint-clean role files to destDir, the Claude Code agents folder. */
export function installAgents({ srcDir, destDir, allowedModels }) {
  const agents = loadAgents(srcDir, allowedModels);
  mkdirSync(destDir, { recursive: true, mode: 0o700 });
  for (const { file } of agents) copyFileSync(path.join(srcDir, file), path.join(destDir, file));
  return agents.map((a) => a.file);
}
