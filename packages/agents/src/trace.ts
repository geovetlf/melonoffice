import type { AuditEvent, AuditHistoryReader } from '@melonoffice/audit';
import type { AgentHandoff, AICallTrace, Execution, OrganizationId } from '@melonoffice/domain';
import type { AgentOutputStore } from '@melonoffice/execution';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { AI_REVIEW_NODE, parseAIReview } from './ai-review.js';
import type { AgentTaskService } from './tasks.js';

/**
 * Everything that happened in one agent task, read back for the person (ADR-0117): which agent
 * ran it, each step with its tool, approval, model and credits, the optional AI review, the
 * handoff it proposed and the task it handed to, the verification, and the audit trail of the
 * task and its handoff. It answers "how much did this task cost?" (`credits.total`, its own calls,
 * its review and its handed task) and "which agent spent these credits?" (`credits.byAgent`).
 *
 * Read only, as the person, with the same permissions as the task itself. Codes, ids and numbers
 * only: no answer text, no prompt, no secret, no identity beyond ids the person already reads.
 */

export const TRACE_LIMITS = Object.freeze({ history: 50 });

/** Milliseconds from `from` to `to`, when both are times and in order; otherwise null. */
export function durationOf(from: string | null | undefined, to: string | null | undefined) {
  if (from == null || to == null) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export interface AgentTaskTraceStep {
  readonly nodeId: string;
  readonly type: string;
  readonly status: string;
  readonly attempt: number;
  readonly tool: { readonly id: string; readonly version: number } | null;
  readonly approvalId: string | null;
  readonly approvalRequired: boolean;
  readonly error: string | null;
  readonly model: AgentTaskTraceModel | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** How long the step ran, once it ended (ADR-0119). */
  readonly durationMs: number | null;
}

export interface AgentTaskTraceModel {
  readonly provider: string;
  readonly model: string;
  readonly fallbackFrom: string | null;
  readonly credits: number;
  readonly attempts: number;
}

export interface AgentTaskTrace {
  readonly taskId: string;
  readonly specialistId: string;
  readonly specialistVersion: number;
  readonly parentTaskId: string | null;
  readonly status: string;
  readonly failure: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
  /** From the task's creation to its end, once it ended (ADR-0119). */
  readonly durationMs: number | null;
  readonly steps: readonly AgentTaskTraceStep[];
  readonly review: {
    readonly verdict: string;
    readonly reason: string;
    readonly model: AgentTaskTraceModel | null;
  } | null;
  readonly verification: {
    readonly result: string;
    readonly checks: readonly {
      readonly nodeId: string;
      readonly code: string;
      readonly result: string;
    }[];
  } | null;
  readonly handoff: {
    readonly state: string;
    readonly department: string;
    readonly receivingAgentId: string | null;
    readonly childTaskId: string | null;
  } | null;
  readonly subtasks: readonly {
    readonly taskId: string;
    readonly specialistId: string;
    readonly status: string;
    readonly credits: number;
  }[];
  readonly credits: {
    /** The task's own model calls. */
    readonly task: number;
    /** Its optional AI review. */
    readonly review: number;
    /** The tasks it handed on. */
    readonly subtasks: number;
    readonly total: number;
    readonly budget: number | null;
    readonly remaining: number | null;
    readonly byModel: readonly { readonly model: string; readonly credits: number }[];
    readonly byAgent: readonly { readonly specialistId: string; readonly credits: number }[];
  };
  readonly history: readonly {
    readonly action: string;
    readonly result: string;
    readonly at: string;
    readonly actor: string;
    readonly reason: string | null;
  }[];
}

const modelOf = (ai: AICallTrace | undefined): AgentTaskTraceModel | null =>
  ai === undefined
    ? null
    : {
        provider: ai.provider,
        model: ai.model,
        fallbackFrom: ai.fallbackFrom,
        credits: ai.creditsConsumed,
        attempts: ai.attempts,
      };

/** The kept model calls of an execution's agent nodes and its review, by node. */
async function callsOf(
  outputs: Pick<AgentOutputStore, 'find'>,
  tenant: TenantContext,
  execution: Pick<Execution, 'id' | 'nodes'>,
): Promise<Map<string, AICallTrace>> {
  const ids = [
    ...execution.nodes.filter((n) => n.type === 'agent').map((n) => n.id as string),
    AI_REVIEW_NODE,
  ];
  const records = await Promise.all(ids.map((id) => outputs.find(tenant, execution.id, id)));
  const calls = new Map<string, AICallTrace>();
  records.forEach((r, i) => {
    if (r?.ai !== undefined) calls.set(ids[i] as string, r.ai);
  });
  return calls;
}

const sum = (calls: Iterable<AICallTrace>) =>
  [...calls].reduce((total, c) => total + c.creditsConsumed, 0);

const historyOf = (events: readonly AuditEvent[]) =>
  [...events]
    .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0))
    .slice(-TRACE_LIMITS.history)
    .map((e) => ({
      action: e.action,
      result: e.result,
      at: e.occurredAt,
      actor: e.actor.type,
      reason: e.reason ?? null,
    }));

