import { createPlanSpending } from '@melonoffice/agents';
import type { AIUsageSink } from '@melonoffice/ai-usage';
import {
  createAIGateway,
  createModelPolicyCatalogue,
  DEFAULT_MODEL_POLICY,
  type AICreditsPort,
  type CreditRate,
  type ModelPolicyCatalogue,
  type ProviderRegistry,
} from '@melonoffice/ai-gateway';
import {
  createApprovalService,
  createPlanStepApprovals,
  type ApprovalRepository,
} from '@melonoffice/approvals';
import { createAuditService, type AuditStore } from '@melonoffice/audit';
import type { DepartmentRepository } from '@melonoffice/departments';
import type {
  AIDataPolicy,
  DeploymentEnvironment,
  OrganizationId,
  PlanId,
} from '@melonoffice/domain';
import {
  createExecutionService,
  type AgentOutputStore,
  type ExecutionRepository,
} from '@melonoffice/execution';
import { createToolGate } from '@melonoffice/guardrails';
import { createJobService, type JobRepository, type JobService } from '@melonoffice/jobs';
import type { EventBus } from '@melonoffice/events';
import type { Logger } from '@melonoffice/observability';
import {
  createPlanConductor,
  createPlanStepAttempts,
  planStepOf,
  type ConditionEvaluator,
  type PlanRepository,
  type PlanWakeups,
} from '@melonoffice/planning';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createRuntime,
  type AgentOutputSink,
  type AgentToolLoop,
  type ExecutionEndHook,
  type ExecutionStopHook,
  type JobDispatcher,
  type NodeWorkSource,
  type Runtime,
  type RuntimeServices,
  type VerificationSource,
} from '@melonoffice/runtime';
import { createSpecialistService, type SpecialistRepository } from '@melonoffice/specialists';
import type { TenancyStore, TenantContext } from '@melonoffice/tenancy';
import type { SkillCatalogue } from '@melonoffice/specialists';
import type { ToolExecutors, ToolRegistry } from '@melonoffice/tools';

/** The stores the worker reads and writes: the same repositories the API uses, nothing new. */
export interface WorkerStores {
  readonly tenancy: TenancyStore;
  readonly departments: DepartmentRepository;
  readonly specialists: SpecialistRepository;
  readonly executions: ExecutionRepository;
  readonly approvals: ApprovalRepository;
  readonly jobs: JobRepository;
  readonly audit: AuditStore;
}

