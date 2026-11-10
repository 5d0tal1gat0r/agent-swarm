// Chat page (ARCHITECTURE 72), styled as a retro terminal IRC client. Channels from /api/chat/channels,
// history per channel, and one EventSource for new messages and channel changes. Text reaches the page
// through textContent only. Slash commands (/join, /create, /delete, /clear, /help) run in the page.
import { buildLines, channelArg, mergeMessages, nickColor, parseCommand } from '/chat-render.mjs';

const $ = (id) => document.getElementById(id);
const GENERAL = 'general';
const RETRY_MS = [2000, 5000, 10_000];
const PIN_PX = 40;
const HELP = [
  '/join <channel>    switch window (also /j, Alt+1..9)',
  '/create <name>     new channel (owners)',
  '/delete <name>     archive a channel (owners)',
  '/clear             clear this window',
  '//text             send text that starts with /',
  'Enter sends · Shift+Enter new line',
];

let me = null;
let repo = null; // owner/name of the swarm repo, for #123 pull request links
let admin = false;
let channels = [];
let current = GENERAL;
let lastId = 0;
let stream = null;
let retries = 0;
let dropped = false;
let deleting = null;
const rooms = new Map(); // name -> { messages, more, loaded, clearedAt, sys }
const act = new Set(); // channels with unread messages

