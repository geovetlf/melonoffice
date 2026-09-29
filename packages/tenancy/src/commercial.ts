import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  CommercialAccount,
  CommercialAccountId,
  CommercialAccountStatus,
  CommercialAccountType,
  CommercialMembership,
  CommercialMembershipId,
  CommercialRole,
  CommissionConfig,
  CustomerAccessScope,
  CustomerMode,
  CustomerRelationship,
  CustomerRelationshipId,
  CustomerRelationshipStatus,
  Organization,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';
import { TenancyError } from './errors.js';
import { isOrganizationId } from './ids.js';
import { parseOrganizationName } from './tenant.js';

/**
 * The commercial relationship model (ADR-0085, phase 1): who belongs to which partner or agency,
 * and which customer organizations that account may reach, for which scopes. It decides nothing
 * about permissions (RBAC does, phase 2) and stores nothing (phase 2 adds Firestore). It never
 * changes how an organization is resolved: `resolveTenant()` and the one-organization rule of
 * Direct SaaS stay exactly as they are, and a commercial context is never a tenant context, so it
 * authorizes nothing inside an organization by itself.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const COMMERCIAL_ACCOUNT_TYPES: readonly CommercialAccountType[] = Object.freeze([
  'partner',
  'agency',
]);

export const CUSTOMER_MODES: readonly CustomerMode[] = Object.freeze([
  'direct',
  'reseller',
  'white_label',
  'agency',
  'oem',
  'enterprise',
]);

export const CUSTOMER_ACCESS_SCOPES: readonly CustomerAccessScope[] = Object.freeze([
  'summary',
  'usage',
  'billing',
  'branding',
  'support',
  'knowledge',
  'conversations',
]);

/** Commercial account ids: random and opaque, never derived from a name. */
export const newCommercialAccountId = (): CommercialAccountId =>
  randomUUID() as CommercialAccountId;

/** Whether a client-sent value can be a commercial account id at all. It grants nothing. */
export const isCommercialAccountId = (value: unknown): value is CommercialAccountId =>
  typeof value === 'string' && UUID.test(value);

/** One membership per user and account: the id is derived from the pair. */
export const commercialMembershipIdOf = (
  accountId: CommercialAccountId,
  userId: UserId,
): CommercialMembershipId => `${accountId}_${userId}` as CommercialMembershipId;

/** One relationship per account and customer: the id is derived from the pair. */
export const customerRelationshipIdOf = (
  accountId: CommercialAccountId,
  organizationId: OrganizationId,
): CustomerRelationshipId => `${accountId}_${organizationId}` as CustomerRelationshipId;

export const isCommercialAccountType = (value: unknown): value is CommercialAccountType =>
  (COMMERCIAL_ACCOUNT_TYPES as readonly unknown[]).includes(value);

export const isCustomerMode = (value: unknown): value is CustomerMode =>
  (CUSTOMER_MODES as readonly unknown[]).includes(value);

/** A commercial account's name follows the same rules as an organization's. */
export function parseCommercialAccountName(value: unknown): string {
  try {
    return parseOrganizationName(value);
  } catch {
    throw new TenancyError('invalid_commercial_account_name');
  }
}

/**
 * The scopes a relationship grants: known, without repeats, in catalogue order. An empty list is
 * valid and grants nothing beyond knowing the relationship exists.
 */
export function parseCustomerScopes(value: unknown): readonly CustomerAccessScope[] {
  if (!Array.isArray(value)) throw new TenancyError('invalid_customer_scopes');
  if (value.some((s) => !(CUSTOMER_ACCESS_SCOPES as readonly unknown[]).includes(s))) {
    throw new TenancyError('invalid_customer_scopes');
  }
  return Object.freeze(CUSTOMER_ACCESS_SCOPES.filter((s) => value.includes(s)));
}

const COMMISSION_MODELS = ['wholesale', 'commission', 'revenue_share'] as const;
const AGREEMENT_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A commission configuration, as given by whoever configures the account. There is no default
 * value anywhere: an account without one has no commission. Whole basis points, 0 to 10,000.
 */
