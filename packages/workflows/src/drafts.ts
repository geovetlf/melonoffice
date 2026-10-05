import { promptLabel, type AIGateway } from '@melonoffice/ai-gateway';
import type { Specialist } from '@melonoffice/domain';
import {
  PLANNER_CAPABILITY,
  PLANNER_MAX_OUTPUT_TOKENS,
  PLANNER_PROMPT,
  plannerAgentOf,
  plannerMessages,
  plannerToolOf,
  planningAnswerOf,
  MAX_OBJECTIVE_LENGTH,
  type PlannerAgentView,
} from '@melonoffice/planning';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { TenantContext } from '@melonoffice/tenancy';
import type { ToolRegistry } from '@melonoffice/tools';
import { WorkflowError } from './errors.js';
import { MAX_NAME_LENGTH } from './model.js';
import type { WorkflowAssignee, WorkflowService } from './service.js';

/**
 * Workflow drafts from a person's words (Block 3 F2, ADR-0171). GIA proposes; the person reviews
 * and saves. A draft is the planner's own answer (`plan_proposal@2`, the same instructions,
 * context and reading as the Harness's plans), asked of the model in GIA's name, over the roles
 * `assignees()` gives: so every agent and tool it may name is one a workflow could use now. Its
 * steps then go through `check`, the dry run a save and a plan would make. Nothing is stored,
 * no workflow is created, nothing runs.
 */
export interface WorkflowDrafter {
  draft(tenant: TenantContext, request: WorkflowDraftRequest): Promise<WorkflowDraft>;
}

export interface WorkflowDraftRequest {
  /** The person's words. Sent to the model; never stored. */
  readonly intent: string;
  /** The caller's id for the AI call. */
  readonly requestId: string;
}

/** A draft step as the workflow routes take it: a role, never an agent. */
export type WorkflowDraftStep = Readonly<Record<string, unknown>>;

/** What a draft says about each of its steps, built from the validated plan, never the model. */
export interface WorkflowDraftStepSummary {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly dependsOn: readonly string[];
  readonly approvalRequired: boolean;
  /** Who does an agent step, or performs a tool step. */
  readonly agent?: {
    readonly id: string;
    readonly displayName: string;
    readonly departmentTypeId: string;
    readonly roleId: string;
  };
  readonly tool?: {
    readonly id: string;
    readonly version: number;
    readonly nameKey: string;
    readonly changesData: boolean;
    readonly riskLevel: string;
  };
  readonly waitSeconds?: number;
}

/** The summary a person reviews (ADR-0171): what it does, who, with what, what asks first. */
export interface WorkflowDraftSummary {
  readonly steps: readonly WorkflowDraftStepSummary[];
  /** The plan's overall risk and whether it waits for a person, as the validator decided. */
  readonly riskLevel: string;
  readonly approvalRequired: boolean;
  /** Whether some step changes data. */
  readonly changesData: boolean;
  /** How it runs today: a person starts it. There are no schedules yet (B5). */
  readonly schedule: 'manual';
  /** The steps nothing waits for: what it ends with. */
  readonly results: readonly string[];
}

export type WorkflowDraft =
  | {
      readonly status: 'ready';
      readonly name: string;
      readonly steps: readonly WorkflowDraftStep[];
      readonly summary: WorkflowDraftSummary;
    }
  | {
      /** Steps were proposed, and planning would refuse them: they are never shown as valid. */
      readonly status: 'invalid';
      readonly name: string;
      readonly steps: readonly WorkflowDraftStep[];
      readonly problem: {
        readonly stage: string;
        readonly reason: string;
        readonly detail?: string;
      };
    }
  | { readonly status: 'needs_clarification'; readonly question: string }
  | { readonly status: 'not_possible'; readonly reason: string }
  /** No agent can take a workflow step now: nothing was asked of a model. */
  | { readonly status: 'no_agents' }
  /** The AI Gateway denied or failed the call, or the answer could not be read. */
  | { readonly status: 'failed'; readonly code: string };

