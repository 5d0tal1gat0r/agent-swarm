// Dashboard chat store (ARCHITECTURE 72). Text channels for signed-in members, kept on the dashboard
// machine: channels.json (list, creator, last id; temp file + rename) and one append-only <name>.jsonl
// per channel. A deleted channel's file moves to archive/. The last TAIL messages of each channel stay
// in memory; older pages are read from the file. No HTTP here and no orchestrator: the server checks
// sessions and roles.
import { appendFileSync, chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const CHANNEL = /^[a-z][a-z0-9-]{0,23}$/;
export const GENERAL = 'general';
export const MAX_TEXT = 2000;
export const MAX_CHANNELS = 50;
export const TAIL = 200;
export const PAGE = 50;
export const MAX_PAGE = 100;
export const RATE = { count: 10, windowMs: 10_000 };

export class ChatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const parse = (line) => {
  try {
    const m = JSON.parse(line);
    return Number.isInteger(m?.id) ? m : null;
  } catch { return null; } // a torn or corrupt line is skipped
};

/**
 * The newest `limit` messages with id < before (all when before is null), oldest first, read from the end of
 * the file in `chunk`-byte steps so a long history is never loaded whole. `more`: older messages exist.
 */
export function readBackwards(file, { before = null, limit = PAGE, chunk = 64 * 1024 } = {}) {
  if (!existsSync(file)) return { messages: [], more: false };
  const fd = openSync(file, 'r');
  try {
    const found = [];
    let pos = fstatSync(fd).size;
    let rest = Buffer.alloc(0); // bytes of a line cut by the chunk boundary
    const take = (line) => {
      const m = line.length ? parse(line.toString('utf8')) : null;
      if (m && (before == null || m.id < before)) found.push(m);
    };
    while (pos > 0 && found.length <= limit) {
      const size = Math.min(chunk, pos);
      pos -= size;
      const buf = Buffer.alloc(size);
      readSync(fd, buf, 0, size, pos);
      let data = Buffer.concat([buf, rest]);
      let nl;
      while ((nl = data.lastIndexOf(0x0a)) >= 0 && found.length <= limit) {
        take(data.subarray(nl + 1));
        data = data.subarray(0, nl);
      }
      rest = data;
    }
    if (pos === 0 && found.length <= limit) take(rest);
    return { messages: found.slice(0, limit).reverse(), more: found.length > limit };
  } finally {
    closeSync(fd);
  }
}

export function createChatStore({ dir, clock = Date }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const metaFile = path.join(dir, 'channels.json');
  const fileOf = (name) => path.join(dir, `${name}.jsonl`);
  let meta = { lastId: 0, channels: {} };
  try { meta = { lastId: 0, channels: {}, ...JSON.parse(readFileSync(metaFile, 'utf8')) }; } catch { /* first start */ }
  const saveMeta = () => {
    writeFileSync(`${metaFile}.tmp`, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
    chmodSync(`${metaFile}.tmp`, 0o600);
    renameSync(`${metaFile}.tmp`, metaFile);
  };
  if (!meta.channels[GENERAL]) {
    meta.channels[GENERAL] = { createdBy: null, createdAt: new Date(clock.now()).toISOString() };
    saveMeta();
  }
  const tails = new Map();
  for (const name of Object.keys(meta.channels)) {
    const { messages } = readBackwards(fileOf(name), { limit: TAIL });
    for (const m of messages) meta.lastId = Math.max(meta.lastId, m.id);
    tails.set(name, messages);
  }
  const listeners = new Set();
  const emit = (event) => { for (const fn of listeners) { try { fn(event); } catch { /* one bad listener does not stop the others */ } } };
  const recent = new Map(); // author -> [times]

  // Own keys only: a name like `constructor` must not match Object.prototype.
  const has = (name) => Object.hasOwn(meta.channels, name);
  const must = (name) => {
    if (!has(name)) throw new ChatError(404, `no channel #${name}`);
    return name;
  };
  const channelOf = (name) => ({ name, ...meta.channels[name] });

  return {
    channels() {
      const rest = Object.keys(meta.channels).filter((n) => n !== GENERAL).sort();
      return [GENERAL, ...rest].map(channelOf);
    },

    post(channel, author, text) {
      must(channel);
      if (typeof text !== 'string') throw new ChatError(400, 'text is required');
      const clean = text.replace(/\r\n?/g, '\n').trim();
      if (!clean) throw new ChatError(400, 'message is empty');
      if ([...clean].length > MAX_TEXT) throw new ChatError(400, `message is longer than ${MAX_TEXT} characters`);
      const now = clock.now();
      const times = (recent.get(author) ?? []).filter((t) => now - t < RATE.windowMs);
      if (times.length >= RATE.count) throw new ChatError(429, 'too many messages; slow down');
      recent.set(author, [...times, now]);
      const message = { id: ++meta.lastId, channel, author, text: clean, at: new Date(now).toISOString() };
      appendFileSync(fileOf(channel), `${JSON.stringify(message)}\n`, { mode: 0o600 });
      const tail = tails.get(channel);
      tail.push(message);
      if (tail.length > TAIL) tail.shift();
      emit({ type: 'message', message });
      return message;
    },

    history(channel, { before = null, limit = PAGE } = {}) {
      must(channel);
      const n = Math.min(MAX_PAGE, Math.max(1, Number.isInteger(limit) ? limit : PAGE));
      const tail = tails.get(channel);
      const pool = before == null ? tail : tail.filter((m) => m.id < before);
      // Enough in memory, or the memory holds the whole channel: no file read.
      if (pool.length > n || tail.length < TAIL) return { messages: pool.slice(-n), more: pool.length > n };
      return readBackwards(fileOf(channel), { before, limit: n });
    },

    since(afterId) {
      const out = [];
      for (const tail of tails.values()) for (const m of tail) if (m.id > afterId) out.push(m);
      return out.sort((a, b) => a.id - b.id);
    },

    create(name, by) {
      if (typeof name !== 'string' || !CHANNEL.test(name)) throw new ChatError(400, 'channel name: lowercase letters, digits and -, starting with a letter, up to 24 characters');
      if (has(name)) throw new ChatError(409, `#${name} already exists`);
      if (Object.keys(meta.channels).length >= MAX_CHANNELS) throw new ChatError(409, `at most ${MAX_CHANNELS} channels`);
      meta.channels[name] = { createdBy: by, createdAt: new Date(clock.now()).toISOString() };
      saveMeta();
      tails.set(name, []);
      const channel = channelOf(name);
      emit({ type: 'channel-created', channel });
      return channel;
    },

    remove(name, by) {
      must(name);
      if (name === GENERAL) throw new ChatError(409, '#general cannot be deleted');
      if (existsSync(fileOf(name))) {
        mkdirSync(path.join(dir, 'archive'), { recursive: true, mode: 0o700 });
        renameSync(fileOf(name), path.join(dir, 'archive', `${name}-${clock.now()}.jsonl`));
      }
      delete meta.channels[name];
      meta.deleted = [...(meta.deleted ?? []), { name, by, at: new Date(clock.now()).toISOString() }].slice(-100);
      saveMeta(); // lastId is saved here, so ids keep rising after the archived file is gone.
      tails.delete(name);
      emit({ type: 'channel-deleted', name });
    },

    /** Newest message id in any channel: where a new page's live stream starts. */
    lastId() {
      return meta.lastId;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
