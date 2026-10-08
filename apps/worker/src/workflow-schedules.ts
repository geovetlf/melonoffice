import { createAuditService } from '@melonoffice/audit';
import type { DeploymentEnvironment } from '@melonoffice/domain';
import { createExecutionService } from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import {
  createPlanService,
  createPlanValidator,
  type PlanConductor,
  type PlanRepository,
} from '@melonoffice/planning';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createSpecialistService } from '@melonoffice/specialists';
import type { ToolRegistry } from '@melonoffice/tools';
import {
  createScheduleRunner,
  RUN_SCHEDULE_PATH,
  createWorkflowService,
  type ScheduleRunner,
  type WorkflowRepository,
  type WorkflowScheduleRepository,
} from '@melonoffice/workflows';
import type { WorkerStores } from './runtime.js';

export { RUN_SCHEDULE_PATH, type ScheduleRunner };

export interface WorkflowScheduleRunnerOptions {
  readonly stores: WorkerStores;
  readonly plans: PlanRepository;
  readonly workflows: WorkflowRepository;
  readonly schedules: WorkflowScheduleRepository;
  /** The tool catalogue the plan's validator checks tool steps against, as the API's. */
  readonly tools: ToolRegistry;
  /** Where this worker runs. Undefined: every tool step is refused, as in the API. */
  readonly environment: DeploymentEnvironment | undefined;
  /** The worker runtime's conductor: starts a plan its person's schedule approved. */
  readonly conductor: Pick<PlanConductor, 'run'>;
  readonly scheduler?: { schedule(body: object, at: Date): Promise<void> };
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/**
 * Runs workflow schedules in the worker (ADR-0185). Composition only: the same workflow, plan,
 * execution and validator services the API builds, over the same repositories, acting as the
 * runtime of the person who switched each schedule on. The only file of the worker that plans:
 * a schedule's confirmed workflow version, through the validator, never a planner or a model.
 */
export function createWorkflowScheduleRunner({
  stores,
  plans,
  workflows,
  schedules,
  tools,
  environment,
  conductor,
  scheduler,
  now,
  logger,
}: WorkflowScheduleRunnerOptions): ScheduleRunner {
  const authorization = createAuthorizationService();
  const audit = createAuditService(stores.audit, now);
  const clock = now === undefined ? {} : { now };
  const specialists = createSpecialistService({
    repository: stores.specialists,
    departments: stores.departments,
    organizations: stores.tenancy,
    authorization,
  });
  const executions = createExecutionService({
    repository: stores.executions,
    organizations: stores.tenancy,
    assignments: specialists.assignments,
    authorization,
    audit,
    requestId: 'workflow-schedule',
    ...clock,
  });
  const planService = createPlanService({
    repository: plans,
    executions,
    validator: createPlanValidator({
      specialists,
      departments: stores.departments,
      tools,
      authorization,
      environment,
    }),
    organizations: stores.tenancy,
    authorization,
    audit,
    requestId: 'workflow-schedule',
    ...clock,
  });
  return createScheduleRunner({
    schedules,
    workflows,
    workflowService: createWorkflowService({
      repository: workflows,
      plans: planService,
      executions,
      specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
      requestId: 'workflow-schedule',
      ...clock,
    }),
    plans: planService,
    conductor,
    tenancy: stores.tenancy,
    ...(scheduler === undefined ? {} : { scheduler }),
    ...clock,
    ...(logger === undefined ? {} : { logger }),
  });
}