export interface WorkflowDrafterOptions {
  readonly workflows: Pick<WorkflowService, 'assignees' | 'check'>;
  /** The only way a draft reaches a model: an assisted call in GIA's name. */
  readonly gateway: Pick<AIGateway, 'assist'>;
  readonly tools: Pick<ToolRegistry, 'resolve'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** The draft's name: the plan's summary, or the person's words, cut to a workflow name. */
function nameOf(summary: unknown, intent: string): string {
  const from = typeof summary === 'string' && summary.trim() !== '' ? summary : intent;
  const clean = from.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, MAX_NAME_LENGTH).join('');
}

/**
 * The plan's steps as a workflow's (ADR-0159): an agent step names the role of the agent the
 * model chose, never the agent. A step naming no agent of the context is left as it is, and the
 * dry run refuses it.
 */
function workflowStepsOf(
  steps: readonly unknown[],
  roles: ReadonlyMap<string, WorkflowAssignee>,
): readonly WorkflowDraftStep[] {
  return steps.map((step) => {
    if (!isRecord(step) || step.kind !== 'specialist') return step as WorkflowDraftStep;
    const role = roles.get(String(step.specialistId));
    if (role === undefined) return step;
    const rest = Object.fromEntries(
      Object.entries(step).filter(([key]) => key !== 'specialistId' && key !== 'departmentId'),
    );
    return {
      ...rest,
      assignee: { departmentTypeId: role.departmentTypeId, roleId: role.roleId },
    };
  });
}

function summaryOf(
  checked: Extract<Awaited<ReturnType<WorkflowService['check']>>, { ok: true }>,
  labels: ReadonlyMap<string, string>,
  roles: ReadonlyMap<string, WorkflowAssignee>,
  tools: Pick<ToolRegistry, 'resolve'>,
): WorkflowDraftSummary {
  const { plan, agents } = checked;
  const agentOf = (specialist: Specialist | undefined) => {
    if (specialist === undefined) return undefined;
    const role = roles.get(specialist.identity.id);
    return {
      id: specialist.identity.id,
      displayName: specialist.identity.displayName,
      departmentTypeId: role?.departmentTypeId ?? '',
      roleId: role?.roleId ?? specialist.configuration.mainRoleId,
    };
  };
  const waitedOn = new Set(plan.steps.flatMap((s) => s.dependsOn));
  const steps = plan.steps.map((s): WorkflowDraftStepSummary => {
    const agent = agentOf(agents[s.kind === 'tool' ? (s.performedBy ?? '') : s.id]);
    const resolved = s.tool === undefined ? undefined : tools.resolve(s.tool.id, s.tool.version);
    return Object.freeze({
      id: s.id,
      kind: s.kind,
      label: labels.get(s.id) ?? s.label,
      dependsOn: s.dependsOn,
      approvalRequired: s.approvalRequired,
      ...(agent === undefined ? {} : { agent }),
      ...(s.tool === undefined
        ? {}
        : {
            tool: {
              id: s.tool.id,
              version: s.tool.version,
              nameKey: resolved?.version.nameKey ?? `tools.${s.tool.id}.name`,
              changesData: resolved?.version.mutating ?? true,
              riskLevel: resolved?.version.riskLevel ?? plan.riskLevel,
            },
          }),
      ...(s.wait === undefined ? {} : { waitSeconds: s.wait.seconds }),
    });
  });
  return Object.freeze({
    steps,
    riskLevel: plan.riskLevel,
    approvalRequired: plan.approvalRequired,
    changesData: steps.some((s) => s.tool?.changesData === true),
    schedule: 'manual',
    results: plan.steps.filter((s) => !waitedOn.has(s.id)).map((s) => s.id),
  });
}