export function parseCommissionConfig(value: unknown): CommissionConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TenancyError('invalid_commission');
  }
  const { model, basisPoints, agreementRef } = value as Record<string, unknown>;
  if (!(COMMISSION_MODELS as readonly unknown[]).includes(model)) {
    throw new TenancyError('invalid_commission');
  }
  if (
    typeof basisPoints !== 'number' ||
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10_000
  ) {
    throw new TenancyError('invalid_commission');
  }
  if (
    agreementRef !== undefined &&
    (typeof agreementRef !== 'string' || !AGREEMENT_REF.test(agreementRef))
  ) {
    throw new TenancyError('invalid_commission');
  }
  return Object.freeze({
    model: model as CommissionConfig['model'],
    basisPoints,
    ...(agreementRef === undefined ? {} : { agreementRef: agreementRef as string }),
  });
}

const ACCOUNT_TRANSITIONS: Readonly<
  Record<CommercialAccountStatus, readonly CommercialAccountStatus[]>
> = { active: ['suspended', 'closed'], suspended: ['active', 'closed'], closed: [] };

const RELATIONSHIP_TRANSITIONS: Readonly<
  Record<CustomerRelationshipStatus, readonly CustomerRelationshipStatus[]>
> = {
  pending: ['active', 'ended'],
  active: ['suspended', 'ended'],
  suspended: ['active', 'ended'],
  ended: [],
};

/** Whether an account may move between these statuses. Closed is final. */
export const canChangeAccountStatus = (
  from: CommercialAccountStatus,
  to: CommercialAccountStatus,
): boolean => ACCOUNT_TRANSITIONS[from].includes(to);

/** Whether a relationship may move between these statuses. Ended is final. */
export const canChangeRelationshipStatus = (
  from: CustomerRelationshipStatus,
  to: CustomerRelationshipStatus,
): boolean => RELATIONSHIP_TRANSITIONS[from].includes(to);

/**
 * Where commercial accounts, their memberships and their customer relationships are read from.
 * It finds; access decisions are made by `resolveCommercialContext()` and `customerAccessOf()`.
 * Phase 2 adds the Firestore store.
 */
export interface CommercialStore {
  findAccount(id: CommercialAccountId): Promise<CommercialAccount | undefined>;
  /** The membership of this user in this account, in any status. */
  findMembership(
    accountId: CommercialAccountId,
    userId: UserId,
  ): Promise<CommercialMembership | undefined>;
  /** Every commercial membership of the user, in any status. */
  membershipsOfUser(userId: UserId): Promise<readonly CommercialMembership[]>;
  /** The relationship between this account and this organization, in any status. */
  findRelationship(
    accountId: CommercialAccountId,
    organizationId: OrganizationId,
  ): Promise<CustomerRelationship | undefined>;
  /** Every relationship of the account, in any status. */
  relationshipsOfAccount(accountId: CommercialAccountId): Promise<readonly CustomerRelationship[]>;
}

/**
 * Who acts, in which commercial account. It exists only through `resolveCommercialContext()`,
 * which checks an active membership in an active account. It is not a `TenantContext`: RBAC
 * refuses it inside any organization, so it reaches customers only through `customerAccessOf()`.
 */
export interface CommercialContext {
  readonly userId: UserId;
  readonly commercialAccountId: CommercialAccountId;
  readonly accountType: CommercialAccountType;
  readonly membershipId: CommercialMembershipId;
  readonly membershipStatus: 'active';
  /** A name only; what it allows is RBAC's decision (phase 2). */
  readonly role: CommercialRole;
}

const issued = new WeakSet<CommercialContext>();

/** Whether this exact object came from `resolveCommercialContext()`. A copy never passes. */
export const isResolvedCommercialContext = (context: CommercialContext): boolean =>
  issued.has(context);

