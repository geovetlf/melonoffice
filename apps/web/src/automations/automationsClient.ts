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
  /** A wait's length (ADR-0152); none on other steps. */
  readonly wait?: { readonly seconds: number } | null;
  /** A tool step's agent step, tool, fixed input and earlier results (ADR-0165). */
  readonly performedBy?: string | null;
  readonly tool?: { readonly id: string; readonly version: number } | null;
  readonly input?: Readonly<Record<string, unknown>> | null;
  readonly inputFrom?: Readonly<
    Record<string, { readonly step: string; readonly field?: string }>
  > | null;
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
 * - `wait`: a set time, after the steps it waits for, before the steps after it (ADR-0152).
 * - `tool`: a read-only tool an agent step's agent uses, in that step's work (ADR-0165).
 */
export type WorkflowStepDraft =
  WorkflowAgentDraft | WorkflowCheckDraft | WorkflowWaitDraft | WorkflowToolDraft;

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

export interface WorkflowWaitDraft extends WorkflowDraftBase {
  readonly kind: 'wait';
  /** How many `unit`s it waits; null while the person has not said. */
  readonly amount: number | null;
  readonly unit: WaitUnit;
}

/**
 * A tool step (ADR-0159, ADR-0161): the agent of an earlier agent step (`performer`, its key) uses
 * a tool that only reads, as part of that step's work. It waits for that step alone (`after` is
 * that key), and no other step waits for it. Each input is a fixed value, the answer of an
 * earlier agent step, or a field of an earlier tool step's result. The server checks each again.
 */
export interface WorkflowToolDraft extends WorkflowDraftBase {
  readonly kind: 'tool';
  readonly performer: string;
  /** Empty while the person has not chosen. */
  readonly toolId: string;
  readonly toolVersion: number;
  readonly values: Readonly<Record<string, ToolValueDraft>>;
}

export type ToolValueDraft =
  | { readonly from: 'fixed'; readonly value: string | number | boolean }
  | { readonly from: 'answer'; readonly step: string }
  | { readonly from: 'result'; readonly step: string; readonly field: string };

export type WaitUnit = 'minutes' | 'hours' | 'days';
export const WAIT_UNIT_SECONDS: Readonly<Record<WaitUnit, number>> = {
  minutes: 60,
  hours: 3_600,
  days: 86_400,
};
/** The longest wait the engine takes (ADR-0152). */
export const MAX_WAIT_SECONDS = 7 * 86_400;

/** A wait's length in seconds, when it is a whole number the engine takes; otherwise undefined. */
export function waitSecondsOf(d: Pick<WorkflowWaitDraft, 'amount' | 'unit'>): number | undefined {
  if (d.amount === null || !Number.isInteger(d.amount) || d.amount < 1) return undefined;
  const seconds = d.amount * WAIT_UNIT_SECONDS[d.unit];
  return seconds <= MAX_WAIT_SECONDS ? seconds : undefined;
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
    if (d.kind === 'wait') {
      return { ...base, kind: 'wait', wait: { seconds: waitSecondsOf(d) ?? 0 } };
    }
    if (d.kind === 'tool') {
      const input: Record<string, string | number | boolean> = {};
      const inputFrom: Record<string, { step: string; field?: string }> = {};
      for (const [key, v] of Object.entries(d.values)) {
        if (v.from === 'fixed') {
          if (v.value !== '') input[key] = v.value;
          continue;
        }
        const step = ids.get(v.step);
        if (step !== undefined) {
          inputFrom[key] = v.from === 'result' ? { step, field: v.field } : { step };
        }
      }
      return {
        ...base,
        kind: 'tool',
        performedBy: ids.get(d.performer) ?? '',
        tool: { id: d.toolId, version: d.toolVersion },
        ...(Object.keys(input).length === 0 ? {} : { input }),
        ...(Object.keys(inputFrom).length === 0 ? {} : { inputFrom }),
      };
    }
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
  /** When it last changed: for an ended plan, when it ended. An older API sends none. */
  readonly updatedAt?: string;
  /**
   * Each step the approved credit budget could not cover (ADR-0163): what the plan had used, what
   * the step needed, and the budget. An older API sends none.
   */
  readonly budgetBlocks?: readonly PlanBudgetBlockView[];
}

export interface PlanBudgetBlockView {
  readonly stepId: string;
  readonly usedCredits: number;
  readonly neededCredits: number;
  readonly capCredits: number;
  readonly blockedAt: string;
}

