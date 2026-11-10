#!/usr/bin/env node
// Minimal MCP Streamable HTTP -> stdio bridge for agent-comm.
//
// Each MCP session (Mcp-Session-Id) gets its own `node dist/index.js` child,
// so every remote agent is a separate agent-comm process. All children share
// one SQLite DB through AGENT_COMM_HOME (used as HOME -> ~/.agent-comm/).
// No dependencies; binds only to AGENT_COMM_MCP_HOST (the Tailscale IP).

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const HOST = process.env.AGENT_COMM_MCP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.AGENT_COMM_MCP_PORT || '3422', 10);
const SERVER_JS = process.env.AGENT_COMM_INDEX_JS;
const CHILD_HOME = process.env.AGENT_COMM_HOME;
const IDLE_MS = parseInt(process.env.AGENT_COMM_MCP_IDLE_MIN || '30', 10) * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const UNREGISTER_GRACE_MS = 2_000;
const MAX_BODY = 1024 * 1024;

if (!SERVER_JS || !CHILD_HOME) {
  console.error('AGENT_COMM_INDEX_JS and AGENT_COMM_HOME must be set');
  process.exit(1);
}

const sessions = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function createSession(peer) {
  const id = randomUUID();
  const child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      HOME: CHILD_HOME,
      // If the dashboard service is down, a child may serve it; keep it private.
      AGENT_COMM_HOST: process.env.AGENT_COMM_HOST || HOST,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const session = { id, child, pending: new Map(), lastSeen: Date.now(), peer };

  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Server-initiated notifications have no id; there is no GET stream, so drop them.
    if (msg.id === undefined || msg.id === null) return;
    const waiter = session.pending.get(String(msg.id));
    if (waiter) {
      session.pending.delete(String(msg.id));
      waiter(msg);
    }
  });
  child.stderr.on('data', (d) => process.stderr.write(`[${id.slice(0, 8)}] ${d}`));
  child.on('exit', (code) => {
    log('session ended', id, 'code', code);
    for (const waiter of session.pending.values()) {
      waiter(null);
    }
    session.pending.clear();
    sessions.delete(id);
  });

  sessions.set(id, session);
  log('session started', id, 'from', peer);
  return session;
}

function forward(session, msg) {
  session.lastSeen = Date.now();
  const hasId = msg.id !== undefined && msg.id !== null;
  session.child.stdin.write(JSON.stringify(msg) + '\n');
  if (!hasId) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const key = String(msg.id);
    const timer = setTimeout(() => {
      session.pending.delete(key);
      resolve({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'Request timed out' } });
    }, REQUEST_TIMEOUT_MS);
    session.pending.set(key, (reply) => {
      clearTimeout(timer);
      resolve(
        reply ?? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'Session closed' } },
      );
    });
  });
}

// Signs the agent off the bus before stopping its child process. Without this
// agent-comm keeps the agent "online" and its name cannot be registered again.
function closeSession(session) {
  if (!session.closing) {
    let unregister;
    try {
      unregister = forward(session, {
        jsonrpc: '2.0',
        id: `bridge-unregister-${session.id}`,
        method: 'tools/call',
        params: { name: 'comm_agents', arguments: { action: 'unregister' } },
      });
    } catch {
      unregister = Promise.resolve();
    }
    const grace = new Promise((resolve) => setTimeout(resolve, UNREGISTER_GRACE_MS));
    session.closing = Promise.race([unregister, grace]).then(() => session.child.kill('SIGTERM'));
  }
  return session.closing;
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...(payload ? { 'Content-Type': 'application/json' } : {}),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://bridge');
  if (url.pathname === '/health') {
    return send(res, 200, { status: 'ok', sessions: sessions.size });
  }
  if (url.pathname !== '/mcp') return send(res, 404, { error: 'Not found' });

  const sessionId = req.headers['mcp-session-id'];

  if (req.method === 'GET') {
    // No server-initiated stream support.
    return send(res, 405, undefined, { Allow: 'POST, DELETE' });
  }

  if (req.method === 'DELETE') {
    const session = sessionId && sessions.get(sessionId);
    if (!session) return send(res, 404, { error: 'Unknown session' });
    await closeSession(session);
    return send(res, 204);
  }

  if (req.method !== 'POST') return send(res, 405, undefined, { Allow: 'POST, DELETE' });

  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (err) {
    return send(res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message}` },
    });
  }

  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const isInit = messages.some((m) => m && m.method === 'initialize');

  let session;
  if (isInit) {
    session = createSession(req.socket.remoteAddress);
  } else {
    session = sessionId && sessions.get(sessionId);
    if (!session) {
      return send(res, 404, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'Session not found; re-initialize' },
      });
    }
  }

  const replies = (await Promise.all(messages.map((m) => forward(session, m)))).filter(Boolean);
  const headers = { 'Mcp-Session-Id': session.id };
  if (replies.length === 0) return send(res, 202, undefined, headers);
  return send(res, 200, Array.isArray(parsed) ? replies : replies[0], headers);
});

setInterval(() => {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (now - session.lastSeen > IDLE_MS) {
      log('session idle, closing', session.id);
      closeSession(session);
    }
  }
}, 60_000).unref();

function shutdown() {
  Promise.all([...sessions.values()].map(closeSession)).finally(() => process.exit(0));
  server.close();
  setTimeout(() => process.exit(0), UNREGISTER_GRACE_MS + 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => log(`agent-comm MCP bridge: http://${HOST}:${PORT}/mcp`));
