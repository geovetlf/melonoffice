import type { ExecutionId, WorkflowId } from './execution.js';
import type {
  Brand,
  DepartmentId,
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
  RoleId,
  SpecialistId,
  ToolId,
  UserId,
} from './ids.js';
import type { ToolRiskLevel, ToolSchema } from './tool.js';

/** Globally unique id of a plan (a UUID). */
export type PlanId = Brand<string, 'PlanId'>;

/**
 * Where a plan is in its life (ADR-0028). `rejected`, `completed`, `failed` and `cancelled` are
 * terminal. A plan never runs anything by existing: only delegation turns it into work.
 */
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

/**
 * What a step stands for. `specialist` is work a specialist does; `tool` is one exact tool
 * version a specialist step uses; `approval` is a human checkpoint; `verification` checks
 * results; `condition` depends on how another step ended; `parallel` groups steps that may run
 * together; `wait` delays the steps after it (ADR-0152).
 */
export type PlanStepKind =
  'specialist' | 'tool' | 'approval' | 'verification' | 'condition' | 'parallel' | 'wait';

/** On `wait` steps (ADR-0152): how long the steps after it wait once the steps before it ended. */
export interface PlanWaitSpec {
  readonly seconds: number;
}

/**
 * A wait step that started (ADR-0152): when, and until when. Recorded once, when the steps it
 * depends on completed; the steps after it start once `until` passed.
 */
export interface PlanWait {
  readonly stepId: string;
  readonly startedAt: IsoTimestamp;
  readonly until: IsoTimestamp;
}

/**
 * Another run of a specialist step whose child failed for a passing reason (ADR-0153): a new
 * child execution, under its own deterministic id, started no earlier than `notBefore`.
 */
export interface PlanStepAttempt {
  readonly stepId: string;
  /** 2 for the first retry, up to the step's `retry.maxAttempts`. */
  readonly attempt: number;
  readonly executionId: ExecutionId;
  /** The child that failed before it, and why. */
  readonly after: ExecutionId;
  readonly failure: string;
  readonly recordedAt: IsoTimestamp;
  /** The step's backoff: its child starts no earlier. */
  readonly notBefore: IsoTimestamp;
}

/**
 * A step the plan's approved credit budget could not cover (ADR-0163): it never starts, and its
 * branch ends. What the plan had used, what the step needed and the budget, in credits, as they
 * were when it was blocked.
 */
export interface PlanBudgetBlock {
  readonly stepId: string;
  readonly usedCredits: number;
  readonly neededCredits: number;
  readonly capCredits: number;
  readonly blockedAt: IsoTimestamp;
}

/** How a step's result is checked before it counts as done (the Verification Engine is X6). */
export type VerificationPolicy = 'output_schema' | 'human_review' | 'specialist_review' | 'checks';

export interface PlanVerification {
  readonly policy: VerificationPolicy;
  /** A stable code for what the result must be, e.g. `market_summary`. */
  readonly expectedOutput: string;
  readonly outputSchema?: ToolSchema;
  /** Stable codes of checks the result must pass, e.g. `sources_cited`. */
  readonly requiredChecks: readonly string[];
}

/** Run this step only when another step ended this way. */
export interface PlanCondition {
  readonly step: string;
  readonly outcome: 'completed' | 'failed';
}

/**
 * A condition decided by the Decision Engine (WF-4, ADR-0075): when the steps it depends on have
 * completed, the decision type is evaluated with this input, and the plan goes on only when its
 * outcome is one of `continueOn`. The same shape as the Decision Engine's workflow contract
 * (ADR-0065), so there is one decision path.
 */
