// Minimal agent-comm client over the MCP HTTP bridge. Announcements only:
// failures are logged and never stop the worker.

export class Bus {
  constructor(url, name, log = console) {
    this.url = url;
    this.name = name;
    this.log = log;
    this.session = null;
    this.nextId = 1;
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
    if (!this.session) await this.connect();
    const out = await this.rpc('tools/call', { name: tool, arguments: args });
    const result = out?.result;
    if (result?.isError) throw new Error(result.content?.[0]?.text ?? 'bus error');
    return result?.content?.[0]?.text;
  }

  async connect() {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'autopilot', version: '1' } });
    await this.rpc('notifications/initialized', undefined, true);
    await this.call('comm_register', { name: this.name, channels: ['general'] });
  }

  /** Never throws. */
  async safe(tool, args) {
    try {
      return await this.call(tool, args);
    } catch (err) {
      this.session = null;
      this.log.warn(`[bus] ${tool} failed: ${err.message}`);
      return null;
    }
  }

  say(content) {
    return this.safe('comm_send', { channel: 'general', content });
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
