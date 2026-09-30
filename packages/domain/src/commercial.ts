import type { Brand, IsoTimestamp, OrganizationId, UserId } from './ids.js';

/**
 * The commercial layer above organizations (ADR-0085). A partner or an agency is a commercial
 * account: it is never an organization and never a tenant. Organizations stay the operating
 * tenant (their data, members, billing, credits and agents). A commercial account reaches an
 * organization only through an explicit customer relationship, and only for the scopes that
 * relationship grants: knowing an organization's id grants nothing.
 *
 * Every commercial field is optional for an organization: a Direct SaaS organization has no
 * relationship at all and works exactly as before.
 */

export type CommercialAccountId = Brand<string, 'CommercialAccountId'>;
export type CommercialMembershipId = Brand<string, 'CommercialMembershipId'>;
export type CustomerRelationshipId = Brand<string, 'CustomerRelationshipId'>;
export type CustomerInvitationId = Brand<string, 'CustomerInvitationId'>;

/**
 * - `partner`: sells MelonOffice to its customers (reseller, white label, OEM).
 * - `agency`: operates MelonOffice for its customers (managed AI).
 */
export type CommercialAccountType = 'partner' | 'agency';

/**
 * - `active`: its members can act for its related customers, within the relationships' scopes.
 * - `suspended`: nobody can act through it until reactivated; its customers keep working.
 * - `closed`: ended; kept for history.
 */
export type CommercialAccountStatus = 'active' | 'suspended' | 'closed';

/**
 * A reference to one exact version of a pricing profile. The profile itself (retail, wholesale,
 * reseller or custom enterprise pricing on top of the existing plans and credits) is data that
 * does not exist yet: no price or percentage lives in code.
 */
export interface PricingProfileRef {
  readonly id: string;
  readonly version: number;
}

/**
 * How a partner is paid, as configuration. There is no default and no constant: an account
 * without one has no commission. Amounts are whole basis points (1 = 0.01%), so no float rounds.
 *
 * - `wholesale`: the partner buys at a discount on the retail price and sets its own price.
 * - `commission`: MelonOffice charges the customer and pays the partner a share.
 * - `revenue_share`: an allocation of what MelonOffice collects, split by the configuration.
 *
 * It describes an allocation only. Money still moves through billing, and credits through the
 * existing ledger: this is never a second financial core.
 */
export interface CommissionConfig {
  readonly model: 'wholesale' | 'commission' | 'revenue_share';
  readonly basisPoints: number;
  /** A reference to the agreement it comes from, never its text. */
  readonly agreementRef?: string;
}

/**
 * What an account may hold, as configuration. Absent means no limit set yet, which the
 * authorization layer reads as "not allowed" for anything that needs one.
 */
export interface CommercialLimits {
  readonly customers?: number;
  readonly members?: number;
}