export interface PlanDecisionCondition {
  /** The decision type, e.g. `action.policy_check`. */
  readonly decision: string;
  /** Outcomes that let the steps after this one run. Any other skips them. */
  readonly continueOn: readonly string[];
  /** The decision's input: short codes and numbers, fixed when the plan is made. Never content. */
  readonly input?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * What a condition step did (WF-4, ADR-0075), recorded once on the plan:
 * - `continue`: the steps after it may run;
 * - `stop`: the steps after it are skipped, and the rest of the plan goes on;
 * - `await_approval`: the decision needs an approval, which a plan cannot wait for yet, so the
 *   plan stops;
 * - `failed`: the decision could not be made (`failure` says why), so the plan stops.
 */
export interface PlanConditionResult {
  readonly stepId: string;
  readonly result: 'continue' | 'stop' | 'await_approval' | 'failed';
  /** The decision, when one was made: its id links to its audit event. */
  readonly decision?: {
    readonly id: string;
    readonly type: string;
    readonly version: number;
    readonly outcome: string;
  };
  /** On `failed`: a stable code. */
  readonly failure?: string;
  readonly evaluatedAt: IsoTimestamp;
}

/**
 * The approval a specialist step with `approvalRequired` asked for when it became ready
 * (ADR-0146), one per step. The approval itself lives in the approvals system (ADR-0026), bound
 * to this plan version, step and child execution; the plan only records which one it is.
 */
export interface PlanStepApproval {
  readonly stepId: string;
  readonly approvalId: string;
  readonly requestedAt: IsoTimestamp;
  /**
   * On a tool step's approval (ADR-0151), `stepId` is the tool step and this is the specialist
   * step that uses it: that step starts only once every approval it waits for was given.
   */
  readonly performedBy?: string;
  /**
   * Set once the approval was rejected, expired or withdrawn: the step never runs and the steps
   * after it are skipped, while the other branches go on. `reason` is a stable code.
   */
  readonly declined?: { readonly reason: string; readonly at: IsoTimestamp };
}

/** A tool step's fixed input: plain JSON values only. */
export type PlanToolValue =
  | string
  | number
  | boolean
  | null
  | readonly PlanToolValue[]
  | { readonly [key: string]: PlanToolValue };
export type PlanToolInput = { readonly [key: string]: PlanToolValue };

/**
 * Where one value of a tool step's input comes from when the step runs (ADR-0161): the answer of
 * an earlier specialist step (no `field`), or one field of an earlier tool step's result. Checked
 * when the plan is made; read on the server, for the plan's own organization, as data.
 */
export interface PlanInputRef {
  readonly step: string;
  readonly field?: string;
}

export interface PlanRetry {
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

/** The most tokens a specialist step's AI work may use, for estimates only. */
export interface PlanBudget {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * An estimate, never a charge. `unknown` when any price, rate or budget is missing: MelonOffice
 * never invents a cost (D-12).
 */
export interface PlanEstimate {
  readonly status: 'estimated' | 'unknown';
  readonly costMicroUsd: number | null;
  readonly credits: number | null;
}

/** The specialist a step is delegated to, as eligibility (ADR-0025) confirmed it. */
export interface PlanStepSpecialist {
  readonly id: SpecialistId;
  readonly version: number;
  readonly departmentId: DepartmentId;
}

export interface PlanStep {
  readonly id: string;
  readonly kind: PlanStepKind;
  readonly label: string;
  readonly dependsOn: readonly string[];
  /** On `specialist` steps. */
  readonly specialist?: PlanStepSpecialist;
  /** On `tool` steps: the specialist step that uses the tool. */
  readonly performedBy?: string;
  /** On `tool` steps: the exact tool version. */
  readonly tool?: { readonly id: ToolId; readonly version: number };
  /**
   * On `tool` steps (ADR-0151): the tool's input, fixed when the plan is made and checked against
   * the tool's own input schema then and again by the Tool Gate when it runs. Data, never
   * authority: the organization, agent, approval and credentials always come from the server.
   */
  readonly input?: PlanToolInput;
  /**
   * On `tool` steps (ADR-0161): input values taken from earlier steps' results when it runs, by
   * input key. Never a key of `input`; only on a tool step no person has to approve.
   */
  readonly inputFrom?: { readonly [key: string]: PlanInputRef };
  readonly inputContract?: ToolSchema;
  readonly outputContract?: ToolSchema;
  /** Required on `specialist` and `verification` steps. */
  readonly verification?: PlanVerification;
  /** On `condition` steps that depend on how another step ended. */
  readonly condition?: PlanCondition;
  /** On `condition` steps the Decision Engine decides (WF-4). */
  readonly decision?: PlanDecisionCondition;
  /** On `wait` steps (ADR-0152). */
  readonly wait?: PlanWaitSpec;
  readonly retry?: PlanRetry;
  /** Whether a human must approve before this step runs. Decided by the system, never lowered by a model. */
  readonly approvalRequired: boolean;
  readonly budget?: PlanBudget;
  /** On `specialist` steps with a budget. */
  readonly estimate?: PlanEstimate;
}

/** Where a plan version came from. */
export type PlanSource =
  | {
      readonly kind: 'planner';
      /** The model and versions that proposed it, as the AI Gateway reported them. */
      readonly model: {
        readonly provider: string;
        readonly id: string;
        readonly version: string;
      };
      readonly policy: { readonly id: string; readonly version: number };
    }
  | {
      readonly kind: 'workflow';
      readonly workflowId: WorkflowId;
      readonly workflowVersion: number;
    };

/** What was asked, in short. The full request stays where the execution's input points. */
export interface PlanRequest {
  readonly summary: string;
  readonly objective: string;
}

/**
 * One version of a plan: written once and never changed (ADR-0028). A change is a new version,
 * and an approval is bound to the digest of exactly one version.
 */
export interface PlanVersion {
  readonly planId: PlanId;
  readonly organizationId: OrganizationId;
  readonly version: number;
  readonly request: PlanRequest;
  readonly steps: readonly PlanStep[];
  readonly riskLevel: ToolRiskLevel;
  readonly approvalRequired: boolean;
  readonly estimate: PlanEstimate;
  readonly source: PlanSource;
  /** SHA-256 of the canonical content above. */
  readonly digest: string;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
}

/** One specialist step handed to its own child execution. */
export interface PlanDelegation {
  readonly stepId: string;
  readonly executionId: ExecutionId;
}

/**
 * Where a plan's delegation is (ADR-0028). No state: not delegated yet (pending).
 *
 * - `creating`: the delegation set is recorded (one deterministic child id per specialist step)
 *   and its children are being created. Recoverable: delegating again resumes it.
 * - `created`: every child exists and the plan is `executing`; the planning execution may still
 *   be moving to `running`. Recoverable the same way.
 * - `completed`: the planning execution is `running`. Delegating again changes nothing.
 * - `failed`: a specialist could no longer take its step; the plan failed and the children that
 *   were created are cancelled. Final.
 */
export type PlanDelegationState = 'creating' | 'created' | 'completed' | 'failed';

/** A human decision on one plan version. Never GIA's, never the model's. */
export interface PlanDecision {
  readonly decision: 'approved' | 'rejected';
  readonly version: number;
  readonly digest: string;
  readonly decidedBy: UserId;
  readonly decidedAt: IsoTimestamp;
}

export interface Plan {
  readonly id: PlanId;
  readonly organizationId: OrganizationId;
  /** The execution the plan was made for (mode `plan`). */
  readonly executionId: ExecutionId;
  readonly status: PlanStatus;
  /** The current version. */
  readonly version: number;
  /** From `creating` on: one entry per specialist step, with its deterministic child id. */
  readonly delegations: readonly PlanDelegation[];
  readonly delegationState?: PlanDelegationState;
  /** Why a `failed` delegation failed: a stable code. */
  readonly delegationFailure?: string;
  readonly decision?: PlanDecision;
  /** What each condition step did, once evaluated (WF-4). */
  readonly conditions?: readonly PlanConditionResult[];
  /** The approval each step that waits for a person asked for, once (ADR-0146). */
  readonly stepApprovals?: readonly PlanStepApproval[];
  /** Each wait step that started, once (ADR-0152). */
  readonly waits?: readonly PlanWait[];
  /** Each new run of a step that failed for a passing reason, in order (ADR-0153). */
  readonly attempts?: readonly PlanStepAttempt[];
  /** Each step the approved credit budget could not cover, once (ADR-0163). */
  readonly budgetBlocks?: readonly PlanBudgetBlock[];
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
  readonly updatedAt: IsoTimestamp;
}

/** Where a workflow is in its life. Only `active` workflows can be instantiated. */
export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived';

/**
 * A workflow step: a plan step template. A specialist step names who should do it by department
 * type and role, not by specialist, so the same workflow works in any organization; each
 * instantiation binds it to an eligible specialist.
 */
export interface WorkflowStep extends Omit<
  PlanStep,
  'specialist' | 'approvalRequired' | 'estimate'
> {
  readonly assignee?: { readonly departmentTypeId: DepartmentTypeId; readonly roleId: RoleId };
  /** A workflow may ask for approval; the system may still add it. */
  readonly approvalRequired?: boolean;
}

/** One version of a workflow: written once and never changed (ADR-0028). */
export interface WorkflowVersion {
  readonly workflowId: WorkflowId;
  readonly organizationId: OrganizationId;
  readonly version: number;
  readonly name: string;
  readonly steps: readonly WorkflowStep[];
  readonly digest: string;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
}

export interface Workflow {
  readonly id: WorkflowId;
  readonly organizationId: OrganizationId;
  readonly status: WorkflowStatus;
  /** The current version. */
  readonly version: number;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
  readonly updatedAt: IsoTimestamp;
}
