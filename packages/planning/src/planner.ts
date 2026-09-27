import type { AIGateway, AIRequest } from '@melonoffice/ai-gateway';
import type { DepartmentRepository } from '@melonoffice/departments';
import type { DataSensitivity, DefinitionRef, ToolId } from '@melonoffice/domain';
import type { ExecutionService } from '@melonoffice/execution';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { SpecialistService } from '@melonoffice/specialists';
import type { TenantContext } from '@melonoffice/tenancy';
import { PlanningError } from './errors.js';
import { MAX_OBJECTIVE_LENGTH, MAX_STEPS } from './proposal.js';
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

export interface Planner {
  plan(tenant: TenantContext, request: PlannerRequest): Promise<PlannerOutcome>;
}

export interface PlannerOptions {
  readonly plans: Pick<PlanService, 'propose'>;
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

/**
 * The fixed instructions. They describe the proposal format; they grant nothing. Whatever the
 * model answers goes through the whole validation pipeline, which alone decides.
 */
export const PLANNER_INSTRUCTIONS = [
  'You are the MelonOffice planner. Propose a plan as one JSON object with exactly the fields',
  'summary, objective, optional riskLevel (low|medium|high|critical) and steps.',
  `Use at most ${MAX_STEPS} steps. Each step has id (lowercase letters, digits, underscore),`,
  'kind (specialist|tool|approval|verification|condition|parallel), label and dependsOn.',
  'A specialist step names a specialistId from the candidates and a verification',
  '{policy, expectedOutput, requiredChecks}. A tool step names performedBy (a specialist step)',
  'and one tool {id, version} that specialist lists. Never include organizations, users,',
  'permissions, approvals, credits, policies or credentials: they are refused.',
].join(' ');

const CODE = /^[a-z][a-z_]{0,63}$/;
const failureCode = (code: string): string => (CODE.test(code) ? code : 'planning_failed');

/**
 * The planner (ADR-0028): one path, `objective → AI Gateway → proposal → pipeline → plan`. It
 * never calls a provider, never approves, never delegates and never runs anything. The model's
 * answer is only a proposal: `PlanService.propose` validates it and stores the plan.
 */
export function createPlanner({
  plans,
  executions,
  specialists,
  departments,
  gateway,
  authorization,
  logger,
  maxOutputTokens = 8_000,
}: PlannerOptions): Planner {
  /** The organization's specialists that may take work now, from X2 eligibility. */
  async function candidatesOf(tenant: TenantContext): Promise<readonly PlanningCandidate[]> {
    const all = await specialists.list(tenant);
    const found: PlanningCandidate[] = [];
    for (const s of [...all].sort((a, b) => (a.identity.id < b.identity.id ? -1 : 1))) {
      const decision = await specialists.eligibility(tenant, {
        specialistId: s.identity.id,
        departmentId: s.configuration.departmentId,
        version: s.version,
      });
      if (!decision.eligible) continue;
      const department = await departments.find(s.organizationId, s.configuration.departmentId);
      found.push({
        specialistId: s.identity.id,
        departmentType: department?.origin.kind === 'catalog' ? department.origin.typeId : 'custom',
        roleId: s.configuration.mainRoleId,
        capabilities: s.configuration.capabilities,
        tools: s.configuration.tools,
      });
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
        capability: 'structured_output',
        requirements: { structuredOutput: true },
        messages: [
          {
            role: 'system',
            content: [
              { type: 'text', text: PLANNER_INSTRUCTIONS },
              { type: 'text', text: JSON.stringify({ candidates }) },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: request.objective }] },
        ],
        outputModality: 'text',
        maxOutputTokens,
        sensitivity: request.sensitivity ?? 'internal',
      };
      const response = await gateway.generate(tenant, aiRequest);
      if (response.status !== 'completed') return fail(response.code);

      const outcome = await plans.propose(tenant, {
        executionId: execution.id,
        proposal: response.output.structured,
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
