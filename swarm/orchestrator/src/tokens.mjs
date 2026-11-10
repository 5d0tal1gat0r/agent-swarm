// Manager tokens. Only SHA-256 hashes are stored (file mode 0600). The raw
// token is shown once, when it is created. Checks use constant-time compare.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// dashboard: read-only (GET /snapshot, /tasks/:id/history, /me, /metrics), for the server dashboard.
// owner: every dashboard control; given with token add --owner, next to manager.
const ROLES = new Set(['manager', 'intake', 'dashboard', 'owner']);

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function readTokens(file) {
  if (!existsSync(file)) return { managers: {} };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data || typeof data.managers !== 'object') throw new Error(`${file}: expected { "managers": {...} }`);
  return data;
}

export function writeTokens(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Adds a manager and returns its raw token. The raw token is not stored. */
export function addManager(file, { name, member, departments, roles = ['manager'] }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error('manager name must be lowercase letters, digits and dashes');
  if (!/^[A-Za-z0-9-]+$/.test(member)) throw new Error('member must be a GitHub login');
  for (const r of roles) if (!ROLES.has(r)) throw new Error(`unknown role ${r}`);
  const data = readTokens(file);
  if (data.managers[name]) throw new Error(`manager ${name} already exists`);
  const token = randomBytes(32).toString('base64url');
  data.managers[name] = { member, departments, roles, hash: hashToken(token), createdAt: new Date().toISOString() };
  writeTokens(file, data);
  return token;
}

/** Returns the manager record for a bearer token, or null. */
export function authenticate(data, bearer) {
  if (typeof bearer !== 'string' || bearer.length === 0) return null;
  const digest = Buffer.from(hashToken(bearer), 'hex');
  for (const [name, record] of Object.entries(data.managers)) {
    const stored = Buffer.from(record.hash, 'hex');
    if (stored.length === digest.length && timingSafeEqual(stored, digest)) return { name, ...record };
  }
  return null;
}

export function tokenFileProblems(file) {
  if (!existsSync(file)) return [];
  const mode = statSync(file).mode & 0o777;
  return mode === 0o600 ? [] : [`${file} must be mode 0600 (is ${mode.toString(8)})`];
}
