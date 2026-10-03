import type { ExecutionId, WorkflowId } from './execution.js';
import type { DepartmentId, OrganizationId, SpecialistId, UserId } from './ids.js';

/**
 * The AI Usage Layer's contract (ADR-0073): one shape for the usage and cost of any AI capability
 * MelonOffice uses (language models, images, video, voice, documents, search, browser, and those
 * still to come), whichever engine or router served it. The LLM Router is one source; every
 * other engine emits the same event, and the future Financial Backend reads only this.
 *
 * No unit is universal: each capability counts in its own units (tokens, images, seconds,
 * characters, pages, queries, actions...). Nothing here holds content or secrets.
 */

/**
 * A kind of AI work, e.g. `llm`, `image_generation`, `text_to_speech`. Open: a new capability is
 * a new id (`^[a-z][a-z0-9_]{1,63}$`), registered with its providers, models and prices, not a
 * new type or a new financial system. `AI_USAGE_CAPABILITIES` in `@melonoffice/ai-usage` lists
 * the ones named so far.
 */
export type AIUsageCapability = string;

/** How much of one unit an operation used, e.g. `{ unit: 'output_tokens', quantity: 3000 }`. */
export interface UsageQuantity {
  /** `^[a-z][a-z0-9_]{0,63}$`, e.g. `input_tokens`, `images`, `seconds`, `characters`, `pages`. */
  readonly unit: string;
  /** A non-negative finite number (seconds may be fractional). */
  readonly quantity: number;
}

/** What an operation used, in the capability's own units. */
export interface AIUsage {
  readonly quantities: readonly UsageQuantity[];
  /**
   * What the price depends on besides the quantities, e.g. `{ resolution: '1080p' }` or
   * `{ modelTier: 'hd' }`. Names and short codes only, never content.
   */
  readonly dimensions?: Readonly<Record<string, string>>;
}

/**
 * One price line: `microUsd` per `per` units, optionally only when the usage's dimensions match
 * `when` (e.g. a price for 1080p and another for 4k). The most specific matching line applies.
 */
export interface UsageRate {
  readonly unit: string;
  readonly microUsd: number;
  readonly per: number;
  readonly when?: Readonly<Record<string, string>>;
}

/**
 * A model's or service's price, as configuration, never in business logic. `calculator` names the
 * cost calculator that reads it (`unit_rates` covers any linear price per unit). Unknown: every
 * operation on it is refused, never guessed.
 */
export type AIServicePricing =
  | { readonly status: 'unknown' }
  | {
      readonly status: 'known';
      readonly currency: 'USD';
      readonly calculator: string;
      readonly rates: readonly UsageRate[];
      /** Which price list this is, e.g. the provider's page date or a version tag. */
      readonly version: string;
      /** From when it applies (`YYYY-MM-DD`). */
      readonly effectiveAt: string;
      /** Where it was taken from, e.g. the provider's published price list. */
      readonly source: string;
    };

/**
 * The cost of one operation, the same shape for every capability. Amounts in millionths of a US
 * dollar, rounded up; `null` when the price is unknown (`costBasis: 'price_unknown'`).
 */
export interface CostResult {
  readonly capability: AIUsageCapability;
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly usage: AIUsage;
  /** The units the cost was computed in. */
  readonly units: readonly string[];
  readonly estimatedMicroUsd: number | null;
  readonly actualMicroUsd: number | null;
  readonly currency: 'USD';
  readonly pricingVersion: string | null;
  readonly pricingEffectiveAt: string | null;
  readonly costBasis: 'provider_price_list' | 'price_unknown';
}

/**
 * Who and what an operation's usage belongs to: company → user → agent → department → workflow →
 * task. Only what is known is set; nothing is inferred.
 */
export interface AIUsageAttribution {
  readonly organizationId: OrganizationId;
  readonly userId?: UserId;
  /** Who acted: the user directly, GIA for the user, the runtime or the system. */
  readonly actor: 'user' | 'gia' | 'runtime' | 'system';
  readonly specialistId?: SpecialistId;
  readonly departmentId?: DepartmentId;
  readonly workflowId?: WorkflowId;
  readonly executionId?: ExecutionId;
  /**
   * The execution this one is a step of (ADR-0102): a plan's planning execution. With it, a
   * multi-step task's usage is its planning call plus every step's.
   */
  readonly parentExecutionId?: ExecutionId;
  /** What the operation was for, e.g. `summarise` or `lead_qualification`. A code, not text. */
  readonly taskType?: string;
  /** The prompt version the call ran with, `id@version` (G-3, ADR-0133). */
  readonly prompt?: string;
  /** The record it was about, e.g. a conversation. */
  readonly subject?: { readonly type: string; readonly id: string };
}

/**
 * One AI operation's usage, emitted by whichever engine served it and read by the usage ledger
 * and, through it, the Financial Backend. Idempotent by `id`.
 */
export interface AIUsageEvent {
  /** Deterministic per operation, so a repeat is the same event. */
  readonly id: string;
  readonly occurredAt: string;
  readonly attribution: AIUsageAttribution;
  readonly capability: AIUsageCapability;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string;
  readonly operation: string;
  readonly outcome: 'completed' | 'failed';
  readonly cost: CostResult;
  /**
   * The customer's credit cost: credits charged for it, when any (the existing credits ledger
   * stays the only charge). Kept apart from `cost`, the provider's cost to MelonOffice.
   */
  readonly credits: number;
  /** The customer credit policy that priced `credits` (ADR-0081), when one did. */
  readonly creditPolicy?: { readonly id: string; readonly version: string };
  /** The model first tried when this one answered as a fallback (`provider:model`). */
  readonly fallbackFrom?: string;
  /** The engine that served it, e.g. `llm_router`. */
  readonly source: string;
  readonly requestId: string;
}

/** What AI usage can be totalled by (ADR-0074). */
export type AIUsageDimension =
  | 'capability'
  | 'provider'
  | 'model'
  | 'operation'
  | 'actor'
  | 'user'
  | 'agent'
  | 'department'
  | 'workflow'
  | 'task_type';

/** The totals of some operations. Amounts in millionths of a US dollar. */
export interface AIUsageBucket {
  readonly operations: number;
  readonly costMicroUsd: number;
  /** Operations whose price was unknown: counted, never given a cost. */
  readonly unpricedOperations: number;
  readonly credits: number;
}

/**
 * The Financial Integration Contract's summary (ADR-0074): AI usage and cost over whole UTC days,
 * for one organization or the whole platform, in total and by every dimension, with each
 * capability's quantities in its own units. The Financial Backend reads this and the events.
 */
export interface AIUsageSummary {
  /** An organization, or `platform` for all of them. */
  readonly scope: OrganizationId | 'platform';
  /** First and last UTC day, `YYYY-MM-DD`, both included. */
  readonly from: string;
  readonly to: string;
  readonly currency: 'USD';
  readonly totals: AIUsageBucket;
  readonly by: Readonly<Record<AIUsageDimension, Readonly<Record<string, AIUsageBucket>>>>;
  /** Per capability, the quantity used of each unit. */
  readonly quantities: Readonly<Record<string, Readonly<Record<string, number>>>>;
}
