import type { AuditEvent, AuditHistoryReader } from '@melonoffice/audit';
import type {
  AICallTrace,
  Execution,
  ExecutionId,
  OrganizationId,
  Plan,
  PlanVersion,
} from '@melonoffice/domain';
import type { AgentOutputStore } from '@melonoffice/execution';
import type { PlanSpending } from '@melonoffice/planning';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import {
  callsOf,
  creditsOf,
  durationOf,
  modelOf,
  TRACE_LIMITS,
  type AgentTaskTraceStep,
} from './trace.js';

/**
 * Everything that happened in one plan, read back for the person (ADR-0157), as the agent task
 * trace does for one task (ADR-0117): where the plan stopped and why, and for each step every run
 * of it (ADR-0153) with its nodes, tools, approvals, models, credits, times and errors, its wait or
 * its decision, and the audit trail of the plan and its steps. It answers "what happened in this
 * plan, and what did it cost?".
 *
 * Read only, as the person, through the same plan and execution services as the plan's steps.
 * Codes, ids, times and numbers only: no answer text, no tool result, no prompt, no secret.
 */

export interface PlanTraceAttempt {
  readonly attempt: number;
  readonly executionId: string;
  readonly status: string;
  readonly failure: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly nodes: readonly AgentTaskTraceStep[];
  readonly credits: number;
}

export interface PlanTraceStep {
  readonly stepId: string;
  readonly kind: string;
  readonly label: string;
  readonly dependsOn: readonly string[];
  /** Who runs it: the agent and its version, on a specialist step. */
  readonly specialist: { readonly id: string; readonly version: number } | null;
  /** On a tool step: the tool and the step that runs it. */
  readonly tool: { readonly id: string; readonly version: number } | null;
  readonly performedBy: string | null;
  /** Each run of a specialist step, first to last (ADR-0153). */
  readonly attempts: readonly PlanTraceAttempt[];
  /** The approvals recorded under it (ADR-0146), or under a tool step its own (ADR-0151). */
  readonly approvals: readonly {
    readonly entry: string;
    readonly approvalId: string;
    readonly requestedAt: string;
    readonly declined: string | null;
  }[];
  /** On a wait step that started (ADR-0152). */
  readonly wait: { readonly startedAt: string; readonly until: string } | null;
  /** On a condition step once decided (WF-4): its result and the decision's outcome. */
  readonly condition: {
    readonly result: string;
    readonly outcome: string | null;
    readonly failure: string | null;
  } | null;
  readonly credits: number;
}

export interface PlanTrace {
  readonly planId: string;
  readonly status: string;
  readonly version: number;
  /** The workflow and its version that made this plan, when one did (ADR-0179). */
  readonly workflow: { readonly id: string; readonly version: number } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Why it stopped (ADR-0155): its code, the step and that step's own code. */
  readonly failure: {
    readonly code: string;
    readonly stepId: string | null;
    readonly cause: string | null;
  } | null;
  readonly steps: readonly PlanTraceStep[];
  readonly credits: {
    readonly total: number;
    readonly byStep: readonly { readonly stepId: string; readonly credits: number }[];
    readonly byModel: readonly { readonly model: string; readonly credits: number }[];
  };
  readonly history: readonly {
    readonly action: string;
    readonly result: string;
    readonly at: string;
    readonly actor: string;
    /** The person who acted, or for whom the runtime acted (ADR-0179). */
    readonly actorId: string | null;
    readonly nodeId: string | null;
    readonly reason: string | null;
    readonly reference: string | null;
  }[];
}

/** An execution's nodes as the trace shows them, with each agent node's model and credits. */
const nodesOf = (
  execution: Execution,
  calls: ReadonlyMap<string, AICallTrace>,
): AgentTaskTraceStep[] =>
  execution.nodes.map((n) => ({
    nodeId: n.id,
    type: n.type,
    status: n.status,
    attempt: n.attempt ?? 1,
    tool: n.tool === undefined ? null : { id: n.tool.id, version: n.tool.version },
    approvalId: n.approvalId ?? null,
    approvalRequired: n.approvalRequired === true,
    error: n.error?.code ?? null,
    model: modelOf(calls.get(n.id)),
    startedAt: n.startedAt ?? null,
    completedAt: n.completedAt ?? null,
    durationMs: durationOf(n.startedAt, n.completedAt),
  }));

const byTime = (a: AuditEvent, b: AuditEvent) =>
  a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0;