export interface PlanStepView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly dependsOn: readonly string[];
  /** A check's decision (WF-4); none on other steps. */
  readonly decision?: WorkflowDecisionView | null;
  /** Who does a specialist step: the agent and its version. */
  readonly specialist?: { readonly id: string; readonly version: number } | null;
  /** On a tool step: the agent step whose agent uses it, and the tool (ADR-0151). */
  readonly performedBy?: string | null;
  readonly tool?: { readonly id: string; readonly version: number } | null;
  /** Whether a person approves it before it starts (ADR-0146). */
  readonly approvalRequired?: boolean;
}

/** Where a step is, by the plan conductor's own rule (ADR-0145). */
export type PlanStepState =
  | 'waiting'
  | 'awaiting_approval'
  | 'delayed'
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
  /** `specialist`, `condition` (a check), `wait` (ADR-0152) or `tool` (ADR-0167). */
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
  /**
   * On a wait step that started (ADR-0152): when the steps after it may start. On a step's next
   * attempt (ADR-0153): when it may start.
   */
  readonly until?: string | null;
  /** On a specialist step: which run of it its execution is, from 1 (ADR-0153). */
  readonly attempt?: number | null;
  /** When it ended, on a step that ran and ended (ADR-0167). */
  readonly endedAt?: string | null;
  /**
   * On a tool step that ran (ADR-0167): its result as a person reads it, each top-level field a
   * count (a list), a yes/no, a number or a short text. Never the found content itself.
   */
  readonly result?: readonly ToolResultField[] | null;
}

export type ToolResultField =
  | { readonly name: string; readonly type: 'count'; readonly value: number }
  | { readonly name: string; readonly type: 'boolean'; readonly value: boolean }
  | { readonly name: string; readonly type: 'number'; readonly value: number }
  | { readonly name: string; readonly type: 'text'; readonly value: string };

/** Who would do a step of one role today, and the tools its skills let it use (ADR-0167). */
export interface WorkflowAssigneeView {
  readonly departmentTypeId: string;
  readonly roleId: string;
  readonly agent: { readonly id: string; readonly displayName: string };
  readonly tools: readonly {
    readonly id: string;
    readonly version: number;
    /** Whether a plan takes it as a step here (ADR-0168). */
    readonly step?: {
      readonly usable: boolean;
      readonly riskLevel?: string;
      readonly approvalRequired?: boolean;
      readonly reason?: string;
    };
  }[];
}

/**
 * A dry run of a draft (ADR-0168): what saving and planning it now would decide, stored nowhere.
 * Refused: the stage and codes, as a plan refusal names them.
 */
export type WorkflowCheckView =
  | {
      readonly ok: true;
      readonly approvalRequired: boolean;
      readonly steps: readonly {
        readonly id: string;
        readonly kind: string;
        readonly approvalRequired: boolean;
        readonly agent?: { readonly id: string; readonly displayName: string };
      }[];
    }
  | {
      readonly ok: false;
      readonly stage: string;
      readonly reason: string;
      readonly detail?: string;
    };

/**
 * What GIA drafted from a person's words (ADR-0171), checked by the server as planning would.
 * Everything a summary shows comes from the validated steps, never from the model's prose; only
 * GIA's question or its "cannot be done" are its own words. Nothing was stored.
 */
export type WorkflowDraftView =
  | {
      readonly status: 'ready';
      readonly name: string;
      /** The steps as the workflow routes take them: saved exactly as they were checked. */
      readonly steps: readonly DraftStep[];
      readonly summary: WorkflowDraftSummaryView;
    }
  | {
      /** Planning would refuse these steps: they are never shown as valid, nor saved. */
      readonly status: 'invalid';
      readonly name: string;
      readonly steps: readonly DraftStep[];
      readonly problem: {
        readonly stage: string;
        readonly reason: string;
        readonly detail?: string;
      };
    }
  | { readonly status: 'needs_clarification'; readonly question: string }
  | { readonly status: 'not_possible'; readonly reason: string }
  | { readonly status: 'no_agents' }
  | { readonly status: 'failed'; readonly code: string };

/** A drafted step, as the API's workflow routes take it. */
export type DraftStep = Readonly<Record<string, unknown>>;

export interface WorkflowDraftStepSummaryView {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly dependsOn: readonly string[];
  readonly approvalRequired: boolean;
  readonly agent?: {
    readonly id: string;
    readonly displayName: string;
    readonly departmentTypeId: string;
    readonly roleId: string;
  };
  readonly tool?: {
    readonly id: string;
    readonly version: number;
    readonly changesData: boolean;
    readonly riskLevel: string;
  };
  readonly waitSeconds?: number;
}