export function createWorkflowDrafter({
  workflows,
  gateway,
  tools,
  authorization,
}: WorkflowDrafterOptions): WorkflowDrafter {
  return Object.freeze({
    async draft(tenant: TenantContext, request: WorkflowDraftRequest): Promise<WorkflowDraft> {
      // A person drafts, never GIA or the runtime; and only someone who may save and plan it.
      if (tenant.actor !== 'user') throw new WorkflowError('permission_denied');
      for (const permission of ['workflow.manage', 'plan.create', 'gia.ask']) {
        if (!authorization.authorize(tenant, permission).allowed) {
          throw new WorkflowError('permission_denied');
        }
      }
      const intent = typeof request.intent === 'string' ? request.intent.trim() : '';
      if (intent === '' || [...intent].length > MAX_OBJECTIVE_LENGTH) {
        throw new WorkflowError('invalid_workflow', 'intent');
      }

      // The roles a workflow step can name now, each with the agent a plan would bind and its
      // tools as the plan validator judges them: the one source the editor reads too.
      const assignees = await workflows.assignees(tenant);
      if (assignees.length === 0) return Object.freeze({ status: 'no_agents' });
      const roles = new Map(assignees.map((a) => [a.specialist.identity.id, a]));
      const agents: PlannerAgentView[] = assignees.map((a) => {
        const uses = new Map(a.tools.map((t) => [`${t.id}@${t.version}`, t.use]));
        return plannerAgentOf(
          {
            specialistId: a.specialist.identity.id,
            departmentType: a.departmentTypeId,
            roleId: a.roleId,
            capabilities: a.specialist.configuration.capabilities,
            tools: a.specialist.configuration.tools,
          },
          (ref) =>
            plannerToolOf(
              ref,
              tools.resolve(ref.id, ref.version),
              uses.get(`${ref.id}@${ref.version}`) ?? { usable: false, reason: 'tool_not_found' },
            ),
          a.specialist.configuration.skills.map((k) => `${k.id}@${k.version}`),
        );
      });

      const response = await gateway.assist(tenant, {
        requestId: request.requestId,
        subject: { type: 'gia', id: tenant.organizationId as string },
        taskType: 'workflow_draft',
        capability: PLANNER_CAPABILITY,
        requirements: { structuredOutput: true },
        messages: plannerMessages({ agents }, intent),
        outputModality: 'text',
        maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
        // The person's words about their own business, as GIA treats them.
        sensitivity: 'confidential',
        metadata: { prompt: promptLabel(PLANNER_PROMPT) },
      });
      if (response.status !== 'completed') {
        return Object.freeze({ status: 'failed', code: response.code });
      }

      const answer = planningAnswerOf(response.output);
      if (answer.kind === 'question') {
        return Object.freeze({ status: 'needs_clarification', question: answer.text });
      }
      if (answer.kind === 'not_possible') {
        return Object.freeze({ status: 'not_possible', reason: answer.text });
      }
      if (answer.kind === 'unreadable') {
        return Object.freeze({ status: 'failed', code: 'invalid_proposal' });
      }
      const proposed = answer.proposal.steps as readonly unknown[];
      const name = nameOf(answer.proposal.summary, intent);
      const steps = workflowStepsOf(proposed, roles);
      const checked = await workflows.check(tenant, { name, steps });
      if (!checked.ok) {
        return Object.freeze({
          status: 'invalid',
          name,
          steps,
          problem: {
            stage: checked.stage,
            reason: checked.reason,
            ...(checked.detail === undefined ? {} : { detail: checked.detail }),
          },
        });
      }
      const labels = new Map(
        steps.flatMap((s) =>
          typeof s.id === 'string' && typeof s.label === 'string' ? [[s.id, s.label] as const] : [],
        ),
      );
      return Object.freeze({
        status: 'ready',
        name,
        steps,
        summary: summaryOf(checked, labels, roles, tools),
      });
    },
  });
}
