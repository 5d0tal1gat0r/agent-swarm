// Normalized, redacted observable telemetry for one-shot model processes.
// Raw prompts, model content, auth material and environment values never leave
// the manager. The orchestrator receives only bounded operational facts.
import fs from 'node:fs';
import path from 'node:path';

const MAX_DETAIL = 4096;
const MAX_BATCH_BYTES = 256 * 1024;
const PROTECTED = new Set([
  'test.result', 'handoff', 'blocker', 'directive.queued', 'directive.applied', 'directive.failed',
  'session.completed', 'session.interrupted', 'session.failed', 'events.dropped',
]);
const FORBIDDEN_KEY = /^(auth|authorization|cookie|credentials?|env|environment|secret|accessToken|refreshToken|apiKey|prompt|content|response|stdout|stderr)$/i;

function boundedText(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function safeValue(key, value) {
  if (FORBIDDEN_KEY.test(key)) return '[redacted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/path/i.test(key) && path.isAbsolute(value)) return `[absolute]/${path.basename(value)}`;
    return boundedText(value, 1000);
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => (
    item === null || ['boolean', 'number'].includes(typeof item) ? item : boundedText(item, 1000)
  ));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([childKey, child]) => [
      childKey,
      FORBIDDEN_KEY.test(childKey) ? '[redacted]' : (child === null || ['boolean', 'number'].includes(typeof child) ? child : boundedText(child, 1000)),
    ]));
  }
  return boundedText(value, 1000);
}

export function redactAgentEvent(event) {
  const safe = {
    managerSeq: event.managerSeq,
    sessionId: boundedText(event.sessionId, 160),
    assignmentId: boundedText(event.assignmentId, 160),
    parentId: event.parentId == null ? null : boundedText(event.parentId, 160),
    manager: boundedText(event.manager, 100),
    taskId: boundedText(event.taskId, 160),
    at: event.at,
    type: event.type,
    phase: event.phase == null ? null : boundedText(event.phase, 80),
    summary: boundedText(event.summary || event.type, 500),
    data: Object.fromEntries(Object.entries(event.data ?? {}).slice(0, 32).map(([key, value]) => [key, safeValue(key, value)])),
  };
  if (Buffer.byteLength(JSON.stringify(safe.data), 'utf8') > MAX_DETAIL) {
    const compact = {};
    for (const [key, value] of Object.entries(safe.data)) {
      compact[key] = typeof value === 'string' ? boundedText(value, 200) : value;
      if (Buffer.byteLength(JSON.stringify(compact), 'utf8') > MAX_DETAIL - 100) {
        delete compact[key];
        break;
      }
    }
    compact.truncated = true;
    safe.data = compact;
  }
  return safe;
}

function tokenDetail(kind, reply) {
  if (kind === 'claude') {
    try {
      const usage = JSON.parse(reply)?.usage;
      if (!usage) return null;
      return { inputTokens: Number(usage.input_tokens ?? 0) + Number(usage.cache_creation_input_tokens ?? 0), outputTokens: Number(usage.output_tokens ?? 0) };
    } catch { return null; }
  }
  if (kind === 'gemini') {
    try {
      const data = JSON.parse(reply);
      const tokens = data?.stats?.tokens ?? data?.usageMetadata ?? {};
      return { inputTokens: Number(tokens.prompt ?? tokens.input ?? tokens.promptTokenCount ?? 0), outputTokens: Number(tokens.candidates ?? tokens.output ?? tokens.candidatesTokenCount ?? 0) };
    } catch { return null; }
  }
  return null;
}