export interface WorkflowDraftSummaryView {
  readonly steps: readonly WorkflowDraftStepSummaryView[];
  readonly riskLevel: string;
  readonly approvalRequired: boolean;
  readonly changesData: boolean;
  /** How it runs: a person starts it. There are no schedules yet. */
  readonly schedule: 'manual';
  /** The steps nothing waits for: what it ends with. */
  readonly results: readonly string[];
}

/**
 * A draft's steps as the editor's step views: the fields the API leaves out are none. The
 * editor rewrites them only when it can do so without changing them (`draftsOf`).
 */
export function stepViewsOf(steps: readonly unknown[]): readonly WorkflowStepView[] {
  return steps.map((raw) => {
    const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const assignee = s.assignee as WorkflowStepView['assignee'] | undefined;
    return {
      id: String(s.id ?? ''),
      kind: String(s.kind ?? ''),
      label: String(s.label ?? ''),
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
      assignee: assignee ?? null,
      decision: (s.decision as WorkflowStepView['decision']) ?? null,
      wait: (s.wait as WorkflowStepView['wait']) ?? null,
      performedBy: typeof s.performedBy === 'string' ? s.performedBy : null,
      tool: (s.tool as WorkflowStepView['tool']) ?? null,
      input: (s.input as WorkflowStepView['input']) ?? null,
      inputFrom: (s.inputFrom as WorkflowStepView['inputFrom']) ?? null,
      approvalRequired: s.approvalRequired === true,
    };
  });
}

/** Planning a workflow gives its plan, or why the plan was refused. */
export type WorkflowPlanOutcome =
  | { readonly status: 'planned'; readonly plan: PlanDetail }
  | {
      readonly status: 'refused';
      readonly reason: string;
      /** The validation stage and the field it names: codes, for the technical detail. */
      readonly stage?: string;
      readonly detail?: string;
    };

/**
 * Everything that happened in a plan (ADR-0157), as much as the plan screen shows of it: codes,
 * ids, times and numbers only.
 */
export interface PlanTraceView {
  readonly status: string;
  readonly failure: {
    readonly code: string;
    readonly stepId: string | null;
    readonly cause: string | null;
  } | null;
  readonly steps: readonly {
    readonly stepId: string;
    readonly label: string;
    readonly attempts: readonly {
      readonly attempt: number;
      readonly status: string;
      readonly failure: string | null;
      readonly durationMs: number | null;
      readonly credits: number;
      readonly nodes: readonly {
        readonly nodeId: string;
        readonly type: string;
        readonly status: string;
        readonly error: string | null;
      }[];
    }[];
    readonly credits: number;
  }[];
  readonly credits: { readonly total: number };
  readonly history: readonly {
    readonly action: string;
    readonly result: string;
    readonly at: string;
    readonly reason: string | null;
  }[];
}

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
  /** The plan's trace (ADR-0157). Absent: the screen shows none. */
  trace?(planId: string): Promise<PlanTraceView>;
  /**
   * Who would do each role's steps today and their tools (ADR-0167), `workflow.manage`. Absent or
   * failing: the editor offers no tool as usable, since it cannot tell which one would run.
   */
  assignees?(): Promise<readonly WorkflowAssigneeView[]>;
  /** A dry run of a draft before it is saved (ADR-0168), `workflow.manage` and `plan.create`. */
  checkWorkflow?(name: string, steps: readonly WorkflowStepDraft[]): Promise<WorkflowCheckView>;
  /**
   * GIA drafts a workflow from the person's words (ADR-0171): `workflow.manage`, `plan.create`
   * and `gia.ask`. Nothing is stored. Absent: no draft is offered.
   */
  draftWorkflow?(intent: string): Promise<WorkflowDraftView>;
  /** Saves a draft GIA proposed, exactly as the server checked it, as a new workflow draft. */
  saveDraft?(name: string, steps: readonly DraftStep[]): Promise<WorkflowView>;
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
          ...(typeof body.stage === 'string' ? { stage: body.stage } : {}),
          ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
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
    async trace(id) {
      return (await (await call(`${plan(id)}/trace`)).json()) as PlanTraceView;
    },
    async assignees() {
      const body = (await (await call('/workflows/assignees')).json()) as {
        assignees?: WorkflowAssigneeView[];
      };
      return body.assignees ?? [];
    },
    async checkWorkflow(name, steps) {
      const response = await post('/workflows/check', { name, steps: workflowStepsOf(steps) });
      return (await response.json()) as WorkflowCheckView;
    },
    async draftWorkflow(intent) {
      return (await (await post('/workflows/draft', { intent })).json()) as WorkflowDraftView;
    },
    async saveDraft(name, steps) {
      return (await (await post('/workflows', { name, steps })).json()) as WorkflowView;
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
