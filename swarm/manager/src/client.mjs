// HTTP client for the orchestrator task API. Every call carries the manager's
// bearer token. Errors carry the server's message and status.
export class OrchestratorClient {
  constructor({ url, token, fetchFn = fetch, timeoutMs = 15_000 }) {
    this.base = url.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchFn;
    this.timeoutMs = timeoutMs;
  }

  async #call(method, pathname, body, headers = {}) {
    const res = await this.fetch(`${this.base}${pathname}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = new Error(`${method} ${pathname} -> ${res.status}: ${data.error ?? text}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  heartbeat({ manager, agent, version, freeSlots, running }) {
    return this.#call('POST', '/managers/heartbeat', { manager, agent, version, freeSlots, running });
  }

  async lease({ manager, department, slots = 1, idempotencyKey }) {
    const headers = idempotencyKey ? { 'idempotency-key': idempotencyKey } : {};
    return (await this.#call('POST', '/tasks/lease', { manager, department, slots }, headers)).tasks;
  }

  progress(id, { manager, phase, note = '', tokens = 0 }) {
    return this.#call('POST', `/tasks/${id}/progress`, { manager, phase, note, tokens });
  }

  submit(id, { manager, pr, headSha, evidence }) {
    return this.#call('POST', `/tasks/${id}/submit`, { manager, pr, headSha, evidence });
  }

  fail(id, { manager, reason, logsUrl = null }) {
    return this.#call('POST', `/tasks/${id}/fail`, { manager, reason, logsUrl });
  }

  release(id, { manager, reason }) {
    return this.#call('POST', `/tasks/${id}/release`, { manager, reason });
  }

  agentSession(manager, body) {
    return this.#call('POST', `/managers/${encodeURIComponent(manager)}/agent-sessions`, body);
  }

  agentEvents(manager, sessionId, events) {
    return this.#call('POST', `/managers/${encodeURIComponent(manager)}/agent-events/${encodeURIComponent(sessionId)}`, { events });
  }

  async directives(manager, { after } = {}) {
    const query = after ? `?after=${encodeURIComponent(after)}` : '';
    return (await this.#call('GET', `/managers/${encodeURIComponent(manager)}/directives${query}`)).directives;
  }

  ackDirective(manager, id, body) {
    return this.#call('POST', `/managers/${encodeURIComponent(manager)}/directives/${encodeURIComponent(id)}/ack`, body);
  }

  async queue(department) {
    return (await this.#call('GET', `/departments/${department}/queue`)).tasks;
  }

  async getTask(id) {
    return (await this.#call('GET', `/tasks/${id}`)).task;
  }

  async health() {
    return this.#call('GET', '/health');
  }
}
