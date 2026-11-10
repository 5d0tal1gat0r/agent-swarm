// Copied from autopilot/src/bus.mjs at commit 795a216 (M2). The autopilot copy
// stays until M7. Added: send(channel, text) for swarm channels.
// failures are logged and never stop the worker.

const CHANNEL_NAME = /^[a-z0-9._-]{2,64}$/; // same rule as orchestrator/src/events.mjs
const isValidChannelName = (n) => typeof n === 'string' && CHANNEL_NAME.test(n);
export const BACKOFF_MS = 60_000;
export const MAX_BACKOFF_MS = 600_000;

class BackoffError extends Error {}

export class Bus {
  /** `channels` are created and joined at register time, next to `general`. */
  constructor(url, name, log = console, channels = [], { now = Date.now, backoffMs = BACKOFF_MS, maxBackoffMs = MAX_BACKOFF_MS } = {}) {
    this.url = url;
    const bad = [...new Set(channels)].filter((c) => !isValidChannelName(c));
    if (bad.length) log.warn?.(`[bus] ignoring invalid channel names: ${bad.map(String).join(', ')}`);
    this.channels = [...new Set(['general', ...channels.filter(isValidChannelName)])];
    this.now = now;
    this.baseBackoffMs = backoffMs;
    this.maxBackoffMs = maxBackoffMs;
    this.backoffMs = backoffMs;
    this.retryAt = 0;
    this.name = name;
    this.log = log;
    this.session = null;
    this.nextId = 1;
    this.warnedParse = false;
  }

  /** Parses a tool reply. Null (and one warning per Bus) when it is not JSON. */
  parse(text, tool) {
    try {
      return JSON.parse(text);
    } catch {
      if (!this.warnedParse) {
        this.warnedParse = true;
        this.log.warn?.(`[bus] ${tool} returned non-JSON output`);
      }
      return null;
    }
  }

  async rpc(method, params, notify = false) {
    const body = { jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: this.nextId++ }) };
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.session ? { 'mcp-session-id': this.session } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404 && this.session) {
      this.session = null; // bridge restarted or session expired
      throw new Error('bus session expired');
    }
    this.session = res.headers.get('mcp-session-id') ?? this.session;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  async call(tool, args) {
    if (!this.session) {
      if (this.now() < this.retryAt) throw new BackoffError('bus connect backing off');
      try {
        // Concurrent first calls share one connect: two registrations of one name make the bus refuse the second.
        this.connecting ??= this.connect().finally(() => { this.connecting = null; });
        await this.connecting;
        this.backoffMs = this.baseBackoffMs;
        this.retryAt = 0;
      } catch (err) {
        this.retryAt = this.now() + this.backoffMs;
        this.log.warn?.(`[bus] connect failed, retry in ${Math.round(this.backoffMs / 1000)}s`);
        this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
        throw err;
      }
    }
    const out = await this.rpc('tools/call', { name: tool, arguments: args });
    const result = out?.result;
    if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'bus error');
    return result?.content?.[0]?.text;
  }

  async connect() {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.name, version: '1' } });
    await this.rpc('notifications/initialized', undefined, true);
    try {
      await this.call('comm_register', { name: this.name, channels: this.channels });
      this.registeredAs = this.name;
    } catch (err) {
      // A crashed or unclosed process leaves its bridge session, and the name, "active" for up to
      // 30 min. Register a suffixed name so state, inbox and channels keep working; direct messages
      // to the main name reach the old session until it expires. The next connect tries the name again.
      if (!/already registered/i.test(err.message)) throw err;
      const fallback = `${this.name}-${Math.random().toString(16).slice(2, 6)}`;
      this.log.warn?.(`[bus] ${this.name} is held by an abandoned session; registered as ${fallback} until it expires`);
      await this.call('comm_register', { name: fallback, channels: this.channels });
      this.registeredAs = fallback;
    }
  }

  /** True when `channel` was registered (the channel set is fixed at construction). */
  hasChannel(channel) {
    return this.channels.includes(channel);
  }

  /** Never throws. */
  async safe(tool, args) {
    try {
      return await this.call(tool, args);
    } catch (err) {
      if (err instanceof BackoffError) return null; // already warned when the window began
      this.session = null;
      this.log.warn(`[bus] ${tool} failed: ${err.message}`);
      return null;
    }
  }

  say(content) {
    return this.safe('comm_send', { channel: 'general', content });
  }

  /** Posts to a channel such as swarm or dept-core (it must be in the channels given to the constructor). Never throws. */
  send(channel, content) {
    return this.safe('comm_send', { channel, content });
  }

  /** Direct message to one agent by name. Never throws. */
  direct(to, content) {
    return this.safe('comm_send', { to, content });
  }

  /** Newest inbox messages, read or unread (the bus has no mark-read over MCP). Null on failure. */
  async inbox({ limit = 100 } = {}) {
    const text = await this.safe('comm_inbox', { unread_only: false, limit });
    return text ? this.parse(text, 'comm_inbox') : null;
  }

  /** Online and idle agents (all agents with includeOffline): [{ id, name, status, last_heartbeat, ... }]. Null on failure. */
  async agents({ includeOffline = false } = {}) {
    const text = await this.safe('comm_agents', includeOffline ? { action: 'list', include_offline: true } : { action: 'list' });
    return text ? this.parse(text, 'comm_agents') : null;
  }

  /** Last messages of a channel (comm_channel history), or null on failure. */
  async channelHistory(channel, limit = 50) {
    const text = await this.safe('comm_channel', { action: 'history', channel, limit });
    if (!text) return null;
    try {
      const data = JSON.parse(text);
      return Array.isArray(data) ? data : null;
    } catch {
      return null;
    }
  }

  /** All channels: [{ id, name, description, created_by, created_at }]. Null on failure. */
  async listChannels() {
    const text = await this.safe('comm_channel', { action: 'list' });
    if (!text) return null;
    try { const d = JSON.parse(text); return Array.isArray(d) ? d : null; } catch { return null; }
  }

  /** Shared state entries of one namespace: [{ namespace, key, value, updated_by, updated_at }]. Null on failure. */
  async stateList(namespace) {
    const text = await this.safe('comm_state', { action: 'list', namespace });
    if (!text) return null;
    try { const d = JSON.parse(text); return Array.isArray(d) ? d : null; } catch { return null; }
  }

  /** Sets a shared state key on the bus. Never throws. */
  setState(namespace, key, value) {
    return this.safe('comm_state', { action: 'set', namespace, key, value });
  }

  /** The value string of a shared state key; null when missing or on failure. */
  async getState(namespace, key) {
    const text = await this.safe('comm_state', { action: 'get', namespace, key });
    if (!text) return null;
    return this.parse(text, 'comm_state')?.value ?? null;
  }

  /** Like getState, but tells a failed read from a missing key: { ok: false } on failure or non-JSON, else { ok: true, value } (null when missing). */
  async readState(namespace, key) {
    const text = await this.safe('comm_state', { action: 'get', namespace, key });
    if (!text) return { ok: false };
    const parsed = this.parse(text, 'comm_state');
    return parsed ? { ok: true, value: parsed.value ?? null } : { ok: false };
  }

  status(text) {
    return this.safe('comm_agents', { action: 'status', status_text: text });
  }

  async close() {
    if (!this.session) return;
    try {
      await fetch(this.url, { method: 'DELETE', headers: { 'mcp-session-id': this.session }, signal: AbortSignal.timeout(5000) });
    } catch {}
    this.session = null;
  }
}
