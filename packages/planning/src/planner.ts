import { promptLabel, promptRef, type AIGateway, type AIRequest } from '@melonoffice/ai-gateway';
import type { DepartmentRepository } from '@melonoffice/departments';
import type { DataSensitivity, DefinitionRef, ToolId } from '@melonoffice/domain';
import type { ExecutionService } from '@melonoffice/execution';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { SpecialistService } from '@melonoffice/specialists';
import type { TenantContext } from '@melonoffice/tenancy';
import { PlanningError } from './errors.js';
import type { ToolRegistry } from '@melonoffice/tools';
import {
  plannerMessages,
  plannerToolOf,
  planningAnswerOf,
  type PlannerAgentView,
  type PlannerToolView,
} from './planner-context.js';
import { MAX_OBJECTIVE_LENGTH } from './proposal.js';
import { isPlanningExecution, type PlanService, type ProposeOutcome } from './service.js';

/** What the planner is asked: plan this objective in this planning execution. */
export interface PlannerRequest {
  readonly executionId: string;
  /** The caller's id for the AI call; the same id is the same call. */
  readonly requestId: string;
  /** What the user wants done, in their words. Sent to the model; never stored in the plan. */
  readonly objective: string;
  /** How sensitive the objective is. `internal` when not said. */
  readonly sensitivity?: DataSensitivity;
}

/**
 * What planning gave. `failed` means the AI Gateway denied or failed the call (in DEV today,
 * always: no provider exists until D-7 and no credit rate until D-12); `refused` means the model
 * answered and the pipeline refused its proposal. Either way the planning execution fails and
 * nothing is stored.
 */
export type PlannerOutcome =
  ProposeOutcome | { readonly status: 'failed'; readonly reason: string };

/** One specialist the model may choose, by id and codes only: never a secret, never authority. */
export interface PlanningCandidate {
  readonly specialistId: string;
  /** The department's catalogue type, or `custom`. Never an id that names the organization. */
  readonly departmentType: string;
  readonly roleId: string;
  readonly capabilities: readonly string[];
  readonly tools: readonly DefinitionRef<ToolId>[];
}

/** A candidate as the planner sees it, with each of its tools described by `describe`. */
export const plannerAgentOf = (
  candidate: PlanningCandidate,
  describe: (ref: DefinitionRef<ToolId>) => PlannerToolView,
  skills?: readonly string[],
): PlannerAgentView =>
  Object.freeze({
    specialistId: candidate.specialistId,
    departmentType: candidate.departmentType,
    roleId: candidate.roleId,
    ...(skills === undefined || skills.length === 0 ? {} : { skills }),
    tools: candidate.tools.map(describe),
  });

export interface Planner {
  plan(tenant: TenantContext, request: PlannerRequest): Promise<PlannerOutcome>;
}

export interface PlannerOptions {
  /** Proposes the plan, and says which tools its validator takes as steps (`toolUse`). */
  readonly plans: Pick<PlanService, 'propose' | 'toolUse'>;
  /** What each tool is: its action, risk and schemas, for the planner's context. */
  readonly tools: Pick<ToolRegistry, 'resolve'>;
  readonly executions: Pick<ExecutionService, 'get' | 'changeStatus'>;
  readonly specialists: Pick<SpecialistService, 'list' | 'eligibility'>;
  readonly departments: Pick<DepartmentRepository, 'find'>;
  /** The only way the planner reaches a model. */
  readonly gateway: AIGateway;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly logger?: Logger;
  /** The most output the planning call may ask for. */
  readonly maxOutputTokens?: number;
}

/** The most output the planning call asks for, unless its options say otherwise. */
export const PLANNER_MAX_OUTPUT_TOKENS = 8_000;

/** What the planning call asks of a model: text, as JSON (`requirements.structuredOutput`). */
export const PLANNER_CAPABILITY = 'text_generation';

const CODE = /^[a-z][a-z_]{0,63}$/;
const failureCode = (code: string): string => (CODE.test(code) ? code : 'planning_failed');

/**
 * The planner (ADR-0028): one path, `objective → AI Gateway → proposal → pipeline → plan`. It
 * never calls a provider, never approves, never delegates and never runs anything. The model's
 * answer is only a proposal: `PlanService.propose` validates it and stores the plan.
 */
/** The planner's prompt version (G-3, ADR-0133): a new one whenever its text changes. */
export const PLANNER_PROMPT = promptRef('plan_proposal', 2);

