import type { ContactId } from './conversation.js';
import type { Brand, IsoTimestamp, MessageKey, OrganizationId, UserId } from './ids.js';

/**
 * Opportunities and the sales pipeline (C2, ADR-0054). An opportunity is a possible sale to one
 * contact (the C1 contact, never a copy). It moves through the organization's own stages and
 * ends won or lost; "lost" belongs to the opportunity, never to the contact.
 */

export type OpportunityId = Brand<string, 'OpportunityId'>;
export type PipelineId = Brand<string, 'PipelineId'>;

/** An open stage is a step of the sale; `won` and `lost` end it. */
export type PipelineStageKind = 'open' | 'won' | 'lost';

export interface PipelineStage {
  /** Stable within the pipeline: what opportunities and the audit trail refer to. */
  readonly id: string;
  readonly kind: PipelineStageKind;
  /** A template stage's message key (EN/ES), until a person names it. */
  readonly nameKey?: MessageKey;
  /** The name a person gave it. */
  readonly name?: string;
  /** The default chance of closing, 0 to 100, for an opportunity at this stage. */
  readonly probability: number;
}

/**
 * An organization's pipeline: its open stages in order, then exactly one `won` and one `lost`.
 * Proposed from a template for the business's kind; stored once the organization accepts it.
 */
export interface Pipeline {
  readonly id: PipelineId;
  readonly organizationId: OrganizationId;
  readonly stages: readonly PipelineStage[];
  /** The template it started from (a business type id, or `general`). */
  readonly template: string;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export type OpportunityStatus = 'open' | 'won' | 'lost';

/** Why an opportunity was lost, as a code: countable, never free text in the audit trail. */
export type LostReason = 'price' | 'timing' | 'competitor' | 'no_response' | 'not_a_fit' | 'other';

/** An amount in minor units (céntimos) with its ISO currency: never a float. */
export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

export interface Opportunity {
  readonly id: OpportunityId;
  readonly organizationId: OrganizationId;
  readonly contactId: ContactId;
  readonly pipelineId: PipelineId;
  readonly stageId: string;
  /** Follows the stage's kind. */
  readonly status: OpportunityStatus;
  readonly title: string;
  readonly value?: Money;
  /** 0 to 100: the stage's default unless a person set it. Won is 100 and lost is 0. */
  readonly probability: number;
  /** A member responsible for it. */
  readonly ownerId?: UserId;
  /** When it is expected to close (a date in the business's time zone). */
  readonly expectedCloseOn?: string;
  readonly nextAction?: { readonly text: string; readonly dueOn: string };
  readonly lostReason?: LostReason;
  readonly closedAt?: IsoTimestamp;
  readonly stageChangedAt: IsoTimestamp;
  readonly revision: number;
  readonly createdBy: UserId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
