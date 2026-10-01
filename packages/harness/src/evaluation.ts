import type { AgentAutonomy, SpecialistStatus } from '@melonoffice/domain';
import type { ToolUseDecision } from './tools.js';

/**
 * The checks an agent's action passes before it runs (AE-4.4, ADR-0116), in the order Geovet set:
 * who the agent is, its status, the tenant, the department, the skill and tool, the permissions,
 * the policy, the level of autonomy, the risk, a person's approval, the budget and the task's
 * context. The first that fails stops the action, and its code is what the task records; nothing
 * after it runs. This is a pure function over facts the Harness read: it never reads a store, and
 * it never trusts what the model or a screen says.
 *
 * The Tool Gate checks the same execution again when the action runs (ADR-0026): permissions,
 * eligibility, approval and idempotency. This evaluation decides what is asked of the gate; it
 * never replaces it.
 */
export type AgentActionCheck =
  | 'identity'
  | 'status'
  | 'tenant'
  | 'department'
  | 'skill_and_tool'
  | 'permissions'
  | 'policy'
  | 'autonomy'
  | 'risk'
  | 'approval'
  | 'budget'
  | 'context';

/** Every check, in the order they run. */
export const AGENT_ACTION_CHECKS: readonly AgentActionCheck[] = Object.freeze([
  'identity',
  'status',
  'tenant',
  'department',
  'skill_and_tool',
  'permissions',
  'policy',
  'autonomy',
  'risk',
  'approval',
  'budget',
  'context',
]);

export interface AgentActionFacts {
  /** The organization the tenant resolved to, from the backend, never from the request. */
  readonly tenantOrganizationId: string | undefined;
  /** The execution the action belongs to. */
  readonly execution: {
    readonly organizationId: string;
    readonly status: string;
    readonly specialistId?: string;
    readonly specialistVersion?: number;
  };
  /** The agent as stored now: its organization, status and current version. Absent: not found. */
  readonly agent?: {
    readonly organizationId: string;
    readonly status: SpecialistStatus;
  };
  /** Whether the agent's department takes work. Absent: not known here (checked at activation). */
  readonly departmentActive?: boolean;
  /** Whether the agent's version's skills grant the tool, and the registry knows it. */
  readonly toolGranted: boolean;
  /** Whether the person the agent acts for holds every permission the tool needs. */
  readonly permissionsHeld: boolean;
  /** The decision of `authorizeToolUse` on the tool, the agent's level and the organization's rules. */
  readonly decision: ToolUseDecision;
}

export type AgentActionEvaluation =
  | {
      readonly outcome: 'run';
      readonly autonomy: AgentAutonomy;
      readonly passed: readonly AgentActionCheck[];
    }
  | {
      readonly outcome: 'approval_required';
      readonly autonomy: AgentAutonomy;
      readonly reason: Extract<ToolUseDecision, { decision: 'approval_required' }>['reason'];
      readonly passed: readonly AgentActionCheck[];
    }
  | {
      readonly outcome: 'refused';
      readonly autonomy: AgentAutonomy;
      /** The check that failed. */
      readonly check: AgentActionCheck;
      /** The stable code the task stops with. */
      readonly code: string;
      readonly passed: readonly AgentActionCheck[];
    };

/** The task's states in which an agent's action may still be decided. */
const ACTING = new Set(['running']);

export function evaluateAgentAction(facts: AgentActionFacts): AgentActionEvaluation {
  const { execution, agent, decision } = facts;
  const passed: AgentActionCheck[] = [];
  const refuse = (check: AgentActionCheck, code: string): AgentActionEvaluation =>
    Object.freeze({
      outcome: 'refused',
      autonomy: decision.autonomy,
      check,
      code,
      passed: Object.freeze([...passed]),
    });
  const pass = (check: AgentActionCheck) => passed.push(check);

  if (
    execution.specialistId === undefined ||
    execution.specialistVersion === undefined ||
    agent === undefined
  ) {
    return refuse('identity', 'agent_not_found');
  }
  pass('identity');
  if (agent.status !== 'active') {
    return refuse(
      'status',
      agent.status === 'paused'
        ? 'agent_paused'
        : agent.status === 'disabled'
          ? 'agent_disabled'
          : 'agent_not_active',
    );
  }
  pass('status');
  if (
    facts.tenantOrganizationId === undefined ||
    facts.tenantOrganizationId !== execution.organizationId ||
    agent.organizationId !== execution.organizationId
  ) {
    return refuse('tenant', 'tenant_mismatch');
  }
  pass('tenant');
  if (facts.departmentActive === false) return refuse('department', 'department_not_active');
  pass('department');
  if (!facts.toolGranted) return refuse('skill_and_tool', 'tool_not_granted');
  pass('skill_and_tool');
  if (!facts.permissionsHeld) return refuse('permissions', 'permission_not_held');
  pass('permissions');
  if (decision.decision === 'deny' && decision.reason === 'tool_denied') {
    return refuse('policy', 'tool_denied');
  }
  pass('policy');
  // The level of autonomy, the risk and a person's approval only ever add an approval: decided by
  // `authorizeToolUse`, they pass here and shape the outcome below.
  pass('autonomy');
  pass('risk');
  pass('approval');
  if (decision.decision === 'deny' && decision.reason === 'tool_call_limit_reached') {
    return refuse('budget', 'tool_call_limit_reached');
  }
  if (decision.decision === 'deny') return refuse('skill_and_tool', 'tool_not_granted');
  pass('budget');
  if (!ACTING.has(execution.status)) return refuse('context', 'execution_not_running');
  pass('context');
  return decision.decision === 'approval_required'
    ? Object.freeze({
        outcome: 'approval_required',
        autonomy: decision.autonomy,
        reason: decision.reason,
        passed: Object.freeze(passed),
      })
    : Object.freeze({ outcome: 'run', autonomy: decision.autonomy, passed: Object.freeze(passed) });
}
