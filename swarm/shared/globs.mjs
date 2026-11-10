// Path globs for department ownership. `*` matches within one path segment,
// `**` as a whole segment matches any number of segments (zero or more).
// Overlap is decided exactly: two globs overlap if some path matches both.

const SEGMENT_CHARS = /^[^/]*$/;

export function splitGlob(glob) {
  if (typeof glob !== 'string' || glob.length === 0) throw new Error('glob must be a non-empty string');
  if (glob.startsWith('/') || glob.split('/').includes('..')) throw new Error(`glob must stay inside the repo: ${glob}`);
  const segments = glob.split('/');
  for (const seg of segments) {
    if (seg === '**') continue;
    if (!SEGMENT_CHARS.test(seg) || seg.includes('**')) throw new Error(`"**" must be a whole path segment: ${glob}`);
  }
  return segments;
}

/** Does a single path match the glob? */
export function matchGlob(glob, path) {
  return matchSegments(splitGlob(glob), path.split('/'));
}

function matchSegments(g, p) {
  if (g.length === 0) return p.length === 0;
  if (g[0] === '**') return matchSegments(g.slice(1), p) || (p.length > 0 && matchSegments(g, p.slice(1)));
  if (p.length === 0) return false;
  return segmentMatches(g[0], p[0]) && matchSegments(g.slice(1), p.slice(1));
}

function segmentMatches(pattern, text) {
  return intersects(pattern, text) && wildcardMatch(pattern, text);
}

function wildcardMatch(pattern, text) {
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('[^/]*')}$`);
  return re.test(text);
}

function escapeRe(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Do two single-segment wildcard patterns share at least one string?
 * Product-automaton search over the two patterns; `*` matches any character
 * except `/`. The sentinel `x` stands for any character that is not literal
 * in either pattern.
 */
export function intersects(a, b) {
  const literals = new Set([...`${a}${b}`].filter((c) => c !== '*'));
  const alphabet = [...literals, '\u0000'];
  const closure = (pat, i) => {
    const out = [i];
    while (pat[out[out.length - 1]] === '*') out.push(out[out.length - 1] + 1);
    return out;
  };
  const step = (pat, i, c) => {
    const next = [];
    if (pat[i] === '*') next.push(i);
    else if (i < pat.length && (pat[i] === c || c === '\u0000')) {
      if (c === '\u0000' && pat[i] !== '*') return next;
      next.push(i + 1);
    }
    return next;
  };
  const seen = new Set();
  const queue = [[0, 0]];
  seen.add('0,0');
  while (queue.length) {
    const [i0, j0] = queue.shift();
    for (const i of closure(a, i0)) {
      for (const j of closure(b, j0)) {
        if (i === a.length && j === b.length) return true;
        for (const c of alphabet) {
          for (const ni of step(a, i, c)) {
            for (const nj of step(b, j, c)) {
              const key = `${ni},${nj}`;
              if (!seen.has(key)) {
                seen.add(key);
                queue.push([ni, nj]);
              }
            }
          }
        }
      }
    }
  }
  return false;
}

function segmentsOverlap(a, b) {
  if (a.length === 0) return b.every((s) => s === '**');
  if (a[0] === '**') return segmentsOverlap(a.slice(1), b) || (b.length > 0 && segmentsOverlap(a, b.slice(1)));
  if (b.length === 0) return false;
  if (b[0] === '**') return segmentsOverlap(a, b.slice(1)) || segmentsOverlap(a.slice(1), b);
  return intersects(a[0], b[0]) && segmentsOverlap(a.slice(1), b.slice(1));
}

/** True if some path matches both globs. */
export function overlaps(globA, globB) {
  return segmentsOverlap(splitGlob(globA), splitGlob(globB));
}

/** Files matched by no glob in the list. */
export function unmatched(globs, files) {
  return files.filter((f) => !globs.some((g) => matchGlob(g, f)));
}
