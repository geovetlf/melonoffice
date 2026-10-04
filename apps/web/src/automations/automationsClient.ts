import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Workflows and plans (ADR-0028, ADR-0070, ADR-0071), as the API serves them. The web never runs
 * anything: a person plans a workflow, reads the plan it gave, and approves or rejects that exact
 * version. Approving is what starts it, on the server.
 */

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface WorkflowView {
  readonly id: string;
  readonly name: string;
  readonly status: WorkflowStatus;
  readonly version: number;
  readonly updatedAt: string;
}

/** A workflow step as the API gives it back (ADR-0028). */
export interface WorkflowStepView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly dependsOn: readonly string[];
  readonly assignee: { readonly departmentTypeId: string; readonly roleId: string } | null;
  /** A check's decision (WF-4, ADR-0075); none on other steps. */
  readonly decision?: WorkflowDecisionView | null;
  readonly approvalRequired: boolean;
}

/** What a check step asks the Decision Engine, and the outcomes that let the steps after it run. */
export interface WorkflowDecisionView {
  readonly decision: string;
  readonly continueOn: readonly string[];
  readonly input: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkflowDetail extends WorkflowView {
  readonly current: {
    readonly version: number;
    readonly name: string;
    readonly steps: readonly WorkflowStepView[];
  };
}

/**
 * One step a person writes. `key` names it while editing (it survives moving it), and `after` is
 * the keys of the earlier steps it waits for; the first step waits for none.
 * - `agent`: an agent with this role does it, optionally after the person approves it.
 * - `check`: a company policy check (`action.policy_check`, WF-4): the steps after it run only
 *   when the policy allows the action; otherwise they are skipped and the rest goes on.
 */
export type WorkflowStepDraft = WorkflowAgentDraft | WorkflowCheckDraft;

interface WorkflowDraftBase {
  readonly key: string;
  readonly label: string;
  readonly after: readonly string[];
}

export interface WorkflowAgentDraft extends WorkflowDraftBase {
  readonly kind: 'agent';
  readonly departmentTypeId: string;
  readonly roleId: string;
  readonly approvalRequired: boolean;
}

export interface WorkflowCheckDraft extends WorkflowDraftBase {
  readonly kind: 'check';
  /** The action whose policy is checked, from the Decision Engine's catalogue. */
  readonly action: string;
  /** A discount to check against the company's discount policy, as a percentage. */
  readonly discountPercent: number | null;
}

/** The only decision type the worker decides a check with (ADR-0075); any other stops the plan. */
export const CHECK_DECISION = 'action.policy_check';
/** A check lets the steps after it run only when the policy allows the action outright. */
export const CHECK_CONTINUE_ON: readonly string[] = ['allowed'];

export const WORKFLOW_TRANSITIONS: Readonly<Record<WorkflowStatus, readonly WorkflowStatus[]>> = {
  draft: ['active', 'archived'],
  active: ['paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
};

/**
 * The steps as the API takes them. Each waits for the earlier steps the person chose. An agent
 * step is checked the way agent steps are checked (the agent's answer is kept and well formed); a
 * check is decided by the Decision Engine with the fixed input written here. The server checks
 * everything again.
 */
export function workflowStepsOf(drafts: readonly WorkflowStepDraft[]): readonly unknown[] {
  const ids = new Map(drafts.map((d, i) => [d.key, `step_${i + 1}`]));
  return drafts.map((d, i) => {
    const base = {
      id: `step_${i + 1}`,
      label: d.label.trim(),
      dependsOn: d.after.flatMap((k) => {
        const id = ids.get(k);
        return id === undefined ? [] : [id];
      }),
    };
    if (d.kind === 'check') {
      return {
        ...base,
        kind: 'condition',
        decision: {
          decision: CHECK_DECISION,
          continueOn: [...CHECK_CONTINUE_ON],
          input: {
            action: d.action,
            ...(d.discountPercent === null ? {} : { discountPercent: d.discountPercent }),
          },
        },
      };
    }
    return {
      ...base,
      kind: 'specialist',
      assignee: { departmentTypeId: d.departmentTypeId, roleId: d.roleId },
      verification: { policy: 'output_schema', expectedOutput: 'agent_answer', requiredChecks: [] },
      ...(d.approvalRequired ? { approvalRequired: true } : {}),
    };
  });
}

export type PlanStatus =
  | 'draft'
  | 'ready'
  | 'approval_required'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PlanView {
  readonly id: string;
  readonly status: PlanStatus;
  readonly version: number;
  readonly createdAt: string;
}

export interface PlanStepView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly dependsOn: readonly string[];
  /** A check's decision (WF-4); none on other steps. */
  readonly decision?: WorkflowDecisionView | null;
}

/** Where a step is, by the plan conductor's own rule (ADR-0145). */
export type PlanStepState =
  | 'waiting'
  | 'awaiting_approval'
  | 'running'
  | 'completed'
  | 'stopped'
  | 'declined'
  | 'skipped'
  | 'failed';

export interface PlanDetail extends PlanView {
  readonly current: {
    readonly version: number;
    readonly digest: string;
    readonly request: { readonly summary: string; readonly objective: string };
    readonly steps: readonly PlanStepView[];
    readonly riskLevel: string;
    /** An estimate in credits, never a charge: `unknown` whenever a price or rate is missing. */
    readonly estimate?: {
      readonly status: 'estimated' | 'unknown';
      readonly credits: number | null;
    };
    readonly source:
      | { readonly kind: 'planner' }
      | {
          readonly kind: 'workflow';
          readonly workflowId: string;
          readonly workflowVersion: number;
        };
  };
}

export interface PlanStepProgress {
  readonly stepId: string;
  /** `specialist` or `condition` (a check). */
  readonly kind?: string;
  readonly label: string;
  readonly state?: PlanStepState;
  /** On a check, once decided: what the decision said, e.g. `allowed`. */
  readonly outcome?: string | null;
  readonly executionId: string | null;
  /** A specialist step's execution status; none on a check or before the step was delegated. */
  readonly status: string | null;
  /** The approval a step waits for or was declined by (ADR-0146), decided in Approvals. */
  readonly approvalId?: string | null;
  /** Why it failed; on a declined step: `rejected`, `expired`, `cancelled` or `mismatch`. */
  readonly failure: string | null;
  readonly answer: string | null;
  readonly missing: readonly string[];
}

/** Planning a workflow gives its plan, or why the plan was refused. */
export type WorkflowPlanOutcome =
  | { readonly status: 'planned'; readonly plan: PlanDetail }
  | { readonly status: 'refused'; readonly reason: string };

export interface AutomationsClient {
  workflows(): Promise<readonly WorkflowView[]>;
  workflow(workflowId: string): Promise<WorkflowDetail>;
  createWorkflow(name: string, steps: readonly WorkflowStepDraft[]): Promise<WorkflowView>;
  /** A new version: the one before it stays as it was, and plans made from it keep it. */
  publishVersion(
    workflowId: string,
    name: string,
    steps: readonly WorkflowStepDraft[],
  ): Promise<WorkflowView>;
  changeStatus(workflowId: string, from: WorkflowStatus, to: WorkflowStatus): Promise<WorkflowView>;
  /** The actions a check step may name: the Decision Engine's catalogue, as the API lists it. */
  checkActions(): Promise<readonly string[]>;
  /** The same `requestKey` is the same plan: a retry never plans twice. */
  planWorkflow(workflowId: string, requestKey: string): Promise<WorkflowPlanOutcome>;
  plans(): Promise<readonly PlanView[]>;
  plan(planId: string): Promise<PlanDetail>;
  steps(planId: string): Promise<readonly PlanStepProgress[]>;
  decide(
    planId: string,
    decision: 'approve' | 'reject',
    seen: { readonly version: number; readonly digest: string },
  ): Promise<PlanView>;
}

/** The API refused or failed, with its code: the screen says what happened, never guesses. */
export class AutomationsError extends Error {
  override readonly name = 'AutomationsError';
  constructor(
    readonly status: number,
    readonly code: string,
    /** For an invalid workflow: which field, a code. */
    readonly detail?: string,
  ) {
    super(`automations request failed: ${status} ${code}`);
  }
}

/** Whether a plan may still change on its own: the screen reads its steps again until it ends. */
export const isRunningPlan = (plan: Pick<PlanView, 'status'>): boolean =>
  plan.status === 'executing' || plan.status === 'approved';

export function createAutomationsClient(
  request: ReplyRequest,
  organizationId: string,
): AutomationsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await request(`${base}${path}`, init);
    if (!response.ok && response.status !== 422) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: unknown;
        detail?: unknown;
      };
      throw new AutomationsError(
        response.status,
        typeof body.error === 'string' ? body.error : 'unexpected',
        typeof body.detail === 'string' ? body.detail : undefined,
      );
    }
    return response;
  }
  const post = (path: string, body: unknown) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const plan = (id: string) => `/plans/${encodeURIComponent(id)}`;
  const workflow = (id: string) => `/workflows/${encodeURIComponent(id)}`;
  return {
    async workflows() {
      const body = (await (await call('/workflows')).json()) as { workflows?: WorkflowView[] };
      return body.workflows ?? [];
    },
    async workflow(id) {
      return (await (await call(workflow(id))).json()) as WorkflowDetail;
    },
    async createWorkflow(name, steps) {
      const response = await post('/workflows', { name, steps: workflowStepsOf(steps) });
      return (await response.json()) as WorkflowView;
    },
    async publishVersion(id, name, steps) {
      const response = await post(`${workflow(id)}/versions`, {
        name,
        steps: workflowStepsOf(steps),
      });
      return (await response.json()) as WorkflowView;
    },
    async changeStatus(id, from, to) {
      return (await (await post(`${workflow(id)}/status`, { from, to })).json()) as WorkflowView;
    },
    async checkActions() {
      const body = (await (await call('/decisions/actions')).json()) as {
        actions?: { action?: unknown }[];
      };
      return (body.actions ?? []).flatMap((a) => (typeof a.action === 'string' ? [a.action] : []));
    },
    async planWorkflow(workflowId, requestKey) {
      const response = await post(`/workflows/${encodeURIComponent(workflowId)}/plans`, {
        requestKey,
      });
      const body = (await response.json()) as Record<string, unknown>;
      if (response.status === 422) {
        return {
          status: 'refused',
          reason: typeof body.reason === 'string' ? body.reason : 'unexpected',
        };
      }
      return { status: 'planned', plan: body as unknown as PlanDetail };
    },
    async plans() {
      const body = (await (await call('/plans')).json()) as { plans?: PlanView[] };
      return body.plans ?? [];
    },
    async plan(id) {
      return (await (await call(plan(id))).json()) as PlanDetail;
    },
    async steps(id) {
      const body = (await (await call(`${plan(id)}/steps`)).json()) as {
        steps?: PlanStepProgress[];
      };
      return body.steps ?? [];
    },
    async decide(id, decision, seen) {
      const response = await post(`${plan(id)}/${decision}`, {
        version: seen.version,
        digest: seen.digest,
      });
      if (response.status === 422) throw new AutomationsError(422, 'unexpected');
      return (await response.json()) as PlanView;
    },
  };
}