/** A partner or an agency. */
export interface CommercialAccount {
  readonly id: CommercialAccountId;
  readonly type: CommercialAccountType;
  readonly name: string;
  readonly status: CommercialAccountStatus;
  readonly pricingProfile?: PricingProfileRef;
  readonly commission?: CommissionConfig;
  readonly limits?: CommercialLimits;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * A role in a commercial account, as a name only. What it may do is decided by RBAC, as for
 * organization roles (ADR-0019); an unknown name grants nothing. Known names today:
 * `partner.admin`, `partner.support`, `agency.admin`, `agency.manager`.
 */
export type CommercialRole = string;

/** Only `active` grants anything, as for organization memberships. */
export type CommercialMembershipStatus = 'active' | 'suspended' | 'revoked';

/** The explicit link between one user and one commercial account. At most one per pair. */
export interface CommercialMembership {
  readonly id: CommercialMembershipId;
  readonly commercialAccountId: CommercialAccountId;
  readonly userId: UserId;
  readonly role: CommercialRole;
  readonly status: CommercialMembershipStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * How MelonOffice reaches the customer. A delivery mode, never a separate product.
 *
 * - `direct`: MelonOffice sells directly; a relationship with this mode is only a referral.
 * - `reseller`: a partner sells MelonOffice under the MelonOffice brand.
 * - `white_label`: a partner sells it under its own brand.
 * - `agency`: an agency operates it for the customer.
 * - `oem`: embedded in a partner's product through the API.
 * - `enterprise`: a private or dedicated deployment.
 */
export type CustomerMode = 'direct' | 'reseller' | 'white_label' | 'agency' | 'oem' | 'enterprise';

/**
 * - `pending`: proposed; grants nothing until the customer's owner accepts it.
 * - `active`: in force, for its scopes only.
 * - `suspended`: temporarily grants nothing.
 * - `ended`: over; kept for history.
 */
export type CustomerRelationshipStatus = 'pending' | 'active' | 'suspended' | 'ended';

/**
 * What a commercial account may see or do in a related customer, each granted explicitly. None
 * is granted by default: without a scope, the account sees only that the relationship exists.
 * Company memory (Company Brain) and conversations are separate scopes, so a partner never
 * reads a customer's memory or private conversations unless the customer granted exactly that.
 *
 * - `summary`: the organization's name, status, plan and subscription status.
 * - `usage`: credits and AI usage by capability, never provider, model or internal cost.
 * - `billing`: the billing relationship the account is authorized for.
 * - `branding`: the customer's brand configuration, when the mode is white label.
 * - `support`: open the customer's workspace for support, as the customer's members allow.
 * - `knowledge`: read the customer's company memory.
 * - `conversations`: read the customer's conversations.
 */
export type CustomerAccessScope =
  'summary' | 'usage' | 'billing' | 'branding' | 'support' | 'knowledge' | 'conversations';

/**
 * Who is billed for the customer. The customer's billing account and credit wallet stay the
 * organization's own (ADR-0022, ADR-0023): consumption always belongs to the customer.
 *
 * - `customer`: MelonOffice bills the customer.
 * - `commercial_account`: the partner or agency is billed and bills the customer itself.
 */
export type BillingRelationship = 'customer' | 'commercial_account';

/**
 * The explicit link between one commercial account and one customer organization. At most one
 * per pair, so a partner cannot hold two relationships with different scopes for the same
 * customer.
 */
export interface CustomerRelationship {
  readonly id: CustomerRelationshipId;
  readonly commercialAccountId: CommercialAccountId;
  readonly organizationId: OrganizationId;
  readonly mode: CustomerMode;
  readonly status: CustomerRelationshipStatus;
  readonly scopes: readonly CustomerAccessScope[];
  readonly billing?: BillingRelationship;
  /** Who accepted it for the customer: an owner of the organization. Absent while pending. */
  readonly acceptedBy?: UserId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * - `pending`: sent; grants nothing. Only the invited person can take it, until it expires.
 * - `accepted`: the invited person took it for their organization. The relationship it created is
 *   active when they could decide for it, or pending for their owner otherwise.
 * - `rejected`: the invited person declined it.
 * - `revoked`: the partner or agency withdrew it before it was taken.
 * - `expired`: nobody took it in time.
 *
 * Only `pending` changes, and only once.
 */
export type CustomerInvitationStatus = 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';

/**
 * An invitation by email to become a partner's or agency's customer (ADR-0089). It names a
 * person, never an organization: the organization is the one the invited person belongs to when
 * they accept, resolved by the server. It grants nothing by itself: the scopes are only what the
 * partner asks for, and an owner grants exactly the ones they tick, none by default.
 *
 * The secret the link carries is never stored: only its SHA-256 hash.
 */
export interface CustomerInvitation {
  readonly id: CustomerInvitationId;
  readonly commercialAccountId: CommercialAccountId;
  /** The invited email, trimmed and lowercased. */
  readonly email: string;
  readonly mode: CustomerMode;
  /** The scopes asked for. Never granted without the owner ticking them. */
  readonly scopes: readonly CustomerAccessScope[];
  readonly billing?: BillingRelationship;
  readonly status: CustomerInvitationStatus;
  /** Hex SHA-256 of the link's secret. */
  readonly tokenHash: string;
  readonly expiresAt: IsoTimestamp;
  readonly createdBy: UserId;
  /** Who accepted or rejected it, and for which organization when accepted. */
  readonly decidedBy?: UserId;
  readonly organizationId?: OrganizationId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}
