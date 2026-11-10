// Owner administration from the dashboard (ARCHITECTURE 51): plan an epic, run intake,
// back up the store, manage tokens. The work itself (model call, GitHub, VACUUM INTO) is injected
// by the CLI as `ops`, so the API stays testable with fakes. Slow work runs as a job: the POST
// answers 202 with a job id and GET /operator/jobs/:id reports it. One job per kind at a time.
import { randomBytes } from 'node:crypto';
import { addManager, readTokens, writeTokens } from './tokens.mjs';

const MAX_JOBS = 50;

export function createJobs({ clock = Date } = {}) {
  const jobs = new Map(); // id -> { id, kind, status, startedAt, endedAt, result, error }
  const running = new Map(); // kind -> id
  const promises = new Map();
  return {
    start(kind, fn) {
      if (running.has(kind)) throw Object.assign(new Error(`${kind} is already running (job ${running.get(kind)})`), { status: 409 });
      const id = randomBytes(6).toString('hex');
      const job = { id, kind, status: 'running', startedAt: new Date(clock.now()).toISOString(), endedAt: null, result: null, error: null };
      jobs.set(id, job);
      running.set(kind, id);
      const p = Promise.resolve().then(fn).then(
        (result) => Object.assign(job, { status: 'done', result }),
        (err) => Object.assign(job, { status: 'failed', error: String(err?.message ?? err).slice(0, 500) }),
      ).finally(() => {
        job.endedAt = new Date(clock.now()).toISOString();
        running.delete(kind);
        for (const old of [...jobs.keys()].slice(0, Math.max(0, jobs.size - MAX_JOBS))) jobs.delete(old);
      });
      promises.set(id, p);
      return { ...job };
    },
    get: (id) => (jobs.has(id) ? { ...jobs.get(id) } : null),
    settled: (id) => promises.get(id) ?? Promise.resolve(),
  };
}

const NAME = /^[a-z][a-z0-9-]{0,63}$/;
const LOGIN = /^[A-Za-z0-9-]{1,39}$/;
export const TOKEN_ROLES = { manager: ['manager'], owner: ['manager', 'owner'], dashboard: ['dashboard'], intake: ['intake'] };

/** Token records for display: never the hash. */
export function listTokens(file) {
  return Object.entries(readTokens(file).managers ?? {}).map(([name, t]) => ({
    name, member: t.member, departments: t.departments ?? [], roles: t.roles ?? ['manager'], createdAt: t.createdAt ?? null,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Validates and adds a token; returns the raw token (shown once). Throws with .status 400/409. */
export function createToken(file, { name, member, departments = [], role = 'manager' }, knownDepartments) {
  const fail = (status, msg) => { throw Object.assign(new Error(msg), { status }); };
  if (!NAME.test(String(name ?? ''))) fail(400, 'name: lowercase letters, digits and dashes, starting with a letter');
  if (!LOGIN.test(String(member ?? ''))) fail(400, 'member must be a GitHub login');
  if (!TOKEN_ROLES[role]) fail(400, `role must be one of ${Object.keys(TOKEN_ROLES).join(', ')}`);
  if (!Array.isArray(departments) || departments.some((d) => !knownDepartments.includes(d))) fail(400, `departments must be some of ${knownDepartments.join(', ')}`);
  if (readTokens(file).managers?.[name]) fail(409, `token ${name} already exists`);
  return addManager(file, { name, member, departments, roles: TOKEN_ROLES[role] });
}

/** Removes a token. Refuses to remove the last owner token. */
export function revokeToken(file, name) {
  const data = readTokens(file);
  const record = data.managers?.[name];
  if (!record) throw Object.assign(new Error(`unknown token ${name}`), { status: 404 });
  const owners = Object.values(data.managers).filter((t) => (t.roles ?? []).includes('owner'));
  if ((record.roles ?? []).includes('owner') && owners.length <= 1) throw Object.assign(new Error('refusing to revoke the last owner token'), { status: 409 });
  delete data.managers[name];
  writeTokens(file, data);
}