export function createPlanner({
  plans,
  tools,
  executions,
  specialists,
  departments,
  gateway,
  authorization,
  logger,
  maxOutputTokens = PLANNER_MAX_OUTPUT_TOKENS,
}: PlannerOptions): Planner {
  /**
   * The organization's specialists that may take work now, from X2 eligibility, each with the
   * tools its skills grant as the plan validator judges them (ADR-0171).
   */
  async function candidatesOf(tenant: TenantContext): Promise<readonly PlannerAgentView[]> {
    const all = await specialists.list(tenant);
    const found: PlannerAgentView[] = [];
    for (const s of [...all].sort((a, b) => (a.identity.id < b.identity.id ? -1 : 1))) {
      const decision = await specialists.eligibility(tenant, {
        specialistId: s.identity.id,
        departmentId: s.configuration.departmentId,
        version: s.version,
      });
      if (!decision.eligible) continue;
      const department = await departments.find(s.organizationId, s.configuration.departmentId);
      const departmentType =
        department?.origin.kind === 'catalog' ? department.origin.typeId : 'custom';
      found.push(
        plannerAgentOf(
          {
            specialistId: s.identity.id,
            departmentType,
            roleId: s.configuration.mainRoleId,
            capabilities: s.configuration.capabilities,
            tools: s.configuration.tools,
          },
          (ref) =>
            plannerToolOf(
              ref,
              tools.resolve(ref.id, ref.version),
              plans.toolUse(
                ref,
                department?.origin.kind === 'catalog' ? departmentType : undefined,
              ),
            ),
          s.configuration.skills.map((k) => `${k.id}@${k.version}`),
        ),
      );
    }
    return found;
  }

  return Object.freeze({
    async plan(tenant: TenantContext, request: PlannerRequest): Promise<PlannerOutcome> {
      if (!authorization.authorize(tenant, 'plan.create').allowed) {
        throw new PlanningError('permission_denied');
      }
      const execution = await executions.get(tenant, request.executionId);
      const log = withCorrelation(logger ?? silent, {
        requestId: request.requestId,
        organizationId: execution.organizationId,
        executionId: execution.id,
      });
      if (
        !isPlanningExecution(execution) ||
        execution.workflowId !== undefined ||
        typeof request.objective !== 'string' ||
        [...request.objective].length > MAX_OBJECTIVE_LENGTH
      ) {
        throw new PlanningError('execution_not_plannable');
      }
      const fail = async (reason: string): Promise<PlannerOutcome> => {
        const code = failureCode(reason);
        await executions.changeStatus(tenant, execution.id, {
          from: execution.status,
          to: 'failed',
          failure: { code },
        });
        log.info('planning failed', { code });
        return Object.freeze({ status: 'failed', reason: code });
      };

      const candidates = await candidatesOf(tenant);
      const aiRequest: AIRequest = {
        requestId: request.requestId,
        executionId: execution.id,
        specialistId: execution.specialistId as string,
        taskType: 'plan_proposal',
        metadata: { prompt: promptLabel(PLANNER_PROMPT) },
        // A JSON answer is text generation that requires structured output, as every other
        // call asks it: the providers' adapters take no `structured_output` call (ADR-0169).
        capability: PLANNER_CAPABILITY,
        requirements: { structuredOutput: true },
        messages: plannerMessages({ agents: candidates }, request.objective),
        outputModality: 'text',
        maxOutputTokens,
        sensitivity: request.sensitivity ?? 'internal',
      };
      const response = await gateway.generate(tenant, aiRequest);
      if (response.status !== 'completed') return fail(response.code);

      // A question or a "cannot be done" is not a plan: the task goes back to a person (ADR-0171).
      const answer = planningAnswerOf(response.output);
      if (answer.kind === 'question') return fail('needs_clarification');
      if (answer.kind === 'not_possible') return fail('not_possible');
      const outcome = await plans.propose(tenant, {
        executionId: execution.id,
        proposal: answer.kind === 'proposal' ? answer.proposal : response.output.structured,
        source: {
          kind: 'planner',
          model: {
            provider: response.provider,
            id: response.model,
            version: response.versions.model,
          },
          policy: response.versions.policy,
        },
      });
      if (outcome.status === 'refused') {
        await fail(outcome.reason);
        return outcome;
      }
      log.info('plan created', { planId: outcome.plan.id, status: outcome.plan.status });
      return outcome;
    },
  });
}

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};