export interface WorkerRuntimeOptions {
  readonly stores: WorkerStores;
  /** Where this worker runs. Undefined: every tool and model call is refused (fail closed). */
  readonly environment: DeploymentEnvironment | undefined;
  readonly leaseMs: number;
  /** The tool catalogue and executors. In production: the real catalogue, empty today (ADR-0026). */
  readonly tools: {
    readonly registry: ToolRegistry;
    readonly executors: ToolExecutors;
    /** The skills that grant tools to agents (ADR-0083). Absent: the catalogue in code. */
    readonly skills?: SkillCatalogue;
  };
  /** The model catalogue. In production: the official providers, none until D-7 (ADR-0027). */
  readonly ai: ProviderRegistry;
  /**
   * The Credits engine and rate. In production: absent until D-12, so every model call is
   * denied (`credits_not_configured`), exactly as the gateway already does.
   */
  readonly credits?: { readonly port: AICreditsPort; readonly rate: CreditRate };
  /**
   * The model policies specialists may name (ADR-0038, ADR-0043). Absent: only the default policy,
   * which stops at `internal` data.
   */
  readonly policies?: ModelPolicyCatalogue;
  /**
   * Which data each provider may receive here (ADR-0100), applied by the gateway before routing.
   * Absent: each provider's recorded terms only.
   */
  readonly dataPolicy?: AIDataPolicy;
  /**
   * Where every model call's usage and cost is recorded (the AI Usage Ledger, ADR-0074). Absent:
   * nothing is recorded; the calls and their credits are unchanged.
   */
  readonly usage?: AIUsageSink;
  readonly work?: NodeWorkSource;
  readonly verifier?: VerificationSource;
  readonly dispatcher?: JobDispatcher;
  /** Keeps agent answers for the nodes after them (ADR-0043). */
  readonly outputs?: AgentOutputSink;
  /** The Harness's tool loop (ADR-0103): what to do with tools a model asks for mid-task. */
  readonly toolLoop?: AgentToolLoop;
  /** Told when an execution stops without completing (ADR-0043). */
  readonly onStopped?: ExecutionStopHook;
  /**
   * Told when an execution ended, besides the plan conductor (ADR-0084: an agent task's proposed
   * facts go to Company Brain). A failure here is logged and changes nothing that ended.
   */
  readonly onEnded?: ExecutionEndHook;
  /**
   * The plans, for the plan conductor (WF-1, ADR-0070): when one of a plan's steps ends, its next
   * steps start, or the plan closes. Absent: a plan step ends and nothing follows.
   */
  readonly plans?: PlanRepository;
  /**
   * Decides the condition steps of those plans (WF-4, ADR-0075). Absent: a condition step fails
   * with `condition_not_configured` and its plan stops.
   */
  readonly conditions?: ConditionEvaluator;
  /**
   * Wakes those plans when one of their waits ends (ADR-0152). Absent: a wait step that became
   * ready is not started, and the steps after it wait.
   */
  readonly wakeups?: PlanWakeups;
  /**
   * The agents' kept answers and model calls, read to measure what a plan's runs used against the
   * budget a person approved (ADR-0163). Absent: a step of a plan with a known budget never starts.
   */
  readonly planOutputs?: Pick<AgentOutputStore, 'find'>;
  /**
   * Where a plan's end is told (ADR-0119): `plan.finished`, once, for the person who made it, so
   * their bell says the result is ready. Absent: a plan ends quietly, as before.
   */
  readonly events?: Pick<EventBus, 'publishRuntime'>;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

const PLAN_EVENT_CODE = /^[a-z][a-z_]{0,63}$/;

/**
 * Wires the existing services for the worker (ADR-0032). It builds nothing new: the job service
 * (X6b), the execution service (X1/X6a), the tool gate (X3), the AI Gateway (X4), approvals and
 * the runtime (X6c), over the same repositories. Composition only; no decision is made here.
 */
export function createWorkerRuntime(options: WorkerRuntimeOptions): {
  readonly jobs: JobService;
  readonly runtime: Runtime;
  /** Advances one plan as its person's runtime (ADR-0070); absent without plans. */
  readonly advancePlan?: (tenant: TenantContext, planId: PlanId) => Promise<unknown>;
} {
  const { stores, environment, leaseMs, tools, ai, credits, logger, now } = options;
  const authorization = createAuthorizationService();
  const audit = createAuditService(stores.audit, now);
  const specialists = createSpecialistService({
    repository: stores.specialists,
    departments: stores.departments,
    organizations: stores.tenancy,
    authorization,
  });
  const clock = now === undefined ? {} : { now };
  const log = logger === undefined ? {} : { logger };

  const jobsFor = (requestId?: string) =>
    createJobService({
      jobs: stores.jobs,
      executions: stores.executions,
      tenancy: stores.tenancy,
      authorization,
      audit,
      leaseMs,
      ...clock,
      ...log,
      ...(requestId === undefined ? {} : { requestId }),
    });

  const executionsFor = (correlationId: string) =>
    createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      assignments: specialists.assignments,
      authorization,
      audit,
      requestId: correlationId,
      ...clock,
    });

  const services = (correlationId: string): RuntimeServices => {
    const approvals = createApprovalService({
      repository: stores.approvals,
      organizations: stores.tenancy,
      authorization,
      audit,
      requestId: correlationId,
      ...clock,
    });
    return {
      executions: executionsFor(correlationId),
      gate: createToolGate({
        executions: stores.executions,
        organizations: stores.tenancy,
        specialists,
        departments: stores.departments,
        registry: tools.registry,
        ...(tools.skills === undefined ? {} : { skills: tools.skills }),
        approvals,
        executors: tools.executors,
        authorization,
        audit,
        environment,
        requestId: correlationId,
        ...clock,
        ...log,
      }),
      ai: createAIGateway({
        executions: stores.executions,
        organizations: stores.tenancy,
        specialists,
        authorization,
        registry: ai,
        policies: options.policies ?? createModelPolicyCatalogue([], DEFAULT_MODEL_POLICY),
        environment,
        ...(credits === undefined ? {} : { credits }),
        ...(options.usage === undefined ? {} : { usage: options.usage }),
        ...(options.dataPolicy === undefined ? {} : { dataPolicy: options.dataPolicy }),
        audit,
        ...clock,
        ...log,
      }),
      jobs: jobsFor(correlationId),
      approvals,
    };
  };

  const jobs = jobsFor();
  // The plan conductor (ADR-0070) starts a plan's next steps through this same runtime, as the
  // runtime of the person the plan runs for: their delegated start, then the step's first node.
  const plans = options.plans;
  /**
   * Advances one plan as the runtime of the person it runs for, and tells its end once. Called
   * when one of its steps ends, and by the sweep for a step that waits for a person (ADR-0146).
   */
  const advancePlan =
    plans === undefined
      ? undefined
      : async (
          tenant: TenantContext,
          organizationId: OrganizationId,
          planId: PlanId,
          requestId: string,
        ) => {
          const executions = executionsFor(requestId);
          const before =
            options.events === undefined ? undefined : await plans.find(organizationId, planId);
          const after = await createPlanConductor({
            plans,
            executions,
            starter: {
              async start(runtimeTenant, executionId) {
                await executions.runtimeStart(runtimeTenant, executionId);
                await runtime.kickoff(runtimeTenant, executionId);
              },
            },
            ...(options.conditions === undefined ? {} : { conditions: options.conditions }),
            ...(options.wakeups === undefined ? {} : { wakeups: options.wakeups }),
            // What its runs used, against the budget a person approved (ADR-0163).
            ...(options.planOutputs === undefined
              ? {}
              : {
                  spending: createPlanSpending({ executions, outputs: options.planOutputs }),
                }),
            // A step that failed for a passing reason runs again, as its plan allows (ADR-0153).
            attempts: createPlanStepAttempts({ executions, specialists }),
            // A step marked "ask me before this step" waits for a person (ADR-0146).
            approvals: createPlanStepApprovals(
              createApprovalService({
                repository: stores.approvals,
                organizations: stores.tenancy,
                authorization,
                audit,
                requestId,
                ...clock,
              }),
              now,
              tools.registry,
            ),
            requestId,
            ...clock,
            ...(logger === undefined ? {} : { logger: logger.child({ component: 'plans' }) }),
          }).advance(tenant, planId);
          // Told once, by the step end that closed the plan (the event's key repeats it at most).
          if (
            options.events === undefined ||
            before?.status !== 'executing' ||
            (after.status !== 'completed' && after.status !== 'failed')
          ) {
            return;
          }
          const code = after.delegationFailure;
          try {
            await options.events.publishRuntime(after.organizationId, after.createdBy, [
              {
                type: 'plan.finished',
                subject: { type: 'plan', id: after.id },
                data: {
                  outcome: after.status,
                  ...(code !== undefined && PLAN_EVENT_CODE.test(code) ? { code } : {}),
                },
                idempotencyKey: `${after.id}:finished`,
              },
            ]);
          } catch (error) {
            // The plan ended either way: a notice is never worth failing it for.
            logger?.warn('plan.finished not published', {
              planId: after.id,
              code: (error as { code?: unknown }).code ?? 'error',
            });
          }
        };
  const conductor: ExecutionEndHook | undefined =
    advancePlan === undefined
      ? undefined
      : {
          async ended(tenant, execution) {
            const step = planStepOf(execution);
            if (step === undefined) return;
            await advancePlan(tenant, execution.organizationId, step.planId, execution.id);
          },
        };
  const extra = options.onEnded;
  const onEnded: ExecutionEndHook | undefined =
    extra === undefined
      ? conductor
      : {
          async ended(tenant, execution, status) {
            try {
              await extra.ended(tenant, execution, status);
            } catch (error) {
              logger?.warn('execution end hook failed', {
                executionId: execution.id,
                code: (error as { code?: unknown }).code ?? 'error',
              });
            }
            await conductor?.ended(tenant, execution, status);
          },
        };
  const runtime: Runtime = createRuntime({
    jobs,
    services,
    ...(options.work === undefined ? {} : { work: options.work }),
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
    ...(options.outputs === undefined ? {} : { outputs: options.outputs }),
    ...(options.toolLoop === undefined ? {} : { toolLoop: options.toolLoop }),
    ...(options.onStopped === undefined ? {} : { onStopped: options.onStopped }),
    ...(onEnded === undefined ? {} : { onEnded }),
    ...log,
  });
  return Object.freeze({
    jobs,
    runtime,
    ...(advancePlan === undefined
      ? {}
      : {
          advancePlan: (tenant: TenantContext, planId: PlanId) =>
            advancePlan(tenant, tenant.organizationId, planId, `plan:${planId}`),
        }),
  });
}