export function createAgentEventNormalizer({ kind, assignmentId, sessionId, taskId, manager, clock = { now: () => Date.now() }, emit }) {
  let managerSeq = 0;
  let buffer = '';
  let phase = null;
  let sawTokens = false;
  const publish = (type, summary, data = {}, nextPhase = phase) => {
    managerSeq += 1;
    const event = redactAgentEvent({
      managerSeq, sessionId, assignmentId, parentId: manager, manager, taskId,
      at: new Date(clock.now()).toISOString(), type, phase: nextPhase, summary, data,
    });
    try { emit(event); } catch { /* telemetry must never crash the model */ }
    return event;
  };
  publish('session.started', `${kind} session started`, { kind });

  const parseStructured = (line) => {
    let item;
    try { item = JSON.parse(line); } catch { return; }
    if (kind === 'codex') {
      if (item.type === 'turn.started') {
        phase = 'implement';
        publish('phase.changed', 'Agent turn started', {}, phase);
      } else if (item.type === 'item.started' && item.item?.type === 'command_execution') {
        publish('command.started', 'Command started', { command: item.item.command });
      } else if (item.type === 'item.completed' && item.item?.type === 'command_execution') {
        publish('command.completed', 'Command completed', { command: item.item.command, exitCode: item.item.exit_code });
      } else if (item.type === 'item.started' && item.item?.type === 'mcp_tool_call') {
        publish('tool.started', `Tool ${boundedText(item.item.name ?? 'call', 80)} started`, { tool: item.item.name });
      } else if (item.type === 'item.completed' && item.item?.type === 'mcp_tool_call') {
        publish('tool.completed', `Tool ${boundedText(item.item.name ?? 'call', 80)} completed`, { tool: item.item.name });
      } else if (item.type === 'turn.completed' && item.usage) {
        sawTokens = true;
        publish('tokens', 'Token usage updated', {
          inputTokens: Math.max(0, Number(item.usage.input_tokens ?? 0) - Number(item.usage.cached_input_tokens ?? 0)),
          outputTokens: Number(item.usage.output_tokens ?? 0),
        });
      }
    } else if (kind === 'antigravity') {
      if (item.event === 'tool_start') publish('tool.started', `Tool ${boundedText(item.tool?.name ?? 'call', 80)} started`, { tool: item.tool?.name, path: item.tool?.path });
      if (item.event === 'tool_result') publish('tool.completed', `Tool ${boundedText(item.tool?.name ?? 'call', 80)} completed`, { tool: item.tool?.name, status: item.tool?.status });
      if (item.event === 'result' && item.result?.usage) {
        sawTokens = true;
        publish('tokens', 'Token usage updated', {
          inputTokens: Number(item.result.usage.input_tokens ?? 0),
          outputTokens: Number(item.result.usage.output_tokens ?? 0) + Number(item.result.usage.thinking_tokens ?? 0),
        });
      }
    }
  };

  const stdout = (chunk) => {
    if (!['codex', 'antigravity'].includes(kind)) return;
    buffer += String(chunk);
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) parseStructured(line);
  };
  const stderr = () => {};
  const host = (type, data = {}) => {
    const { summary = type, phase: nextPhase = phase, ...detail } = data;
    phase = nextPhase;
    return publish(type, summary, detail, phase);
  };
  const finish = (result = {}) => {
    if (buffer.trim() && ['codex', 'antigravity'].includes(kind)) parseStructured(buffer);
    buffer = '';
    if (!sawTokens && result.reply) {
      const detail = tokenDetail(kind, result.reply);
      if (detail) publish('tokens', 'Token usage updated', detail);
    }
    const code = result.code ?? 0;
    if (result.interrupted) publish('session.interrupted', `${kind} session interrupted`, { code });
    else if (code === 0) publish('session.completed', `${kind} session completed`, { code });
    else publish('session.failed', `${kind} session failed`, { code });
  };
  return { stdout, stderr, host, finish };
}

function atomicWrite(file, events) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(events), { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}

export function createAgentEventSpool({ dir, maxBytes = 10 * 1024 * 1024, sendBatch, clock = { now: () => Date.now() } }) {
  const file = path.join(dir, 'agent-events.json');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let events = [];
  try {
    events = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(events)) events = [];
  } catch { events = []; }
  let dropped = 0;

  const persist = () => atomicWrite(file, events);
  const trim = () => {
    while (Buffer.byteLength(JSON.stringify(events), 'utf8') > maxBytes) {
      const index = events.findIndex((item) => !PROTECTED.has(item.type));
      if (index < 0) break;
      const removed = events.splice(index, 1)[0];
      dropped += removed.type === 'events.dropped' ? Number(removed.data?.count ?? 0) : 1;
    }
    if (dropped > 0 && !events.some((item) => item.type === 'events.dropped')) {
      const anchor = events[0] ?? {
        managerSeq: 1, sessionId: 'unknown', assignmentId: 'unknown', parentId: null,
        manager: 'unknown', taskId: 'T-0000', phase: null,
      };
      events.unshift(redactAgentEvent({ ...anchor, at: new Date(clock.now()).toISOString(), type: 'events.dropped', summary: `${dropped} telemetry events dropped`, data: { count: dropped } }));
    } else {
      const marker = events.find((item) => item.type === 'events.dropped');
      if (marker) { marker.data.count = dropped; marker.summary = `${dropped} telemetry events dropped`; }
    }
  };

  const append = (event) => {
    events.push(redactAgentEvent(event));
    trim();
    persist();
  };
  const flush = async () => {
    while (events.length) {
      const batch = [];
      for (const event of events) {
        if (batch.length >= 100) break;
        if (batch.length && event.sessionId !== batch[0].sessionId) break;
        if (batch.length && Buffer.byteLength(JSON.stringify({ events: [...batch, event] }), 'utf8') > MAX_BATCH_BYTES) break;
        batch.push(event);
      }
      const reply = await sendBatch(batch);
      const accepted = new Set(reply?.accepted ?? batch.map((item) => item.managerSeq));
      if (!accepted.size) return;
      const before = events.length;
      events = events.filter((item, index) => index >= batch.length || !accepted.has(item.managerSeq));
      if (events.length === before) return;
      persist();
    }
  };
  const close = () => persist();
  persist();
  return { append, flush, close };
}
