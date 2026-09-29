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
}

export interface PlanDetail extends PlanView {
  readonly current: {
    readonly version: number;
    readonly digest: string;
    readonly request: { readonly summary: string; readonly objective: string };
    readonly steps: readonly PlanStepView[];
    readonly riskLevel: string;
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
  readonly label: string;
  readonly executionId: string | null;
  readonly status: string;
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
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new AutomationsError(
        response.status,
        typeof body.error === 'string' ? body.error : 'unexpected',
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
  return {
    async workflows() {
      const body = (await (await call('/workflows')).json()) as { workflows?: WorkflowView[] };
      return body.workflows ?? [];
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
