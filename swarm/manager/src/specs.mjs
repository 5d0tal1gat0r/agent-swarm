// Department manager specs (swarm/managers/<department>.md). The manager
// hands its department's spec to every subagent; lintSpecs keeps the files complete
// and their Owns globs equal to departments.yaml.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const SPEC_SECTIONS = [
  'Owns',
  'Typical tasks',
  'Workflow',
  'Tools allowed',
  'Checks before submit',
  'Contracts and human review',
  'Never',
  'Escalation',
];

/** The spec text for a department, or null when the file does not exist. */
export function readSpec(managersDir, department) {
  const file = path.join(managersDir, `${department}.md`);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** Globs listed in the Owns section as lines of the form - `glob`. */
export function ownsGlobs(text) {
  const start = text.indexOf('## Owns');
  if (start === -1) return [];
  const rest = text.slice(start + '## Owns'.length);
  const end = rest.search(/^## /m);
  return [...(end === -1 ? rest : rest.slice(0, end)).matchAll(/^- `([^`]+)`\s*$/gm)].map((m) => m[1]);
}

/** Problems as strings; [] when every department has a complete spec. */
export function lintSpecs({ managersDir, departments }) {
  const problems = [];
  for (const [id, dept] of Object.entries(departments.departments)) {
    const text = readSpec(managersDir, id);
    if (text === null) {
      problems.push(`${id}: no file managers/${id}.md`);
      continue;
    }
    const positions = SPEC_SECTIONS.map((s) => text.search(new RegExp(`^## ${s}\\s*$`, 'm')));
    const missing = SPEC_SECTIONS.filter((_, i) => positions[i] === -1);
    for (const s of missing) problems.push(`${id}: missing section "## ${s}"`);
    if (missing.length) continue;
    if (positions.some((p, i) => i > 0 && p < positions[i - 1])) problems.push(`${id}: sections out of order (expected ${SPEC_SECTIONS.join(', ')})`);
    const listed = ownsGlobs(text);
    for (const g of listed) if (!dept.paths.includes(g)) problems.push(`${id}: Owns lists ${g} which departments.yaml does not have`);
    for (const g of dept.paths) if (!listed.includes(g)) problems.push(`${id}: Owns is missing ${g} from departments.yaml`);
  }
  return problems;
}
