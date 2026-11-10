import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatError, createChatStore, readBackwards } from '../src/chat.mjs';

const T0 = Date.parse('2026-11-03T12:00:00Z');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-chat-')), 'chat');
const fakeClock = () => ({ t: T0, now() { return this.t; } });
const status = (fn) => { try { fn(); } catch (err) { assert.ok(err instanceof ChatError, err.message); return err.status; } return null; };
const mode = (p) => fs.statSync(p).mode & 0o777;

describe('chat store', () => {
  it('starts with #general and creates the dir 0700 and files 0600', () => {
    const dir = tmp();
    const chat = createChatStore({ dir, clock: fakeClock() });
    assert.deepEqual(chat.channels().map((c) => c.name), ['general']);
    assert.equal(mode(dir), 0o700);
    assert.equal(mode(path.join(dir, 'channels.json')), 0o600);
    chat.post('general', 'alice', 'hi');
    assert.equal(mode(path.join(dir, 'general.jsonl')), 0o600);
  });

  it('post trims, keeps line breaks, and stamps author, id and time', () => {
    const clock = fakeClock();
    const chat = createChatStore({ dir: tmp(), clock });
    const m = chat.post('general', 'alice', '  hi\r\nthere ');
    assert.deepEqual(m, { id: 1, channel: 'general', author: 'alice', text: 'hi\nthere', at: new Date(clock.t).toISOString() });
  });

  it('rejects empty, over-2000 and unknown channel', () => {
    const chat = createChatStore({ dir: tmp(), clock: fakeClock() });
    assert.equal(status(() => chat.post('general', 'alice', '   ')), 400);
    assert.equal(status(() => chat.post('general', 'alice', 'x'.repeat(2001))), 400);
    assert.equal(status(() => chat.post('general', 'alice', 42)), 400);
    assert.equal(status(() => chat.post('nope', 'alice', 'hi')), 404);
    assert.equal(chat.post('general', 'alice', 'x'.repeat(2000)).text.length, 2000);
    assert.equal(chat.post('general', 'bob', '😀'.repeat(2000)).author, 'bob', 'counts characters, not UTF-16 units');
    assert.equal(status(() => chat.post('general', 'carol', '😀'.repeat(2001))), 400);
  });

  it('rate limit: 10 per 10 s per author', () => {
    const clock = fakeClock();
    const chat = createChatStore({ dir: tmp(), clock });
    for (let i = 0; i < 10; i++) chat.post('general', 'alice', `m${i}`);
    assert.equal(status(() => chat.post('general', 'alice', 'one more')), 429);
    assert.equal(chat.post('general', 'bob', 'still fine').author, 'bob');
    clock.t += 10_001;
    assert.equal(chat.post('general', 'alice', 'later').author, 'alice');
  });

  it('create/remove: name rules, limit, general protected, archive kept', () => {
    const dir = tmp();
    const chat = createChatStore({ dir, clock: fakeClock() });
    assert.equal(status(() => chat.create('Bad', 'carol')), 400);
    assert.equal(status(() => chat.create('a'.repeat(25), 'carol')), 400);
    assert.equal(chat.create('ops', 'carol').createdBy, 'carol');
    assert.equal(status(() => chat.create('ops', 'carol')), 409);
    chat.post('ops', 'alice', 'in ops');
    assert.equal(status(() => chat.remove('general', 'carol')), 409);
    assert.equal(status(() => chat.remove('nope', 'carol')), 404);
    chat.remove('ops', 'carol');
    assert.deepEqual(chat.channels().map((c) => c.name), ['general']);
    const archived = fs.readdirSync(path.join(dir, 'archive'));
    assert.equal(archived.length, 1);
    assert.match(archived[0], /^ops-\d+\.jsonl$/);
    assert.equal(fs.existsSync(path.join(dir, 'ops.jsonl')), false);
    chat.create('ops', 'carol');
    assert.deepEqual(chat.history('ops').messages, []);
    for (let i = chat.channels().length; i < 50; i++) chat.create(`c${i}`, 'carol');
    assert.equal(chat.channels().length, 50);
    assert.equal(status(() => chat.create('one-too-many', 'carol')), 409);
  });

  it('inherited object keys are not channels', () => {
    const dir = tmp();
    const chat = createChatStore({ dir, clock: fakeClock() });
    for (const name of ['constructor', 'tostring']) {
      assert.equal(status(() => chat.post(name, 'alice', 'hi')), 404);
      assert.equal(status(() => chat.history(name)), 404);
      assert.equal(status(() => chat.remove(name, 'carol')), 404);
    }
    assert.equal(fs.existsSync(path.join(dir, 'constructor.jsonl')), false);
    assert.equal(chat.create('constructor', 'carol').name, 'constructor');
    assert.equal(chat.post('constructor', 'alice', 'ok').id, 1);
  });

  it('channels lists general first, then by name', () => {
    const chat = createChatStore({ dir: tmp(), clock: fakeClock() });
    chat.create('zeta', 'carol');
    chat.create('alpha', 'carol');
    assert.deepEqual(chat.channels().map((c) => c.name), ['general', 'alpha', 'zeta']);
  });

  it('history pages backwards', () => {
    const clock = fakeClock();
    const chat = createChatStore({ dir: tmp(), clock });
    for (let i = 1; i <= 120; i++) { chat.post('general', `u${i % 7}`, `m${i}`); clock.t += 2000; }
    const first = chat.history('general');
    assert.equal(first.messages.length, 50);
    assert.equal(first.messages.at(-1).id, 120);
    assert.equal(first.messages[0].id, 71);
    assert.equal(first.more, true);
    const older = chat.history('general', { before: 71, limit: 100 });
    assert.deepEqual(older.messages.map((m) => m.id), Array.from({ length: 70 }, (_, i) => i + 1));
    assert.equal(older.more, false);
    assert.equal(chat.history('general', { limit: 500 }).messages.length, 100);
    assert.equal(status(() => chat.history('nope')), 404);
  });

  it('reload keeps channels, history and rising ids, skipping a corrupt line', () => {
    const dir = tmp();
    const clock = fakeClock();
    const a = createChatStore({ dir, clock });
    a.create('ops', 'carol');
    for (let i = 0; i < 3; i++) a.post('general', 'alice', `m${i}`);
    fs.appendFileSync(path.join(dir, 'general.jsonl'), '{oops\n');
    const b = createChatStore({ dir, clock });
    assert.deepEqual(b.channels().map((c) => c.name), ['general', 'ops']);
    assert.equal(b.history('general').messages.length, 3);
    assert.equal(b.post('ops', 'alice', 'next').id, 4);
    b.remove('ops', 'carol');
    const c = createChatStore({ dir, clock });
    assert.equal(c.post('general', 'bob', 'after archive').id, 5);
  });

  it('history older than the in-memory tail is read from the file', () => {
    const dir = tmp();
    const clock = fakeClock();
    const a = createChatStore({ dir, clock });
    for (let i = 1; i <= 250; i++) { a.post('general', `u${i % 9}`, `m${i}`); clock.t += 2000; }
    const b = createChatStore({ dir, clock });
    assert.deepEqual(b.history('general', { before: 11, limit: 100 }).messages.map((m) => m.id), Array.from({ length: 10 }, (_, i) => i + 1));
  });

  it('subscribe receives message, channel-created, channel-deleted, and unsubscribe stops it', () => {
    const chat = createChatStore({ dir: tmp(), clock: fakeClock() });
    const seen = [];
    const off = chat.subscribe((e) => seen.push(e.type));
    chat.subscribe(() => { throw new Error('bad listener'); });
    chat.create('ops', 'carol');
    chat.post('ops', 'alice', 'hi');
    chat.remove('ops', 'carol');
    off();
    chat.post('general', 'alice', 'unseen');
    assert.deepEqual(seen, ['channel-created', 'message', 'channel-deleted']);
  });

  it('since(afterId) returns messages from all channels with a larger id, in id order', () => {
    const chat = createChatStore({ dir: tmp(), clock: fakeClock() });
    chat.create('ops', 'carol');
    chat.post('general', 'alice', 'a');
    chat.post('ops', 'bob', 'b');
    chat.post('general', 'alice', 'c');
    assert.deepEqual(chat.since(1).map((m) => [m.id, m.channel]), [[2, 'ops'], [3, 'general']]);
    assert.deepEqual(chat.since(3), []);
  });

  it('readBackwards pages from the end of the file in small chunks', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dash-chat-')), 'c.jsonl');
    const lines = [];
    for (let i = 1; i <= 500; i++) lines.push(JSON.stringify({ id: i, channel: 'c', author: 'a', text: `m${i} ${'é'.repeat(i % 5)}`, at: 'x' }));
    lines.splice(250, 0, '{torn');
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const last = readBackwards(file, { limit: 50, chunk: 64 });
    assert.deepEqual(last.messages.map((m) => m.id), Array.from({ length: 50 }, (_, i) => i + 451));
    assert.equal(last.more, true);
    const mid = readBackwards(file, { before: 101, limit: 50, chunk: 64 });
    assert.deepEqual(mid.messages.map((m) => m.id), Array.from({ length: 50 }, (_, i) => i + 51));
    assert.equal(mid.more, true);
    const first = readBackwards(file, { before: 11, limit: 50, chunk: 7 });
    assert.deepEqual(first.messages.map((m) => m.id), Array.from({ length: 10 }, (_, i) => i + 1));
    assert.equal(first.more, false);
    assert.equal(mid.messages[0].text, `m51 ${'é'.repeat(1)}`);
    assert.deepEqual(readBackwards(path.join(path.dirname(file), 'none.jsonl'), { limit: 5 }), { messages: [], more: false });
  });
});
