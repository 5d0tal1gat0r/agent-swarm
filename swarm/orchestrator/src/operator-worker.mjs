// Durable, globally serialized orchestrator conversation worker. The model may
// propose only typed actions; mutations stay pending until a person confirms.
const ACTIONS = new Set(['create_epic', 'plan_epic', 'request_status', 'replan_task', 'prompt_manager', 'prompt_subagent']);

function plainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function exactKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

function actionPayload(kind, payload) {
  if (!plainObject(payload)) throw new Error(`${kind} payload must be an object`);
  if (kind === 'create_epic') {
    if (!exactKeys(payload, ['title', 'body']) || typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 200 || typeof payload.body !== 'string' || payload.body.length > 8000) throw new Error('invalid create_epic payload');
  } else if (kind === 'plan_epic') {
    if (!exactKeys(payload, ['epicId', 'dryRun']) || !/^E-[0-9]{4,}$/.test(payload.epicId) || typeof payload.dryRun !== 'boolean') throw new Error('invalid plan_epic payload');
  } else if (kind === 'request_status') {
    if (!exactKeys(payload, ['target']) || typeof payload.target !== 'string' || !payload.target || payload.target.length > 160) throw new Error('invalid request_status payload');
  } else if (kind === 'replan_task') {
    if (!exactKeys(payload, ['taskId']) || !/^T-[0-9]{4,}$/.test(payload.taskId)) throw new Error('invalid replan_task payload');
  } else if (kind === 'prompt_manager') {
    if (!exactKeys(payload, ['target', 'text']) || typeof payload.target !== 'string' || !payload.target || typeof payload.text !== 'string' || !payload.text || payload.text.length > 8192) throw new Error('invalid prompt_manager payload');
  } else if (kind === 'prompt_subagent') {
    if (!exactKeys(payload, ['targetAssignmentOrStableName', 'text']) || typeof payload.targetAssignmentOrStableName !== 'string' || !payload.targetAssignmentOrStableName || typeof payload.text !== 'string' || !payload.text || payload.text.length > 8192) throw new Error('invalid prompt_subagent payload');
  }
  return structuredClone(payload);
}

export function parseOperatorReply(raw) {
  let value;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
  } catch {
    throw new Error('invalid operator reply: expected one JSON object');
  }
  if (!exactKeys(value, ['reply', 'proposedActions']) || typeof value.reply !== 'string' || !value.reply.trim() || Buffer.byteLength(value.reply, 'utf8') > 8192 || !Array.isArray(value.proposedActions) || value.proposedActions.length > 20) {
    throw new Error('invalid operator reply: expected { reply, proposedActions[] }');
  }
  return {
    reply: value.reply,
    proposedActions: value.proposedActions.map((action) => {
      if (!exactKeys(action, ['kind', 'payload']) || !ACTIONS.has(action.kind)) throw new Error(`invalid operator reply: unknown action ${action?.kind}`);
      return { kind: action.kind, payload: actionPayload(action.kind, action.payload) };
    }),
  };
}

function boundedJson(value, max = 64 * 1024) {
  const text = JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function promptFor(turn, messages, context) {
  return [
    'You are the swarm operator assistant. Return JSON only: {"reply":"...","proposedActions":[{"kind":"...","payload":{}}]}.',
    'Allowed actions: create_epic, plan_epic, request_status, replan_task, prompt_manager, prompt_subagent.',
    'Never emit shell commands, URLs to call, hidden reasoning, secrets, or an action outside that list.',
    `Target: ${turn.conversationTarget}`,
    `Recent messages: ${boundedJson(messages.map(({ role, actor, text, createdAt }) => ({ role, actor, text, createdAt })))}`,
    `Current context: ${boundedJson(context)}`,
  ].join('\n\n');
}

export function createOperatorWorker({ store, callModel, applyAction, contextFor, clock = { now: () => Date.now() }, timeoutMs = 600_000, log = console }) {
  let running = null;
  const enabled = typeof callModel === 'function';

  const runOne = async () => {
    if (!enabled) return null;
    const turn = store.claimNextOperatorTurn();
    if (!turn) return null;
    const messages = store.agentMessages(turn.conversationTarget, { limit: 20 });
    const context = await contextFor(turn.conversationTarget);
    const prompt = promptFor(turn, messages, context);
    let parsed;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const raw = await callModel({ model: context.model, prompt: attempt === 0 ? prompt : `${prompt}\n\nYour previous reply was invalid (${lastError.message}). Return the JSON object only.`, timeoutMs, clock });
        parsed = parseOperatorReply(raw);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!parsed) {
      const message = `invalid operator reply after repair: ${lastError?.message ?? 'unknown error'}`.slice(0, 1000);
      log.error?.(`[operator] ${turn.id}: ${message}`);
      return store.finishOperatorTurn(turn.id, { status: 'failed', error: message });
    }

    store.appendAgentMessage({ target: turn.conversationTarget, actor: 'orchestrator', role: 'assistant', text: parsed.reply });
    const actions = store.createOperatorActions(turn.id, parsed.proposedActions);
    for (const action of actions.filter((item) => item.kind === 'request_status')) {
      try {
        const result = await applyAction(action, { actor: 'orchestrator', reason: 'automatic read-only status request' });
        store.resolveOperatorAction(action.id, {
          status: 'applied', actor: 'orchestrator', reason: 'automatic read-only status request', result,
          idempotencyKey: `auto-${action.id}`,
        });
      } catch (error) {
        store.resolveOperatorAction(action.id, {
          status: 'failed', actor: 'orchestrator', reason: 'automatic read-only status request', result: { error: String(error.message ?? error).slice(0, 500) },
          idempotencyKey: `auto-${action.id}`,
        });
      }
    }
    return store.finishOperatorTurn(turn.id, { status: 'succeeded' });
  };

  const tick = () => {
    if (running) return running;
    running = runOne().finally(() => { running = null; });
    return running;
  };

  const confirmAction = async (id, { actor, reason, idempotencyKey }) => {
    const action = store.getOperatorAction(id);
    if (action.status === 'applied') return action;
    if (action.status !== 'pending' && action.status !== 'confirmed') throw new Error(`${id} is already ${action.status}`);
    const result = await applyAction(action, { actor, reason });
    return store.resolveOperatorAction(id, { status: 'applied', actor, reason, result, idempotencyKey });
  };

  const cancelAction = async (id, { actor, reason, idempotencyKey }) => {
    const action = store.getOperatorAction(id);
    if (action.status === 'cancelled') return action;
    if (action.status !== 'pending') throw new Error(`${id} is already ${action.status}`);
    return store.resolveOperatorAction(id, { status: 'cancelled', actor, reason, idempotencyKey });
  };

  return { enabled, tick, confirmAction, cancelAction };
}
