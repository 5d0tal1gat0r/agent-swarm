// The orchestrator's own MCP endpoint (POST /mcp, Streamable HTTP, JSON-RPC 2.0,
// one JSON reply per request, no sessions, no SSE). It does not touch the bus
// bridge (scripts/mcp-bridge.mjs). The HTTP layer (api.mjs) checks the bearer
// token; each tool then checks the role it needs (ARCHITECTURE 20 and 39).
import { validate } from '../../protocol/validate.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const RPC = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 };

class ToolError extends Error {}

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] });
const fail = (message) => ({ ...text(message), isError: true });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function tools({ store, departments, createEpic }) {
  return [
    {
      name: 'swarm_status', role: 'manager',
      description: 'Task counts per status, queued tasks per department, and the number of epics.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => {
        const tasks = store.listTasks();
        const byStatus = {};
        for (const t of tasks) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
        const queued = Object.fromEntries(Object.keys(departments.departments).map((d) => [d, store.queueOf(d).length]));
        return { tasks: tasks.length, byStatus, queued, epics: store.epicAges().size };
      },
    },
    {
      name: 'swarm_queue', role: 'manager',
      description: 'Queued tasks of one department, in lease order.',
      inputSchema: { type: 'object', required: ['department'], properties: { department: { type: 'string' } }, additionalProperties: false },
      run: ({ department }) => {
        if (!departments.departments[department]) throw new ToolError(`unknown department ${department}`);
        return { tasks: store.queueOf(department) };
      },
    },
    {
      name: 'swarm_task_get', role: 'manager',
      description: 'One task by id, such as T-0001.',
      inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', pattern: '^T-[0-9]{4,}$' } }, additionalProperties: false },
      run: ({ id }) => ({ task: store.getTask(id) }),
    },
    {
      name: 'swarm_epic_create', role: 'intake',
      description: 'Creates an epic (same path as POST /epics). repo defaults to the configured repo. Needs an intake token.',
      inputSchema: {
        type: 'object', required: ['title', 'body'], additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: { type: 'string', maxLength: 20000 },
          repo: { type: 'string' },
          issue: { type: ['integer', 'null'], minimum: 1 },
        },
      },
      run: (args) => {
        const body = { repo: departments.repo, ...args };
        const { ok, errors } = validate('api/epic.request', body);
        if (!ok) throw new ToolError(`invalid epic: ${errors.join('; ')}`);
        return { epic: createEpic(body) };
      },
    },
  ];
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Returns handle(message, manager) -> reply object, or null for a notification.
 * `manager` is the authenticated token record ({ name, roles, ... }).
 */
export function createMcp({ store, departments, createEpic, name = 'swarm-orchestrator', version = '1', log = console }) {
  const list = tools({ store, departments, createEpic });
  const byName = new Map(list.map((t) => [t.name, t]));

  function callTool(manager, params) {
    if (!isObject(params) || typeof params.name !== 'string') return { error: [RPC.params, 'tools/call needs params.name'] };
    const tool = byName.get(params.name);
    if (!tool) return { error: [RPC.params, `unknown tool ${params.name}`] };
    const args = params.arguments ?? {};
    if (!isObject(args)) return { error: [RPC.params, 'params.arguments must be an object'] };
    if (!manager.roles.includes(tool.role)) return { result: fail(`forbidden: ${tool.name} needs a token with the ${tool.role} role`) };
    const bad = checkArgs(tool.inputSchema, args);
    if (bad) return { result: fail(`invalid arguments: ${bad}`) };
    try {
      return { result: text(tool.run(args)) };
    } catch (err) {
      if (err instanceof ToolError || /^unknown (task|epic)|already exists/.test(err.message ?? '')) return { result: fail(err.message) };
      log.error?.(`[mcp] ${err.stack ?? err.message}`);
      return { error: [RPC.internal, 'internal error'] };
    }
  }

  function handle(message, manager) {
    if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(isObject(message) ? message.id : null, RPC.request, 'not a JSON-RPC 2.0 request');
    }
    const hasId = message.id !== undefined && message.id !== null;
    if (!hasId) return null; // notifications (notifications/initialized, ...) get no reply
    const { id, method, params } = message;
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        },
      };
    }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: list.map(({ name: n, description, inputSchema }) => ({ name: n, description, inputSchema })) } };
    }
    if (method === 'tools/call') {
      const out = callTool(manager, params);
      return out.error ? rpcError(id, ...out.error) : { jsonrpc: '2.0', id, result: out.result };
    }
    return rpcError(id, RPC.method, `method not found: ${method}`);
  }

  return { handle, toolNames: list.map((t) => t.name) };
}

// Minimal argument check against the small subset of JSON Schema the tools use.
function checkArgs(schema, args) {
  const problems = [];
  for (const key of schema.required ?? []) if (args[key] === undefined) problems.push(`${key} is required`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) { problems.push(`unknown argument ${key}`); continue; }
    const types = [].concat(rule.type);
    const kind = value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
    if (!types.includes(kind)) problems.push(`${key} must be ${types.join(' or ')}`);
    else if (typeof value === 'string' && rule.pattern && !new RegExp(rule.pattern).test(value)) problems.push(`${key} has a bad format`);
  }
  return problems.join('; ');
}
