// One ordering rule for queued work, used by the store (lease) and the
// router (queue view): priority, then epic age, then task age, then id.

export const PRIORITY_RANK = { p0: 0, p1: 1, p2: 2, p3: 3 };

/** Comparator for queued tasks. epicAge maps epic id -> createdAt ISO string. */
export function compareQueued(epicAge) {
  return (a, b) =>
    PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || epicAge.get(a.epicId).localeCompare(epicAge.get(b.epicId))
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id);
}
