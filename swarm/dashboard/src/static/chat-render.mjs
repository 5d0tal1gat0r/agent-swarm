// Chat page helpers (ARCHITECTURE 72). Pure: no DOM, so node tests and the page share them.
// chat.js builds elements from these with textContent only; only http(s) URLs become links.

const URL_RE = /https?:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]]+$/;

// Whole-word references to swarm work: T-0007 and E-0003 open the graph, #253 the pull request.
const REF_RE = /(?<![\w#-])(?:([TE]-\d{4,})|#(\d{1,7}))(?![\w-])/g;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Plain text split further at task, epic and PR references. repo: owner/name for PR links. */
function splitRefs(text, repo) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(REF_RE)) {
    const href = m[1] ? `/graph?focus=${m[1]}` : (repo && REPO_RE.test(repo) ? `https://github.com/${repo}/pull/${m[2]}` : null);
    if (!href) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index) });
    out.push({ href, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** Text split into plain parts and link parts. options.repo (owner/name) links #123 to its PR. */
export function splitLinks(text, { repo = null } = {}) {
  const parts = [];
  let last = 0;
  const push = (t) => { if (!t) return; const prev = parts.at(-1); if (prev && !prev.href) prev.text += t; else parts.push({ text: t }); };
  for (const m of String(text).matchAll(URL_RE)) {
    const href = m[0].replace(TRAILING, '');
    push(text.slice(last, m.index));
    if (/^https?:\/\/[^/]/.test(href)) parts.push({ href, text: href });
    else push(href);
    last = m.index + href.length;
  }
  push(text.slice(last));
  return parts.flatMap((p) => (p.href ? [p] : splitRefs(p.text, repo)));
}

/** Day separators and message lines, oldest first. */
export function buildLines(messages, { timeZone, repo = null } = {}) {
  const day = new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const full = new Intl.DateTimeFormat(undefined, { timeZone, dateStyle: 'full', timeStyle: 'medium' });
  const lines = [];
  let lastDay = null;
  for (const m of messages) {
    const at = new Date(m.at);
    const label = day.format(at);
    if (label !== lastDay) { lines.push({ type: 'day', id: m.id, label }); lastDay = label; }
    lines.push({ type: 'msg', id: m.id, time: time.format(at), title: full.format(at), author: m.author, parts: splitLinks(m.text, { repo }) });
  }
  return lines;
}

/** Messages from both lists, each id once, by id. */
export function mergeMessages(list, incoming) {
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/** IRC-style nick color: a stable index into NICK_COLORS (CSS classes nick-0 … nick-7). */
export const NICK_COLORS = 8;
export function nickColor(nick) {
  let h = 0;
  for (const ch of String(nick)) h = (Math.imul(h, 31) + ch.codePointAt(0)) >>> 0;
  return h % NICK_COLORS;
}

const COMMANDS = { join: 'join', j: 'join', create: 'create', delete: 'delete', clear: 'clear', help: 'help' };

/** A slash command typed in the input, or null for plain text. `//text` sends `/text`. */
export function parseCommand(text) {
  const t = String(text).trim();
  if (!t.startsWith('/')) return null;
  if (t.startsWith('//')) return { cmd: 'say', arg: t.slice(1) };
  const [word, ...rest] = t.slice(1).split(/\s+/);
  const key = word.toLowerCase();
  if (!Object.hasOwn(COMMANDS, key)) return { cmd: 'unknown', arg: word };
  const cmd = COMMANDS[key];
  const arg = rest.join(' ').replace(/^#/, '');
  return { cmd, arg: ['join', 'create', 'delete'].includes(cmd) ? arg.toLowerCase() : arg };
}

/** The argument as a channel name (the server's rule), or null. Keeps typed text out of request paths. */
export const channelArg = (arg) => (/^[a-z][a-z0-9-]{0,23}$/.test(arg) ? arg : null);
