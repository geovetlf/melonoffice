import type { HarnessDataClass } from './data.js';
import type { HandoffToHuman } from './handoff.js';
import type { HarnessLimits } from './limits.js';
import type { HarnessAINeed } from './routing.js';
import type {
  AIQualityTier,
  AIRoutingStrategy,
  DataSensitivity,
  OrganizationId,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';

/**
 * The Melon Agent Harness (ADR-0099): the layer of MelonMotor that, for one task, decides what
 * the task needs (intent, context, agent, model profile, tools, budget) and hands it to the
 * engines that already do each part. It has no store, no provider, no ledger and no tool runner
 * of its own: every decision here is data the existing engines act on, under their own checks.
 */

/** What a task asks for, as the Harness reads it. A code, never shown as advice. */
export type HarnessIntent =
  | 'question'
  | 'classification'
  | 'extraction'
  | 'summary'
  | 'generation'
  | 'analysis'
  | 'planning'
  | 'action';

export const HARNESS_INTENTS: readonly HarnessIntent[] = Object.freeze([
  'question',
  'classification',
  'extraction',
  'summary',
  'generation',
  'analysis',
  'planning',
  'action',
]);

/** The business areas a task touches, which decide its context and department. */
export type HarnessDomain = 'crm' | 'finance' | 'marketing' | 'operations' | 'knowledge';

export type HarnessComplexity = 'simple' | 'standard' | 'complex';

/** What the Harness read in a request: deterministic, from fixed rules; no model, no cost. */
export interface TaskClassification {
  readonly intent: HarnessIntent;
  readonly domains: readonly HarnessDomain[];
  readonly complexity: HarnessComplexity;
  /** The person asked for a person, in their own words. */
  readonly asksForPerson: boolean;
  /** The rules that matched, `kind:id`, for tracing. */
  readonly signals: readonly string[];
}

/** Where a task's context may come from. Each is an existing engine, read as the person. */
export type HarnessContextSourceId = 'company_brain' | 'crm';

/**
 * How the model should be chosen for a task. Never a model or a provider: the AI Gateway's router
 * still chooses under the agent's model policy. `strategy` only orders the models that fit;
 * `minimumQuality`, when a policy sets it, is a floor the router enforces (no model: refused).
 */
export interface ModelProfile {
  readonly strategy: AIRoutingStrategy;
  readonly minimumQuality?: AIQualityTier;
}

/**
 * How a tool's use is treated (the brief's classes), from the tool's own declaration. The Tool
 * Gate still decides each call: this only says what a person should expect.
 */
export type ToolAuthorizationClass =
  'informative' | 'reversible' | 'sensitive' | 'external' | 'irreversible';

/**
 * The three levels of tool use (Geovet, 2026-09-30):
 *
 * - `A`, safe reads: automatic when the agent has the permission;
 * - `B`, reversible or low-risk changes inside MelonOffice: automatic under the agent's
 *   permissions and the organization's policy;
 * - `C`, sensitive actions (sending outside, paying, billing, deleting, permissions, publishing,
 *   hiring, critical settings): a person approves, when the policy asks for it.
 */
export type ToolLevel = 'A' | 'B' | 'C';

export interface HarnessTool {
  readonly id: string;
  readonly version: number;
  readonly level: ToolLevel;
  readonly authorization: ToolAuthorizationClass;
  /** Whether each use waits on a person's approval at the gate. */
  readonly approvalRequired: boolean;
}

/**
 * The outcome of preparing a task:
 *
 * - `ready`: an agent was chosen and the task can start;
 * - `choose_agent`: several agents fit and nothing tells them apart: the person chooses;
 * - `no_agent`: no active agent can take it;
 * - `needs_authorization`: it can start only after a person authorizes more (reserved for budget);
 * - `handoff_to_human`: a person should take it (the person asked for one);
 * - `refused`: it cannot run (no credits, no permission).
 */
export type HarnessVerdict =
  'ready' | 'choose_agent' | 'no_agent' | 'needs_authorization' | 'handoff_to_human' | 'refused';

/**
 * Who a task runs for, only from the resolved tenant the backend built: never from the request.
 * Partners and agencies are the commercial platform's (ADR-0085), not a tenant's: a task runs in
 * exactly one organization.
 */
export interface HarnessExecutionContext {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly actor: 'user' | 'gia' | 'runtime';
  readonly role: string;
}

export interface HarnessAgent {
  readonly id: SpecialistId;
  readonly name: string;
  readonly department: string;
}

/** What the Harness decided for one task: the strategy the engines then carry out. */
export interface ExecutionStrategy {
  readonly version: 1;
  readonly context: HarnessExecutionContext;
  readonly classification: TaskClassification;
  /**
   * One agent task, or a task that needs a plan of several steps. Once the planner made the plan
   * (ADR-0101), its id, status and step count; the plan runs only when a person approves it.
   */
  readonly plan: {
    readonly mode: 'single_step' | 'multi_step';
    readonly id?: string;
    readonly status?: string;
    readonly steps?: number;
  };
  /** The context sources the task needs, and only those. */
  readonly contextPlan: readonly HarnessContextSourceId[];
  readonly agent: HarnessAgent | null;
  /** When the person must choose: the agents that fit. */
  readonly candidates: readonly HarnessAgent[];
  readonly model: ModelProfile;
  /**
   * The kind of AI work the task needs and what the router selects on for it (ADR-0100). A task
   * given as words is `text`; other kinds come with the inputs that carry them.
   */
  readonly need: HarnessAINeed;
  /** The tools the chosen agent's skills grant that this person may use. */
  readonly tools: readonly HarnessTool[];
  /**
   * What the task's data is and how sensitive (ADR-0100): the data policy decides, before any
   * routing, which providers may receive it.
   */
  readonly data: { readonly class: HarnessDataClass; readonly sensitivity: DataSensitivity };
  /** What the task may use at most. */
  readonly limits: HarnessLimits;
  /**
   * The credits side: whether the balance allows starting, and the task's own budget when the
   * person set one (ADR-0100). Each model call is then limited to what is left of it.
   */
  readonly budget: {
    readonly status: 'available' | 'insufficient' | 'unavailable';
    readonly maxCredits: number | null;
  };
  readonly verdict: HarnessVerdict;
  /** When the task goes to a person (`handoff_to_human`), why (ADR-0101). */
  readonly handoff: HandoffToHuman | null;
  /** Why, as closed codes. */
  readonly reasons: readonly string[];
}

/** A task as it is given to the Harness. Content only: who it is for comes from the tenant. */
export interface HarnessTask {
  readonly request: string;
  /** The agent the person chose, when they chose one. */
  readonly specialistId?: string;
  /** The department type the person chose, when they chose one. */
  readonly department?: string;
  readonly idempotencyKey?: string;
  /** The most credits the task may spend (ADR-0100). Absent: no task budget. */
  readonly maxCredits?: number;
}

export type HarnessErrorCode = 'unresolved_tenant' | 'invalid_task' | 'permission_denied';

export class HarnessError extends Error {
  override readonly name = 'HarnessError';
  constructor(
    readonly code: HarnessErrorCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isHarnessError = (error: unknown): error is HarnessError =>
  error instanceof HarnessError;
