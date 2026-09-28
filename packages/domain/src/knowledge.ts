import type { IsoTimestamp, OrganizationId, UserId } from './ids.js';

/**
 * Company Brain (ADR-0051): what an organization knows about itself, as items of knowledge, each
 * with where it came from, how sure it is and its whole history. It is the `company` kind of
 * context (ADR-0029), kept apart from a user's own profile and from conversation or execution
 * memory.
 */

/** The areas of company knowledge. Data, not code paths: nothing assumes only these exist. */
export type KnowledgeDomain =
  | 'identity'
  | 'business_model'
  | 'products'
  | 'customers'
  | 'commercial'
  | 'marketing'
  | 'brand'
  | 'operations'
  | 'finance'
  | 'team'
  | 'policies'
  | 'goals'
  | 'documents'
  | 'integrations'
  | 'decisions';

/** Where a piece of knowledge came from. */
export type KnowledgeSourceType =
  | 'user'
  | 'gia'
  | 'document'
  | 'crm'
  | 'integration'
  | 'agent'
  | 'workflow'
  | 'analytics'
  | 'system'
  | 'import';

/**
 * How far it can be trusted. `confirmed` only ever comes from a person acting directly; an AI
 * inference is `proposed` until that person confirms it.
 */
export type KnowledgeVerification =
  'proposed' | 'unverified' | 'confirmed' | 'calculated' | 'imported';

/** Whether it is in force: `outdated` was true once (history), `archived` is set aside. */
export type KnowledgeStatus = 'active' | 'outdated' | 'archived';

/** Who may see it: `restricted` (costs, margins, legal ids) needs its own permission. */
export type KnowledgeSensitivity = 'internal' | 'confidential' | 'restricted';

/** A typed value. Money is in minor units (céntimos), never a float. */
export type KnowledgeValue =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'number'; readonly number: number; readonly unit?: string }
  | { readonly type: 'money'; readonly amountMinor: number; readonly currency: string }
  | { readonly type: 'boolean'; readonly value: boolean }
  | { readonly type: 'list'; readonly items: readonly string[] }
  | { readonly type: 'date'; readonly date: string };

export type KnowledgeSubjectType =
  | 'product'
  | 'service'
  | 'segment'
  | 'campaign'
  | 'location'
  | 'supplier'
  | 'process'
  | 'policy'
  | 'goal'
  | 'decision'
  | 'channel'
  | 'competitor'
  | 'document';

/** What an item is about when it is not the company itself: one product, one campaign… */
export interface KnowledgeSubject {
  readonly type: KnowledgeSubjectType;
  /** A stable slug, e.g. `combo_familiar`. */
  readonly id: string;
}

export type KnowledgeRelationType =
  'belongs_to' | 'used_in' | 'targets' | 'has_price' | 'part_of' | 'related_to';

export interface KnowledgeRelation {
  readonly type: KnowledgeRelationType;
  readonly to: KnowledgeSubject;
}

/** Who recorded it, as the audit trail names actors: never another organization's id. */
export type KnowledgeRecorder =
  | { readonly type: 'user'; readonly userId: UserId; readonly via: 'direct' | 'gia' }
  | { readonly type: 'runtime'; readonly initiatedBy: UserId }
  | { readonly type: 'system' };

export interface KnowledgeProvenance {
  readonly sourceType: KnowledgeSourceType;
  /** The source record: a document, a connection, an execution, `business_profile`… */
  readonly sourceId?: string;
  /** A readable pointer into the source, e.g. `business_profile:{org}@3`. */
  readonly sourceReference?: string;
  readonly recordedBy: KnowledgeRecorder;
  /** 0 to 1, when the source gives one (an extraction does; a person does not). */
  readonly confidence?: number;
}

export interface KnowledgeItem {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly domain: KnowledgeDomain;
  /** What is known, e.g. `price`, `tone_of_voice`, `main_product`. */
  readonly key: string;
  readonly subject?: KnowledgeSubject;
  /** The subject's name as people say it, e.g. "Combo Familiar". */
  readonly label?: string;
  readonly value: KnowledgeValue;
  readonly verification: KnowledgeVerification;
  readonly status: KnowledgeStatus;
  readonly sensitivity: KnowledgeSensitivity;
  /** A person must confirm it before it counts as confirmed (legal, prices, policies…). */
  readonly critical: boolean;
  readonly provenance: KnowledgeProvenance;
  readonly relations: readonly KnowledgeRelation[];
  readonly effectiveFrom: IsoTimestamp;
  readonly effectiveUntil?: IsoTimestamp;
  /** From 1; each change is a new revision and leaves a version behind. */
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** Set while another source says something different and no one has decided. */
  readonly openConflictId?: string;
}

export type KnowledgeOperation =
  | 'created'
  | 'updated'
  | 'merged'
  | 'confirmed'
  | 'invalidated'
  | 'archived'
  | 'conflict_detected'
  | 'conflict_resolved';

/** One revision of an item, as it was: the previous price stays known after it changes. */
export interface KnowledgeVersion {
  readonly organizationId: OrganizationId;
  readonly itemId: string;
  readonly revision: number;
  readonly operation: KnowledgeOperation;
  readonly value: KnowledgeValue;
  readonly verification: KnowledgeVerification;
  readonly status: KnowledgeStatus;
  readonly provenance: KnowledgeProvenance;
  readonly effectiveFrom: IsoTimestamp;
  readonly effectiveUntil?: IsoTimestamp;
  readonly changedAt: IsoTimestamp;
  readonly changedBy: KnowledgeRecorder;
  /** A stable code, e.g. `price_changed`, when one was given. */
  readonly reason?: string;
}

/** What one side of a conflict said, and who said it. */
export interface KnowledgeClaim {
  readonly value: KnowledgeValue;
  readonly verification: KnowledgeVerification;
  readonly provenance: KnowledgeProvenance;
}

/** Two sources disagree; nothing is chosen silently. */
export interface KnowledgeConflict {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly itemId: string;
  readonly domain: KnowledgeDomain;
  readonly key: string;
  readonly subject?: KnowledgeSubject;
  readonly label?: string;
  /** The item's revision when the conflict was found. */
  readonly revision: number;
  readonly current: KnowledgeClaim;
  readonly candidate: KnowledgeClaim;
  readonly status: 'open' | 'resolved';
  /** `replaced`: a person set a third value instead of either. */
  readonly resolution?: 'kept_current' | 'took_candidate' | 'replaced';
  readonly resolvedBy?: UserId;
  readonly resolvedAt?: IsoTimestamp;
  readonly createdAt: IsoTimestamp;
}

/** A document given to Company Brain: kept as received, its facts extracted as `unverified`. */
export interface KnowledgeDocument {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly name: string;
  /** SHA-256 of the text: the same document twice is the same document. */
  readonly sha256: string;
  readonly characters: number;
  readonly text: string;
  readonly status: 'stored' | 'extracted' | 'extraction_failed';
  /** How many facts extraction proposed. */
  readonly facts: number;
  readonly createdBy: UserId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
