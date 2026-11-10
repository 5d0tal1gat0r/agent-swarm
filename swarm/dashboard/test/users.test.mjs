import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { changePassword, checkLogin, hashPassword, listUsers, markNotificationsRead, readNotifications, removeUser, setPassword, setUser, updateNotificationPreferences, verifyPassword } from '../src/users.mjs';

const TOKEN = 'abcdefghijklmnopqrstuvwxyz012345';
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'users-')), 'users.json');

describe('dashboard users', () => {
  it('hashes with scrypt and a salt; verifies only the right password', () => {
    const h = hashPassword('correct horse battery');
    assert.match(h, /^scrypt\$16384\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    assert.notEqual(h, hashPassword('correct horse battery'), 'salted');
    assert.equal(verifyPassword('correct horse battery', h), true);
    assert.equal(verifyPassword('correct horse batterz', h), false);
    assert.equal(verifyPassword('x', 'garbage'), false);
  });

  it('stores users mode 0600 without the plain password; login returns the token', () => {
    const f = file();
    setUser(f, { name: 'owner', password: 'a long password', token: TOKEN });
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(f, 'utf8').includes('a long password'));
    assert.equal(checkLogin(f, 'owner', 'a long password'), TOKEN);
    assert.equal(checkLogin(f, 'owner', 'wrong password'), null);
    assert.equal(checkLogin(f, 'nobody', 'a long password'), null);
    assert.deepEqual(listUsers(f).map((u) => u.name), ['owner']);
    removeUser(f, 'owner');
    assert.equal(checkLogin(f, 'owner', 'a long password'), null);
  });

  it('setPassword keeps the token; changePassword needs the current password', () => {
    const f = file();
    setUser(f, { name: 'member-c', password: 'first password', token: TOKEN });
    setPassword(f, 'member-c', 'second password');
    assert.equal(checkLogin(f, 'member-c', 'first password'), null);
    assert.equal(checkLogin(f, 'member-c', 'second password'), TOKEN, 'token kept');
    assert.equal(changePassword(f, 'member-c', 'wrong password', 'third password'), false);
    assert.equal(checkLogin(f, 'member-c', 'second password'), TOKEN, 'unchanged after a wrong current password');
    assert.equal(changePassword(f, 'member-c', 'second password', 'third password'), true);
    assert.equal(checkLogin(f, 'member-c', 'third password'), TOKEN);
    assert.throws(() => setPassword(f, 'member-c', 'short'), /at least 10/);
    assert.throws(() => setPassword(f, 'nobody', 'long enough pw'), /no user nobody/);
  });

  it('refuses short passwords, bad names, bad tokens, and a users file readable by others', () => {
    const f = file();
    assert.throws(() => setUser(f, { name: 'a', password: 'short', token: TOKEN }), /at least 10/);
    assert.throws(() => setUser(f, { name: 'Bad Name', password: 'a long password', token: TOKEN }), /user name/);
    assert.throws(() => setUser(f, { name: 'ok', password: 'a long password', token: 'x' }), /token/);
    setUser(f, { name: 'ok', password: 'a long password', token: TOKEN });
    fs.chmodSync(f, 0o644);
    assert.throws(() => checkLogin(f, 'ok', 'a long password'), /must not be readable/);
  });

  it('returns enabled notification defaults and persists allow-listed preferences', () => {
    const f = file();
    setUser(f, { name: 'owner', password: 'a long password', token: TOKEN });
    const defaults = readNotifications(f, 'owner');
    assert.equal(defaults.kinds['task-failed'], true);
    assert.deepEqual(defaults.channels, []);
    assert.throws(() => updateNotificationPreferences(f, 'owner', { channels: ['bad name'] }), /channels/);
    updateNotificationPreferences(f, 'owner', { kinds: { 'task-failed': false, unknown: true }, channels: ['ops'] });
    const saved = readNotifications(f, 'owner');
    assert.equal(saved.kinds['task-failed'], false);
    assert.equal(saved.kinds.unknown, undefined);
    assert.deepEqual(saved.channels, ['ops']);
    assert.equal(saved.readThrough, null);
    markNotificationsRead(f, 'owner', 'task-failed:T-0001');
    assert.equal(readNotifications(f, 'owner').readThrough, 'task-failed:T-0001');
  });

  it('rejects malformed notification updates without damaging the user record', () => {
    const f = file();
    setUser(f, { name: 'owner', password: 'a long password', token: TOKEN });
    assert.throws(() => markNotificationsRead(f, 'owner', 'x'.repeat(201)), /event id/);
    assert.throws(() => updateNotificationPreferences(f, 'owner', { kinds: 'nope' }), /kinds/);
    assert.equal(checkLogin(f, 'owner', 'a long password'), TOKEN);
  });
});
