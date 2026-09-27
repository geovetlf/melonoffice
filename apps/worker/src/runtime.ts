import {
  createAIGateway,
  createModelPolicyCatalogue,
  DEFAULT_MODEL_POLICY,
  type AICreditsPort,
  type CreditRate,
  type ProviderRegistry,
} from '@melonoffice/ai-gateway';
import { createApprovalService, type ApprovalRepository } from '@melonoffice/approvals';
import { createAuditService, type AuditStore } from '@melonoffice/audit';
import type { DepartmentRepository } from '@melonoffice/departments';
import type { DeploymentEnvironment } from '@melonoffice/domain';
import { createExecutionService, type ExecutionRepository } from '@melonoffice/execution';
import { createToolGate } from '@melonoffice/guardrails';
import { createJobService, type JobRepository, type JobService } from '@melonoffice/jobs';
import type { Logger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createRuntime,
  type JobDispatcher,
  type NodeWorkSource,
  type Runtime,
  type RuntimeServices,
  type VerificationSource,
} from '@melonoffice/runtime';
import { createSpecialistService, type SpecialistRepository } from '@melonoffice/specialists';
import type { TenancyStore } from '@melonoffice/tenancy';
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
  readonly tools: { readonly registry: ToolRegistry; readonly executors: ToolExecutors };
  /** The model catalogue. In production: the official providers, none until D-7 (ADR-0027). */
  readonly ai: ProviderRegistry;
  /**
   * The Credits engine and rate. In production: absent until D-12, so every model call is
   * denied (`credits_not_configured`), exactly as the gateway already does.
   */
  readonly credits?: { readonly port: AICreditsPort; readonly rate: CreditRate };
  readonly work?: NodeWorkSource;
  readonly verifier?: VerificationSource;
  readonly dispatcher?: JobDispatcher;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

/**
 * Wires the existing services for the worker (ADR-0032). It builds nothing new: the job service
 * (X6b), the execution service (X1/X6a), the tool gate (X3), the AI Gateway (X4), approvals and
 * the runtime (X6c), over the same repositories. Composition only; no decision is made here.
 */
export function createWorkerRuntime(options: WorkerRuntimeOptions): {
  readonly jobs: JobService;
  readonly runtime: Runtime;
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
      executions: createExecutionService({
        repository: stores.executions,
        organizations: stores.tenancy,
        assignments: specialists.assignments,
        authorization,
        audit,
        requestId: correlationId,
        ...clock,
      }),
      gate: createToolGate({
        executions: stores.executions,
        organizations: stores.tenancy,
        specialists,
        departments: stores.departments,
        registry: tools.registry,
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
        policies: createModelPolicyCatalogue([], DEFAULT_MODEL_POLICY),
        environment,
        ...(credits === undefined ? {} : { credits }),
        audit,
        ...clock,
        ...log,
      }),
      jobs: jobsFor(correlationId),
      approvals,
    };
  };

  const jobs = jobsFor();
  const runtime = createRuntime({
    jobs,
    services,
    ...(options.work === undefined ? {} : { work: options.work }),
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    ...(options.dispatcher === undefined ? {} : { dispatcher: options.dispatcher }),
    ...log,
  });
  return Object.freeze({ jobs, runtime });
}
