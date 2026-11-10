// Routing rules from the spec, applied in order:
//  1. A task's paths belong to the one department that owns all of them.
//  2. Paths spanning departments split into groups. Contract paths (matching
//     the `contracts` globs) form contract groups; each work group depends on
//     all contract groups. Without contract paths the groups are independent.
//  3. A path no department owns goes to `platform` and raises alert.unowned_path.
//  4. Parallelism inside a department is the manager's job (not decided here).
import { matchGlob } from '../../shared/globs.mjs';

export const UNOWNED_DEPARTMENT = 'platform';

export function ownerOf(departments, file) {
  for (const [id, dept] of Object.entries(departments.departments)) {
    if (dept.paths.some((g) => matchGlob(g, file))) return id;
  }
  return null;
}

/**
 * Plan the department groups for one task's paths.
 * Returns { groups: [{department, kind, paths, dependsOnContract}], alerts: [...] }.
 * kind is 'contract' or 'work'. A contract group never depends on another group.
 */
export function routePaths(departments, paths) {
  if (!Array.isArray(paths) || paths.length === 0) throw new Error('a task needs at least one path');
  const alerts = [];
  const byKey = new Map();
  for (const file of paths) {
    let department = ownerOf(departments, file);
    if (department === null) {
      department = UNOWNED_DEPARTMENT;
      alerts.push({ type: 'alert.unowned_path', department, path: file });
    }
    const isContract = departments.contracts.some((g) => matchGlob(g, file));
    const kind = isContract ? 'contract' : 'work';
    const key = `${kind}|${department}`;
    if (!byKey.has(key)) byKey.set(key, { department, kind, paths: [], dependsOnContract: kind === 'work' });
    byKey.get(key).paths.push(file);
  }
  const groups = [...byKey.values()];
  const contractGroups = groups.filter((g) => g.kind === 'contract');
  const workGroups = groupsWithDependency(groups, contractGroups);
  return { groups: [...contractGroups, ...workGroups], alerts };
}

function groupsWithDependency(groups, contractGroups) {
  return groups
    .filter((g) => g.kind === 'work')
    .map((g) => ({ ...g, dependsOnContract: contractGroups.length > 0 }));
}

/** The queue view for a department: queued tasks in lease order. */
export function queueView(store, department) {
  return store.queueOf(department);
}