export async function readPlanTrace(
  tenant: TenantContext,
  planId: string,
  ports: {
    readonly plans: {
      get(tenant: TenantContext, id: string): Promise<Plan>;
      getVersion(tenant: TenantContext, id: string, version: number): Promise<PlanVersion>;
    };
    readonly executions: { get(tenant: TenantContext, id: string): Promise<Execution> };
    readonly outputs: Pick<AgentOutputStore, 'find'>;
    readonly history?: AuditHistoryReader;
  },
): Promise<PlanTrace> {
  // The plan as the person reads it: another organization's, or one they may not read, refuses.
  const plan = await ports.plans.get(tenant, planId);
  const version = await ports.plans.getVersion(tenant, plan.id, plan.version);
  /** An execution the plan names, or nothing when it is not there (yet). */
  const find = (id: string) => ports.executions.get(tenant, id).catch(() => undefined);

  // Every child the plan ever had, each with the run of its step it was (ADR-0153).
  const runs = [
    ...plan.delegations.map((d) => ({ stepId: d.stepId, executionId: d.executionId, attempt: 1 })),
    ...(plan.attempts ?? []).map((a) => ({
      stepId: a.stepId,
      executionId: a.executionId,
      attempt: a.attempt,
    })),
  ];
  const byModel = new Map<string, number>();
  const attemptsOf = new Map<string, PlanTraceAttempt[]>();
  for (const run of runs) {
    const execution = await find(run.executionId);
    if (execution === undefined) continue;
    const calls = await callsOf(ports.outputs, tenant, execution);
    for (const c of calls.values()) {
      const key = `${c.provider}/${c.model}`;
      byModel.set(key, (byModel.get(key) ?? 0) + c.creditsConsumed);
    }
    const list = attemptsOf.get(run.stepId) ?? [];
    list.push({
      attempt: run.attempt,
      executionId: execution.id,
      status: execution.status,
      failure: execution.failure?.code ?? null,
      startedAt: execution.startedAt ?? null,
      completedAt: execution.completedAt ?? null,
      durationMs: durationOf(execution.startedAt, execution.completedAt),
      nodes: nodesOf(execution, calls),
      credits: creditsOf(calls.values()),
    });
    attemptsOf.set(run.stepId, list);
  }

  const steps = version.steps.map((step): PlanTraceStep => {
    const attempts = (attemptsOf.get(step.id) ?? []).sort((a, b) => a.attempt - b.attempt);
    const wait = plan.waits?.find((w) => w.stepId === step.id);
    const condition = plan.conditions?.find((c) => c.stepId === step.id);
    return {
      stepId: step.id,
      kind: step.kind,
      label: step.label,
      dependsOn: [...step.dependsOn],
      specialist:
        step.specialist === undefined
          ? null
          : { id: step.specialist.id, version: step.specialist.version },
      tool: step.tool === undefined ? null : { id: step.tool.id, version: step.tool.version },
      performedBy: step.performedBy ?? null,
      attempts,
      approvals: (plan.stepApprovals ?? [])
        .filter((a) => a.stepId === step.id)
        .map((a) => ({
          entry: a.stepId,
          approvalId: a.approvalId,
          requestedAt: a.requestedAt,
          declined: a.declined?.reason ?? null,
        })),
      wait: wait === undefined ? null : { startedAt: wait.startedAt, until: wait.until },
      condition:
        condition === undefined
          ? null
          : {
              result: condition.result,
              outcome: condition.decision?.outcome ?? null,
              failure: condition.failure ?? null,
            },
      credits: attempts.reduce((t, a) => t + a.credits, 0),
    };
  });

  // Where it stopped (ADR-0155): the planning execution's failure points at the failed child.
  const parent = await find(plan.executionId);
  const failedRun =
    parent?.failure?.ref?.type === 'execution'
      ? runs.find((r) => r.executionId === parent.failure?.ref?.id)
      : undefined;
  const failedChild =
    failedRun === undefined
      ? undefined
      : attemptsOf.get(failedRun.stepId)?.find((a) => a.executionId === failedRun.executionId);

  let history: PlanTrace['history'] = [];
  if (ports.history !== undefined && isResolvedTenant(tenant)) {
    const organizationId = tenant.organizationId as OrganizationId;
    const reader = ports.history;
    const targets = [
      { type: 'plan', id: plan.id },
      ...runs.map((r) => ({ type: 'execution', id: r.executionId as string })),
      // Who decided each step's approval, and when (ADR-0179).
      ...(plan.stepApprovals ?? []).map((a) => ({ type: 'approval', id: a.approvalId })),
    ];
    const events = (
      await Promise.all(targets.map((t) => reader.history(organizationId, t, TRACE_LIMITS.history)))
    ).flat();
    history = [...events]
      .sort(byTime)
      .slice(-TRACE_LIMITS.history)
      .map((e) => ({
        action: e.action,
        result: e.result,
        at: e.occurredAt,
        actor: e.actor.type,
        actorId:
          e.actor.type === 'user'
            ? e.actor.userId
            : e.actor.type === 'system'
              ? e.actor.initiatedBy
              : null,
        nodeId: e.nodeId ?? null,
        reason: e.reason ?? null,
        reference: e.reference ?? null,
      }));
  }

  const total = steps.reduce((t, s) => t + s.credits, 0);
  return Object.freeze({
    planId: plan.id,
    status: plan.status,
    version: plan.version,
    workflow:
      version.source.kind === 'workflow'
        ? { id: version.source.workflowId, version: version.source.workflowVersion }
        : null,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    failure:
      parent?.failure === undefined
        ? null
        : {
            code: parent.failure.code,
            stepId: failedRun?.stepId ?? null,
            cause: failedChild?.failure ?? null,
          },
    steps,
    credits: {
      total,
      byStep: steps
        .filter((s) => s.credits > 0)
        .map((s) => ({ stepId: s.stepId, credits: s.credits })),
      byModel: [...byModel.entries()].map(([model, credits]) => ({ model, credits })),
    },
    history,
  });
}

/**
 * What a plan's runs used (ADR-0163), for its approved credit budget: the credits the Credit
 * Core charged for each child's AI calls, from the same records the trace reads. Read as the
 * tenant the conductor acts for: another organization's run, or one not created yet, adds
 * nothing.
 */
export function createPlanSpending(ports: {
  readonly executions: { get(tenant: TenantContext, id: string): Promise<Execution> };
  readonly outputs: Pick<AgentOutputStore, 'find'>;
}): PlanSpending {
  return Object.freeze({
    async used(tenant: TenantContext, executionIds: readonly ExecutionId[]) {
      let total = 0;
      for (const id of new Set(executionIds)) {
        const execution = await ports.executions.get(tenant, id).catch((error: unknown) => {
          if ((error as { code?: unknown }).code === 'execution_not_found') return undefined;
          throw error;
        });
        if (execution === undefined) continue;
        total += creditsOf((await callsOf(ports.outputs, tenant, execution)).values());
      }
      return total;
    },
  });
}
