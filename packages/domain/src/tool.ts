import type { DepartmentTypeId, MessageKey, ToolId } from './ids.js';

/**
 * How much harm a tool can do (ADR-0026). Risk alone never decides: a risk policy maps it to
 * `auto`, `approval_required` or `denied`, and a tool's own policy can only make that stricter.
 */
export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** The kinds of record a tool's string input may name (ADR-0184). */
export type ToolRecordRef = 'contact';

/** What running a tool needs from a human: nothing, an approval, or it never runs. */
export type ToolApprovalPolicy = 'auto' | 'approval_required' | 'denied';

/** Where a tool is in its life. Only `active` tools run; `archived` is history and final. */
export type ToolStatus = 'draft' | 'active' | 'paused' | 'disabled' | 'archived';

/** The deployment a tool may run in. Being allowed in one never implies another. */
export type DeploymentEnvironment = 'dev' | 'staging' | 'prod';

/**
 * The closed schema language for tool inputs and outputs: plain JSON values, every object
 * closed (no properties beyond those listed). Enough to validate without a schema library.
 */
export type ToolSchema =
  | {
      readonly type: 'string';
      readonly maxLength: number;
      readonly minLength?: number;
      readonly enum?: readonly string[];
      /**
       * The kind of record the value names, by its id (ADR-0184), so a screen can offer a picker.
       * A hint only: it grants nothing, and the service that reads it checks the record again.
       */
      readonly ref?: ToolRecordRef;
    }
  | {
      readonly type: 'number' | 'integer';
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: 'boolean' }
  | { readonly type: 'array'; readonly items: ToolSchema; readonly maxItems: number }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, ToolSchema>>;
      readonly required?: readonly string[];
    };

/**
 * A credential a tool needs, by reference only. The value is resolved in secure infrastructure
 * by a future credential engine and never appears in a definition, input, execution, approval,
 * audit event or prompt.
 */
export interface CredentialReference {
  /** The provider the credential is for, e.g. `google_workspace`. */
  readonly provider: string;
  /** What access it needs, as provider scope codes. */
  readonly scopes: readonly string[];
}

/** Who runs a tool: MelonOffice itself, or an external provider through a connector (later). */
export interface ToolProvider {
  readonly kind: 'internal' | 'external';
  readonly id: string;
}

/**
 * Who may invoke a tool through the gate (ADR-0034). `runtime`: the execution runtime, for a
 * specialist (ADR-0031). `human`: the authenticated user acting directly, synchronously, for a
 * tool built for it. `model`: an agent's model may ask for it in the middle of a task, and the
 * Melon Agent Harness decides (ADR-0103); the runtime still runs it, so it comes with `runtime`.
 * `plan`: a plan's tool step may run it although it changes data (ADR-0184); it comes with
 * `runtime` too, and only an internal write without credentials that a person approves qualifies.
 * Each mode is explicit: allowing one never implies the other.
 */
export type ToolInvocationMode = 'runtime' | 'human' | 'model' | 'plan';

export interface ToolRetryPolicy {
  /** 1 means no retry. */
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

/**
 * One version of a tool: what it is and the policies it runs under. Written once and never
 * changed; a new configuration is a new version (ADR-0026).
 */
export interface ToolVersion {
  readonly toolId: ToolId;
  readonly version: number;
  readonly nameKey: MessageKey;
  readonly descriptionKey: MessageKey;
  /** A stable code, e.g. `documents`, `communication`, `finance`. */
  readonly category: string;
  /** The operation the tool performs, e.g. `read`, `create`, `send`. Approvals bind to it. */
  readonly action: string;
  /** Whether it changes anything. A mutating tool gets an idempotency key. */
  readonly mutating: boolean;
  readonly inputSchema: ToolSchema;
  readonly outputSchema: ToolSchema;
  /** RBAC permissions the user it acts for must hold, beyond `tool.execute`. */
  readonly permissions: readonly string[];
  readonly credentials: readonly CredentialReference[];
  readonly riskLevel: ToolRiskLevel;
  readonly approvalPolicy: ToolApprovalPolicy;
  /** How long an approval request for it stays open. */
  readonly approvalTtlSeconds: number;
  readonly timeoutMs: number;
  readonly retryPolicy: ToolRetryPolicy;
  readonly provider: ToolProvider;
  /** The environments it may run in. */
  readonly environments: readonly DeploymentEnvironment[];
  /**
   * The department types whose specialists may use it. Absent: any department. This is how a
   * finance-only tool stays out of Marketing without a hard-coded matrix.
   */
  readonly departmentTypes?: readonly DepartmentTypeId[];
  /**
   * Who may invoke it (ADR-0034). Absent: `['runtime']` only, as before, so a person can never
   * invoke a tool that does not say so explicitly.
   */
  readonly invocationModes?: readonly ToolInvocationMode[];
}

/** A tool: a stable id, a status, and every version it ever had. */
export interface ToolDefinition {
  readonly id: ToolId;
  readonly status: ToolStatus;
  readonly versions: readonly ToolVersion[];
}