async function api(path, body) {
  const init = { cache: 'no-store', credentials: 'same-origin' };
  if (body !== undefined) Object.assign(init, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const res = await fetch(path, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const roomOf = (name) => {
  if (!rooms.has(name)) rooms.set(name, { messages: [], more: false, loaded: false, clearedAt: 0, sys: [] });
  return rooms.get(name);
};
const seen = (messages) => { for (const m of messages) lastId = Math.max(lastId, m.id); };
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const winOf = (name) => channels.findIndex((c) => c.name === name) + 1;
const hhmm = () => new Date().toTimeString().slice(0, 5);

function notice(text, ms = 3000) {
  const n = $('c-notice');
  n.textContent = `-!- ${text}`;
  n.hidden = false;
  clearTimeout(notice.timer);
  if (ms) notice.timer = setTimeout(() => { n.hidden = true; }, ms);
}

/** A local -!- line in the current window (help, errors, joins). Not sent anywhere. */
function sys(text) {
  roomOf(current).sys.push({ after: lastId, text });
  renderMessages();
}

function renderStatus() {
  $('s-clock').textContent = hhmm();
  $('s-nick').textContent = `${me ?? '?'}${admin ? '(+o)' : ''}`;
  $('s-win').textContent = `${winOf(current)}:#${current}`;
  const list = channels.filter((c) => act.has(c.name)).map((c) => winOf(c.name));
  $('s-act-wrap').hidden = !list.length;
  $('s-act').textContent = list.join(',');
}

function renderTopic() {
  const c = channels.find((x) => x.name === current);
  const about = current === GENERAL ? 'work talk for the swarm' : `created by ${c?.createdBy ?? '?'} on ${(c?.createdAt ?? '').slice(0, 10)}`;
  $('c-topic').replaceChildren(el('b', { textContent: `#${current}` }), ` ─ ${about} ─ ${channels.length} channel${channels.length === 1 ? '' : 's'} ─ /help`);
}

function renderChannels() {
  $('c-add').hidden = !admin;
  $('c-list').replaceChildren(...channels.map((c, i) => {
    const link = el('a', { href: `#${c.name}`, className: [c.name === current ? 'current' : '', act.has(c.name) ? 'act' : ''].join(' ').trim() },
      el('span', { className: 'irc-dim', textContent: `${i + 1}:` }), `#${c.name}`);
    if (c.name === current) link.setAttribute('aria-current', 'page');
    const item = el('li', {}, link);
    if (admin && c.name !== GENERAL) {
      const del = el('button', { type: 'button', className: 'irc-btn irc-del', textContent: 'x', title: `Delete #${c.name}` });
      del.setAttribute('aria-label', `Delete #${c.name}`);
      del.addEventListener('click', () => askDelete(c.name));
      item.append(del);
    }
    return item;
  }));
  renderTopic();
  renderStatus();
}

function renderMessages() {
  const log = $('c-log');
  const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < PIN_PX;
  const room = roomOf(current);
  const shown = room.messages.filter((m) => m.id > room.clearedAt);
  $('c-older').hidden = !room.more || room.clearedAt > 0;
  $('c-banner').hidden = room.more || room.clearedAt > 0;
  const nodes = [];
  if (!room.more && !room.clearedAt) {
    nodes.push(el('li', { className: 'irc-line irc-motd' }, el('span', { className: 'irc-sys', textContent: '-!-' }), ` welcome to swarm//irc, ${me}. logs live on the server. type /help.`));
  }
  const sysAt = [...room.sys];
  const flushSys = (upTo) => {
    while (sysAt.length && sysAt[0].after <= upTo) nodes.push(el('li', { className: 'irc-line irc-local' }, el('span', { className: 'irc-sys', textContent: '-!-' }), ` ${sysAt.shift().text}`));
  };
  for (const line of buildLines(shown, { repo })) {
    flushSys(line.id - 1);
    if (line.type === 'day') { nodes.push(el('li', { className: 'irc-line irc-day' }, el('span', { className: 'irc-sys', textContent: '-!-' }), ` day changed to ${line.label}`)); continue; }
    const mine = line.author === me;
    const hl = !mine && me && line.parts.some((p) => !p.href && p.text.toLowerCase().includes(me.toLowerCase()));
    const text = el('span', { className: 'irc-text' }, ...line.parts.map((p) => (p.href ? (p.href.startsWith('/') ? el('a', { href: p.href, textContent: p.text }) : el('a', { href: p.href, textContent: p.text, target: '_blank', rel: 'noopener noreferrer' })) : p.text)));
    nodes.push(el('li', { className: `irc-line${mine ? ' me' : ''}${hl ? ' hl' : ''}` },
      el('time', { className: 'irc-time', textContent: `[${line.time}]`, title: line.title }), ' ',
      el('span', { className: 'irc-dim', textContent: '<' }),
      el('span', { className: `irc-nick nick-${nickColor(line.author)}`, textContent: line.author }),
      el('span', { className: 'irc-dim', textContent: '>' }), ' ', text));
  }
  flushSys(Infinity);
  $('c-lines').replaceChildren(...nodes);
  if (pinned) log.scrollTop = log.scrollHeight;
}

async function loadHistory(name, before = null) {
  const q = before ? `?before=${before}` : '';
  const r = await api(`/api/chat/channels/${name}/messages${q}`);
  if (r.status !== 200) return notice(r.body.error ?? `could not load #${name} (${r.status})`);
  const room = roomOf(name);
  room.messages = mergeMessages(room.messages, r.body.messages);
  room.more = r.body.more;
  room.loaded = true;
  seen(r.body.messages);
}

async function open(name) {
  current = channels.some((c) => c.name === name) ? name : GENERAL;
  act.delete(current);
  if (location.hash !== `#${current}`) history.replaceState(null, '', `#${current}`);
  $('c-prompt').textContent = `[#${current}]`;
  renderChannels();
  if (!roomOf(current).loaded) await loadHistory(current);
  const log = $('c-log');
  renderMessages();
  log.scrollTop = log.scrollHeight;
}

function onEvent(type, data) {
  if (type === 'message') {
    seen([data]);
    if (data.channel !== current && data.author !== me) { act.add(data.channel); renderChannels(); }
    const room = rooms.get(data.channel);
    if (!room?.loaded) return;
    room.messages = mergeMessages(room.messages, [data]);
    if (data.channel === current) renderMessages();
  } else if (type === 'channel-created') {
    if (!channels.some((c) => c.name === data.name)) channels = [...channels, data].sort((a, b) => (a.name === GENERAL ? -1 : b.name === GENERAL ? 1 : a.name.localeCompare(b.name)));
    renderChannels();
  } else if (type === 'channel-deleted') {
    channels = channels.filter((c) => c.name !== data.name);
    rooms.delete(data.name);
    act.delete(data.name);
    if (current === data.name) { notice(`#${data.name} was deleted`); open(GENERAL); } else renderChannels();
  }
}

// After a drop the replay can miss things: channel changes, messages older than the server's tail, and
// messages below an id the page reached through its own posts or history. Reload instead of trusting the cache.
async function resync() {
  const r = await api('/api/chat/channels');
  if (r.status !== 200) return;
  ({ channels, admin } = r.body);
  rooms.clear();
  await open(current);
}

function connect() {
  stream?.close();
  stream = new EventSource(`/api/chat/stream?after=${lastId}`);
  stream.addEventListener('open', () => {
    retries = 0;
    $('c-status').textContent = 'live';
    if (dropped) { dropped = false; resync(); }
  });
  for (const type of ['message', 'channel-created', 'channel-deleted']) {
    stream.addEventListener(type, (e) => { try { onEvent(type, JSON.parse(e.data)); } catch { /* a bad frame is skipped */ } });
  }
  stream.addEventListener('error', () => {
    stream.close();
    dropped = true;
    $('c-status').textContent = 'lag: reconnecting';
    setTimeout(connect, RETRY_MS[Math.min(retries++, RETRY_MS.length - 1)]);
  });
}

async function createChannel(name) {
  const r = await api('/api/chat/channels', { name });
  if (r.status !== 201) return r.body.error ?? `could not create (${r.status})`;
  onEvent('channel-created', r.body);
  location.hash = `#${r.body.name}`;
  return null;
}

async function deleteChannel(name) {
  const r = await api(`/api/chat/channels/${encodeURIComponent(name)}/delete`, {});
  if (r.status === 200) onEvent('channel-deleted', { name });
  else sys(r.body.error ?? `could not delete (${r.status})`);
}

async function say(text) {
  const r = await api(`/api/chat/channels/${current}/messages`, { text });
  if (r.status === 201) { onEvent('message', r.body); return true; }
  if (r.status === 429) notice('slow down a little');
  else sys(r.body.error ?? `could not send (${r.status})`);
  return false;
}

async function submit() {
  const box = $('c-text');
  const input = box.value;
  if (!input.trim()) return;
  const c = parseCommand(input);
  if (!c || c.cmd === 'say') {
    if (await say(c ? c.arg : input.trim())) box.value = '';
    return;
  }
  // Unknown commands keep the text: a pasted path like /home/x stays in the box to send with //.
  if (c.cmd === 'unknown') return sys(`unknown command /${c.arg}. type /help, or start with // to send it as text`);
  box.value = '';
  const name = channelArg(c.arg);
  if (c.cmd === 'help') HELP.forEach((h) => sys(h));
  else if (c.cmd === 'clear') { const room = roomOf(current); room.clearedAt = lastId; room.sys = []; renderMessages(); }
  else if (c.cmd === 'join') {
    if (!name) return sys('usage: /join <channel>');
    if (!channels.some((x) => x.name === name)) return sys(`no channel #${name}${admin ? ` (create it with /create ${name})` : ''}`);
    location.hash = `#${name}`;
  } else if (c.cmd === 'create') {
    if (!admin) return sys('only owners create channels');
    if (!name) return sys('usage: /create <name>  (lowercase letters, digits and -, up to 24)');
    const err = await createChannel(name);
    if (err) sys(err);
  } else if (c.cmd === 'delete') {
    if (!admin) return sys('only owners delete channels');
    if (!name || !channels.some((x) => x.name === name)) return sys('usage: /delete <channel>  (an existing channel)');
    askDelete(name);
  }
}

function askDelete(name) {
  deleting = name;
  $('c-delete-what').textContent = `delete #${name}?`;
  $('c-delete').showModal();
}

async function start() {
  const r = await api('/api/chat/channels');
  if (r.status !== 200) {
    if (r.status !== 401) $('c-access-text').textContent = r.body.error ?? `chat is unavailable (${r.status})`;
    $('c-access').hidden = false;
    return;
  }
  ({ channels, admin, me } = r.body);
  lastId = r.body.lastId ?? 0; // the stream starts at the newest message anywhere: older ones are history, not news
  $('viewer').textContent = `signed in as ${me}`;
  // The repo for #123 links comes from the work itself; without it PR numbers stay plain text.
  api('/api/snapshot').then((s) => {
    const snap = s.body?.snapshot;
    repo = [...(snap?.tasks ?? []), ...(snap?.epics ?? [])].map((x) => x.repo).find((r) => /^[\w.-]+\/[\w.-]+$/.test(r ?? '')) ?? null;
    if (repo) renderMessages();
  }).catch(() => {});
  $('chat').hidden = false;
  await open(decodeURIComponent(location.hash.slice(1)) || GENERAL);
  connect();
  setInterval(renderStatus, 15_000);
  $('c-text').focus();
}

$('c-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
$('c-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
document.addEventListener('keydown', (e) => {
  if (!e.altKey || e.ctrlKey || e.metaKey || !/^[1-9]$/.test(e.key)) return;
  const c = channels[Number(e.key) - 1];
  if (c) { e.preventDefault(); location.hash = `#${c.name}`; }
});
$('c-older').addEventListener('click', async () => {
  const room = roomOf(current);
  const log = $('c-log');
  const from = log.scrollHeight - log.scrollTop;
  await loadHistory(current, room.messages[0]?.id);
  renderMessages();
  log.scrollTop = log.scrollHeight - from;
});
window.addEventListener('hashchange', () => open(decodeURIComponent(location.hash.slice(1))));

$('c-add').addEventListener('click', () => {
  $('c-name').value = '';
  $('c-create-error').hidden = true;
  $('c-create').showModal();
});
$('c-create-cancel').addEventListener('click', () => $('c-create').close());
$('c-create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = await createChannel($('c-name').value.trim());
  if (err) { $('c-create-error').textContent = err; $('c-create-error').hidden = false; return; }
  $('c-create').close();
});
$('c-delete-cancel').addEventListener('click', () => $('c-delete').close());
$('c-delete-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = deleting;
  $('c-delete').close();
  await deleteChannel(name);
});

start();