/**
 * Places an authenticated person in a commercial account. `requested` is only a selector; access
 * comes from their own active membership in an active account. Only a person acting for
 * themselves: GIA and the runtime have no commercial path. Every refusal is
 * `commercial_account_forbidden`, so ids cannot be probed.
 */
export async function resolveCommercialContext(
  auth: AuthenticatedContext,
  requested: string | undefined,
  store: CommercialStore,
): Promise<CommercialContext> {
  if (auth.actor !== 'user') throw new TenancyError('commercial_account_forbidden');
  if (!isCommercialAccountId(requested)) throw new TenancyError('commercial_account_forbidden');
  const membership = await store.findMembership(requested, auth.userId);
  if (
    membership === undefined ||
    membership.status !== 'active' ||
    membership.userId !== auth.userId ||
    membership.commercialAccountId !== requested
  ) {
    throw new TenancyError('commercial_account_forbidden');
  }
  const account = await store.findAccount(requested);
  if (account?.status !== 'active' || account.id !== requested) {
    throw new TenancyError('commercial_account_forbidden');
  }
  const context: CommercialContext = Object.freeze({
    userId: auth.userId,
    commercialAccountId: account.id,
    accountType: account.type,
    membershipId: membership.id,
    membershipStatus: 'active',
    role: membership.role,
  });
  issued.add(context);
  return context;
}

/** What a commercial account may reach in one customer: that relationship and its scopes. */
export interface CustomerAccess {
  readonly commercialAccountId: CommercialAccountId;
  readonly organizationId: OrganizationId;
  readonly relationshipId: CustomerRelationshipId;
  readonly mode: CustomerMode;
  readonly scopes: ReadonlySet<CustomerAccessScope>;
}

/**
 * Whether a resolved commercial context may reach this customer, and for which scopes. It needs an
 * active relationship between that exact account and that exact organization, and an active
 * organization. Every refusal is `customer_forbidden`: an organization that does not exist, one
 * related to another account, a pending, suspended or ended relationship, and a suspended
 * organization all look the same.
 */
export async function customerAccessOf(
  context: CommercialContext,
  organizationId: string,
  store: CommercialStore,
  organizations: { findOrganization(id: OrganizationId): Promise<Organization | undefined> },
): Promise<CustomerAccess> {
  if (!isResolvedCommercialContext(context)) throw new TenancyError('customer_forbidden');
  if (!isOrganizationId(organizationId)) throw new TenancyError('customer_forbidden');
  const relationship = await store.findRelationship(context.commercialAccountId, organizationId);
  if (
    relationship === undefined ||
    relationship.status !== 'active' ||
    relationship.commercialAccountId !== context.commercialAccountId ||
    relationship.organizationId !== organizationId
  ) {
    throw new TenancyError('customer_forbidden');
  }
  const organization = await organizations.findOrganization(organizationId);
  if (organization?.status !== 'active') throw new TenancyError('customer_forbidden');
  return Object.freeze({
    commercialAccountId: context.commercialAccountId,
    organizationId: organization.id,
    relationshipId: relationship.id,
    mode: relationship.mode,
    scopes: new Set(parseCustomerScopes(relationship.scopes)),
  });
}

/**
 * The customers a commercial context may list: active relationships of its own account with
 * active organizations. Built from the account's own relationships only.
 */
export async function listCustomersOf(
  context: CommercialContext,
  store: CommercialStore,
  organizations: { findOrganization(id: OrganizationId): Promise<Organization | undefined> },
): Promise<readonly CustomerAccess[]> {
  if (!isResolvedCommercialContext(context)) throw new TenancyError('commercial_account_forbidden');
  const customers: CustomerAccess[] = [];
  for (const relationship of await store.relationshipsOfAccount(context.commercialAccountId)) {
    if (relationship.commercialAccountId !== context.commercialAccountId) continue;
    try {
      customers.push(
        await customerAccessOf(context, relationship.organizationId, store, organizations),
      );
    } catch {
      // Not active, or the organization is not: not listed.
    }
  }
  return customers;
}
