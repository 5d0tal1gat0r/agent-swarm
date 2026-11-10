// Permission and validation boundary for the dashboard agent cockpit. The API
// supplies the authenticated token record; this module never trusts UI state.
import { assertValid } from '../../protocol/validate.mjs';
import { canActOnManager } from './controls.mjs';
import { validateModel } from './config.mjs';

const INSTALLED_ROLES = new Set(['explorer', 'implementer', 'test-writer', 'fixer', 'checker', 'doc-writer']);
const OWNER_ONLY_DIRECTIVES = new Set(['interrupt', 'stop']);

export class AgentControlError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'AgentControlError';
    this.status = status;
    Object.assign(this, extra);
  }
}

const isOwner = (who) => Boolean(who?.roles?.includes('owner'));
const isManager = (who) => Boolean(who?.roles?.includes('manager'));

function canonicalCovers(canonical, requested) {
  if (canonical === requested) return true;
  if (!canonical.endsWith('/**')) return false;
  const base = canonical.slice(0, -3);
  return requested === base || requested.startsWith(`${base}/`);
}

function maxRuntime(policy, task) {
  if (Number.isInteger(policy.limits?.maxTaskMinutes)) return policy.limits.maxTaskMinutes;
  const configured = Object.values(policy.budgets ?? {}).map((budget) => budget?.minutes).filter(Number.isInteger);
  return Math.max(task?.budget?.minutes ?? 1, ...configured, 1);
}

export function createAgentControl({ store, policy, departments, tokens, clock = { now: () => Date.now() } }) {
  const assignmentOf = (id) => {
    try {
      return store.getAgentAssignment(id);
    } catch {
      throw new AgentControlError(404, `unknown agent assignment ${id}`);
    }
  };

  const canReadSummary = (who) => Boolean(who?.roles?.some((role) => ['owner', 'manager', 'dashboard'].includes(role)));

  const canDirect = (who, id) => {
    const assignment = assignmentOf(id);
    if (isOwner(who)) return true;
    if (assignment.kind === 'orchestrator') return isManager(who);
    return Boolean(assignment.manager && canActOnManager(who, assignment.manager, tokens));
  };

  const canReadDetail = (who, id) => canDirect(who, id);

  const resolveWriteTarget = (target) => {
    try {
      return store.getAgentAssignment(target);
    } catch {
      try {
        const session = store.getAgentSession(target);
        throw new AgentControlError(409, `${target} is a one-turn session; write to ${session.assignmentId}`, {
          assignmentId: session.assignmentId,
        });
      } catch (error) {
        if (error instanceof AgentControlError) throw error;
        throw new AgentControlError(404, `unknown agent target ${target}`);
      }
    }
  };

  const assertDirectiveAllowed = (who, target, kind) => {
    const assignment = resolveWriteTarget(target);
    if (!canDirect(who, assignment.id)) throw new AgentControlError(403, `${who?.name ?? 'viewer'} may not direct ${assignment.id}`);
    if (OWNER_ONLY_DIRECTIVES.has(kind) && !isOwner(who)) throw new AgentControlError(403, `${kind} is owner-only`);
    return assignment;
  };

  const validateContext = (who, target, context) => {
    const assignment = assertDirectiveAllowed(who, target, 'context');
    assertValid('agent-context', context);
    const task = assignment.taskId ? store.getTask(assignment.taskId) : null;

    if (context.sessionSkills) {
      for (const role of context.sessionSkills.roles) {
        if (!INSTALLED_ROLES.has(role)) throw new AgentControlError(400, `${role} is not an installed role`);
      }
    }

    if (context.guardrails?.allowedPaths) {
      const canonical = task?.paths ?? [];
      for (const requested of context.guardrails.allowedPaths) {
        if (!canonical.some((path) => canonicalCovers(path, requested))) {
          throw new AgentControlError(400, `${requested} would widen the canonical task paths`);
        }
      }
    }

    if (context.model !== undefined && context.model !== null) {
      if (!isOwner(who)) throw new AgentControlError(403, 'model changes are owner-only');
      const agentKind = store.latestAgentSession(assignment.id)?.agentKind
        ?? departments.departments?.[task?.department]?.agent;
      validateModel(policy, agentKind, context.model);
    }

    if (context.runtimeMinutes !== undefined && context.runtimeMinutes !== null) {
      if (context.runtimeMinutes > maxRuntime(policy, task)) throw new AgentControlError(400, 'runtime exceeds the policy maximum');
      const current = assignment.runtimeMinutes ?? task?.budget?.minutes ?? 1;
      if (context.runtimeMinutes > current && !isOwner(who)) throw new AgentControlError(403, 'runtime increases are owner-only');
    }

    return structuredClone(context);
  };

  return {
    clock,
    canReadSummary,
    canReadDetail,
    canDirect,
    canPromptOrchestrator: (who) => isManager(who),
    resolveWriteTarget,
    assertDirectiveAllowed,
    validateContext,
  };
}
