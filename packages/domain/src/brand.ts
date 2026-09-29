import type { CommercialAccountId } from './commercial.js';
import type { IsoTimestamp, OrganizationId, UserId } from './ids.js';

/**
 * How the product presents itself (ADR-0087). One brand configuration per level, and the levels
 * apply in this order, each one filling or replacing what the one before it set:
 *
 * 1. platform: MelonOffice's own, in code;
 * 2. commercial account: a partner's own brand, applied to its white-label customers;
 * 3. customer: the organization's own, written by its owner;
 * 4. white label: what a partner sets for one white-label customer, only with its `branding` scope.
 *
 * Every field is optional: a level sets only what it wants to change. "MelonOffice" stays the
 * technical identity (package names, audit source, platform views) whatever the brand says.
 */
export interface BrandConfig {
  readonly brandName?: string;
  readonly productName?: string;
  /** What the assistant is called (GIA on the platform). */
  readonly assistantName?: string;
  /** What agents are called, e.g. "Specialist" and "Specialists". */
  readonly agentNaming?: { readonly singular: string; readonly plural: string };
  /** An https address of an image; uploads come later. */
  readonly logoUrl?: string;
  readonly faviconUrl?: string;
  /** `#rrggbb`. */
  readonly primaryColor?: string;
  readonly secondaryColor?: string;
  readonly login?: { readonly title?: string; readonly message?: string };
  readonly email?: { readonly senderName?: string; readonly footer?: string };
  readonly notifications?: { readonly senderName?: string };
  readonly supportContact?: {
    readonly email?: string;
    readonly phone?: string;
    readonly url?: string;
  };
  /** The customer's own facts: only the customer's level sets them. */
  readonly company?: {
    readonly legalName?: string;
    readonly address?: string;
    readonly website?: string;
  };
  readonly links?: { readonly legal?: string; readonly privacy?: string; readonly terms?: string };
  /** A language the product has (`en`, `es`). */
  readonly defaultLanguage?: string;
  /** IANA time zone; the customer's own. */
  readonly timeZone?: string;
  /** ISO 4217; the customer's own. */
  readonly currency?: string;
  /** ISO 3166-1 alpha-2; the customer's own. */
  readonly country?: string;
}

/** The levels that are stored; the platform's is code. */
export type BrandLevel = 'commercial_account' | 'organization' | 'white_label';

/** Whose brand configuration it is. Each level is written only by its owner. */
export type BrandOwner =
  | { readonly level: 'commercial_account'; readonly commercialAccountId: CommercialAccountId }
  | { readonly level: 'organization'; readonly organizationId: OrganizationId }
  | {
      readonly level: 'white_label';
      readonly commercialAccountId: CommercialAccountId;
      readonly organizationId: OrganizationId;
    };

/** A stored brand configuration: one per owner, id derived from it. */
export interface BrandConfigRecord {
  readonly id: string;
  readonly owner: BrandOwner;
  readonly config: BrandConfig;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly updatedBy: UserId;
}

/**
 * A domain's state (ADR-0087). Only `active` resolves.
 *
 * - `pending_verification`: registered; nobody has shown it controls the domain yet.
 * - `verified`: shown to be controlled by its owner; not serving yet.
 * - `active`: resolves to its target.
 * - `disabled`: resolves to nothing. It can be verified again.
 */
export type DomainBindingStatus = 'pending_verification' | 'verified' | 'active' | 'disabled';

/** What a domain resolves to: a commercial account or one organization, never chosen by a client. */
export type DomainTarget =
  | { readonly type: 'commercial_account'; readonly commercialAccountId: CommercialAccountId }
  | { readonly type: 'organization'; readonly organizationId: OrganizationId };

/**
 * A hostname bound to a target (ADR-0087), e.g. `partner.melonoffice.com` or `app.customer.com`.
 * One per hostname: the id is the hostname. The brand it shows is its target's.
 */
export interface DomainBinding {
  readonly hostname: string;
  readonly target: DomainTarget;
  readonly status: DomainBindingStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly createdBy: UserId;
}
