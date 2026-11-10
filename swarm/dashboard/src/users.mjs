// Dashboard users (password login, ARCHITECTURE 54). People sign in with a name and a password;
// the file maps each name to a scrypt hash and the member's own orchestrator token, which the
// dashboard uses for that person's reads and actions (the orchestrator still checks the role).
// The file lives on the dashboard machine, mode 0600; it holds tokens, never plain passwords.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { NOTIFICATION_KINDS } from './notifications.mjs';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const MIN_PASSWORD = 10;
const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const CHANNEL = /^[a-z][a-z0-9-]{0,23}$/;
const EVENT_ID = /^[A-Za-z0-9:_-]{1,200}$/;

export function hashPassword(password, salt = randomBytes(16)) {
  const key = scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [kind, n, saltHex, keyHex] = String(stored ?? '').split('$');
  if (kind !== 'scrypt' || !saltHex || !keyHex) return false;
  const want = Buffer.from(keyHex, 'hex');
  const got = scryptSync(String(password), Buffer.from(saltHex, 'hex'), want.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p });
  return got.length === want.length && timingSafeEqual(got, want);
}

export function readUsers(file) {
  if (!existsSync(file)) return { users: {} };
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} must not be readable by others (mode ${mode.toString(8)}, want 600)`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return { users: data.users ?? {} };
}

function writeUsers(file, data) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const defaultNotifications = () => ({ kinds: Object.fromEntries(NOTIFICATION_KINDS.map((kind) => [kind, true])), channels: [], readThrough: null });
const normalizedNotifications = (value) => {
  const defaults = defaultNotifications();
  const kinds = value?.kinds && typeof value.kinds === 'object' && !Array.isArray(value.kinds)
    ? Object.fromEntries(Object.entries(value.kinds).filter(([kind, enabled]) => NOTIFICATION_KINDS.includes(kind) && typeof enabled === 'boolean'))
    : {};
  const channels = Array.isArray(value?.channels) ? [...new Set(value.channels.filter((channel) => CHANNEL.test(channel)))].slice(0, 50) : [];
  const readThrough = typeof value?.readThrough === 'string' && EVENT_ID.test(value.readThrough) ? value.readThrough : null;
  return { kinds: { ...defaults.kinds, ...kinds }, channels, readThrough };
};

export function readNotifications(file, name) {
  const user = readUsers(file).users[name];
  if (!user) throw new Error(`no user ${name}`);
  return normalizedNotifications(user.notifications);
}

export function updateNotificationPreferences(file, name, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('notification preferences must be an object');
  if (patch.kinds !== undefined && (!patch.kinds || typeof patch.kinds !== 'object' || Array.isArray(patch.kinds))) throw new Error('notification kinds must be an object');
  if (patch.channels !== undefined && (!Array.isArray(patch.channels) || patch.channels.some((channel) => typeof channel !== 'string' || !CHANNEL.test(channel)))) throw new Error('notification channels are invalid');
  const data = readUsers(file);
  const user = data.users[name];
  if (!user) throw new Error(`no user ${name}`);
  data.users[name] = { ...user, notifications: normalizedNotifications({ ...user.notifications, ...patch }) };
  writeUsers(file, data);
  return data.users[name].notifications;
}

export function markNotificationsRead(file, name, eventId) {
  if (typeof eventId !== 'string' || !EVENT_ID.test(eventId)) throw new Error('notification event id is invalid');
  const data = readUsers(file);
  const user = data.users[name];
  if (!user) throw new Error(`no user ${name}`);
  data.users[name] = { ...user, notifications: { ...normalizedNotifications(user.notifications), readThrough: eventId } };
  writeUsers(file, data);
  return data.users[name].notifications;
}

/** Adds or replaces a user. The token is the member's orchestrator token (manager or owner role). */
export function setUser(file, { name, password, token }) {
  if (!NAME.test(String(name ?? ''))) throw new Error('user name: lowercase letters, digits, - and _, starting with a letter');
  if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(String(token ?? ''))) throw new Error('token looks wrong (expected the raw orchestrator token)');
  const data = readUsers(file);
  data.users[name] = { hash: hashPassword(password), token, updatedAt: new Date().toISOString() };
  writeUsers(file, data);
}

/** Replaces a user's password and keeps the stored token. */
export function setPassword(file, name, password) {
  if (String(password ?? '').length < MIN_PASSWORD) throw new Error(`password must be at least ${MIN_PASSWORD} characters`);
  const data = readUsers(file);
  const u = data.users[name];
  if (!u) throw new Error(`no user ${name}`);
  data.users[name] = { ...u, hash: hashPassword(password), updatedAt: new Date().toISOString() };
  writeUsers(file, data);
}

/** A signed-in user's own change: true when the current password matched and the new one is saved. */
export function changePassword(file, name, current, next) {
  if (!checkLogin(file, name, current)) return false;
  setPassword(file, name, next);
  return true;
}

export function removeUser(file, name) {
  const data = readUsers(file);
  if (!data.users[name]) throw new Error(`no user ${name}`);
  delete data.users[name];
  writeUsers(file, data);
}

export const listUsers = (file) => Object.entries(readUsers(file).users).map(([name, u]) => ({ name, updatedAt: u.updatedAt ?? null }));

/** The user's token when the password matches, else null. Always runs one scrypt, so a wrong name costs the same. */
export function checkLogin(file, name, password) {
  const u = readUsers(file).users[String(name ?? '')];
  const ok = verifyPassword(password, u?.hash ?? hashPassword('x'.repeat(MIN_PASSWORD), Buffer.alloc(16)));
  return u && ok ? u.token : null;
}
