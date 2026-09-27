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
 * together.
 */
export type PlanStepKind =
  'specialist' | 'tool' | 'approval' | 'verification' | 'condition' | 'parallel';

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
  readonly inputContract?: ToolSchema;
  readonly outputContract?: ToolSchema;
  /** Required on `specialist` and `verification` steps. */
  readonly verification?: PlanVerification;
  /** On `condition` steps. */
  readonly condition?: PlanCondition;
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
  readonly delegations: readonly PlanDelegation[];
  readonly decision?: PlanDecision;
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