export async function readAgentTaskTrace(
  tenant: TenantContext,
  taskId: string,
  ports: {
    readonly tasks: Pick<AgentTaskService, 'get'>;
    readonly outputs: Pick<AgentOutputStore, 'find'>;
    readonly handoffs?: {
      get(tenant: TenantContext, taskId: string): Promise<AgentHandoff | undefined>;
    };
    readonly history?: AuditHistoryReader;
  },
): Promise<AgentTaskTrace> {
  // The task as the person reads it: another organization's, or one they may not read, refuses.
  const { task, execution } = await ports.tasks.get(tenant, taskId);
  const calls =
    execution === undefined
      ? new Map<string, AICallTrace>()
      : await callsOf(ports.outputs, tenant, execution);
  const reviewCall = calls.get(AI_REVIEW_NODE);
  const reviewRecord =
    execution === undefined
      ? undefined
      : await ports.outputs.find(tenant, execution.id, AI_REVIEW_NODE);
  const review =
    reviewRecord === undefined ? undefined : parseAIReview(reviewRecord.output.structured);
  const handoff =
    ports.handoffs === undefined ? undefined : await ports.handoffs.get(tenant, task.id);
  // The task it handed on (one level: a handed task never hands on again).
  const subtasks: { taskId: string; specialistId: string; status: string; credits: number }[] = [];
  const childModels: AICallTrace[] = [];
  if (handoff?.childTaskId !== undefined) {
    const child = await ports.tasks.get(tenant, handoff.childTaskId).catch(() => undefined);
    if (child !== undefined) {
      const childCalls =
        child.execution === undefined
          ? new Map<string, AICallTrace>()
          : await callsOf(ports.outputs, tenant, child.execution);
      childModels.push(...childCalls.values());
      subtasks.push({
        taskId: child.task.id,
        specialistId: child.task.specialistId,
        status: child.execution?.status ?? 'unknown',
        credits: sum(childCalls.values()),
      });
    }
  }
  const own = [...calls.entries()].filter(([id]) => id !== AI_REVIEW_NODE).map(([, c]) => c);
  const taskCredits = sum(own);
  const reviewCredits = reviewCall?.creditsConsumed ?? 0;
  const subtaskCredits = subtasks.reduce((t, s) => t + s.credits, 0);
  const byModel = new Map<string, number>();
  for (const c of [...calls.values(), ...childModels]) {
    const key = `${c.provider}/${c.model}`;
    byModel.set(key, (byModel.get(key) ?? 0) + c.creditsConsumed);
  }
  const byAgent = [
    { specialistId: task.specialistId as string, credits: taskCredits + reviewCredits },
    ...subtasks.map((s) => ({ specialistId: s.specialistId, credits: s.credits })),
  ];
  let history: AgentTaskTrace['history'] = [];
  if (ports.history !== undefined && isResolvedTenant(tenant)) {
    const organizationId = tenant.organizationId as OrganizationId;
    const [ofTask, ofHandoff] = await Promise.all([
      ports.history.history(
        organizationId,
        { type: 'execution', id: task.id },
        TRACE_LIMITS.history,
      ),
      handoff === undefined
        ? Promise.resolve([])
        : ports.history.history(
            organizationId,
            { type: 'agent_handoff', id: handoff.id },
            TRACE_LIMITS.history,
          ),
    ]);
    history = historyOf([...ofTask, ...ofHandoff]);
  }
  const total = taskCredits + reviewCredits + subtaskCredits;
  return Object.freeze({
    taskId: task.id,
    specialistId: task.specialistId,
    specialistVersion: task.specialistVersion,
    parentTaskId: task.parentTaskId ?? null,
    status: execution?.status ?? 'unknown',
    failure: execution?.failure?.code ?? null,
    createdAt: task.createdAt,
    completedAt: execution?.completedAt ?? null,
    durationMs: durationOf(task.createdAt, execution?.completedAt),
    steps: (execution?.nodes ?? []).map((n) => ({
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
    })),
    review:
      review === undefined
        ? null
        : { verdict: review.verdict, reason: review.reason, model: modelOf(reviewCall) },
    verification:
      execution?.verification === undefined
        ? null
        : {
            result: execution.verification.result,
            checks: execution.verification.nodes.flatMap((n) =>
              n.checks.map((c) => ({ nodeId: n.nodeId, code: c.code, result: c.result })),
            ),
          },
    handoff:
      handoff === undefined
        ? null
        : {
            state: handoff.state,
            department: handoff.department,
            receivingAgentId: handoff.receivingAgent?.specialistId ?? null,
            childTaskId: handoff.childTaskId ?? null,
          },
    subtasks,
    credits: {
      task: taskCredits,
      review: reviewCredits,
      subtasks: subtaskCredits,
      total,
      budget: task.maxCredits ?? null,
      remaining:
        task.maxCredits === undefined
          ? null
          : Math.max(0, task.maxCredits - taskCredits - reviewCredits),
      byModel: [...byModel.entries()].map(([model, credits]) => ({ model, credits })),
      byAgent,
    },
    history,
  });
}
