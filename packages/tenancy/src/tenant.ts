import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  Membership,
  MembershipId,
  MembershipRole,
  Organization,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { TenancyError } from './errors.js';
import { isOrganizationId } from './ids.js';
import type { CreatedOrganization, TenancyStore } from './store.js';

/**
 * Who is acting and in which organization, for any server-side caller: API routes, MelonMotor,
 * GIA, workflows and jobs. It only exists through `resolveTenant()`, which checks a real, active
 * membership; nothing in it comes from the client except the choice of organization.
 */
export interface TenantContext {
  /** `gia` when GIA acts for the user; it resolves through the same membership, never around it. */
  readonly actor: AuthenticatedContext['actor'];
  readonly userId: UserId;
  readonly organizationId: OrganizationId;
  readonly membershipId: MembershipId;
  /** Always `active`: any other status is refused before a context exists. */
  readonly membershipStatus: 'active';
  /** A name only; what it allows is decided by RBAC, which does not exist yet. */
  readonly role: MembershipRole;
}

/**
 * Places an authenticated caller in an organization. `requested` is only a selector (a path
 * parameter, a header or a job's input); access comes from the caller's own active membership in
 * an active organization. Every refusal is `organization_forbidden`, so ids cannot be probed.
 */
export async function resolveTenant(
  auth: AuthenticatedContext,
  requested: string | undefined,
  store: TenancyStore,
): Promise<TenantContext> {
  if (requested === undefined || requested === '') throw new TenancyError('organization_required');
  if (!isOrganizationId(requested)) throw new TenancyError('organization_forbidden');
  const membership = await store.findMembership(requested, auth.userId);
  if (
    membership === undefined ||
    membership.status !== 'active' ||
    membership.userId !== auth.userId ||
    membership.organizationId !== requested
  ) {
    throw new TenancyError('organization_forbidden');
  }
  const organization = await store.findOrganization(requested);
  if (organization?.status !== 'active') throw new TenancyError('organization_forbidden');
  return Object.freeze({
    actor: auth.actor,
    userId: auth.userId,
    organizationId: organization.id,
    membershipId: membership.id,
    membershipStatus: 'active',
    role: membership.role,
  });
}

export const ORGANIZATION_NAME_MAX_LENGTH = 100;
// Control and invisible formatting characters (e.g. bidi overrides) are never part of a name.
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}]/u;

/** A trimmed, NFC-normalized name of 1 to 100 characters, or `invalid_organization_name`. */
export function parseOrganizationName(value: unknown): string {
  if (typeof value !== 'string') throw new TenancyError('invalid_organization_name');
  const name = value.normalize('NFC').trim();
  const length = [...name].length;
  if (length === 0 || length > ORGANIZATION_NAME_MAX_LENGTH || FORBIDDEN_IN_NAME.test(name)) {
    throw new TenancyError('invalid_organization_name');
  }
  return name;
}

/**
 * Creates an organization with the caller as its active owner. Only a user acting for themselves
 * may do it: GIA cannot create organizations (ADR-0018). The creator is always the authenticated
 * user; nothing in the input can name another one.
 */
export async function createOrganization(
  auth: AuthenticatedContext,
  input: { readonly name: unknown },
  store: TenancyStore,
): Promise<CreatedOrganization> {
  if (auth.actor !== 'user') throw new TenancyError('requires_user');
  const name = parseOrganizationName(input.name);
  return store.createOrganization({ name, creator: auth.userId });
}

export interface MyOrganization {
  readonly organization: Organization;
  readonly membership: Membership;
}

/**
 * The organizations the caller can act in: active memberships in active organizations. Built
 * from the caller's own memberships only, so it can never list someone else's.
 */
export async function listMyOrganizations(
  auth: AuthenticatedContext,
  store: TenancyStore,
): Promise<readonly MyOrganization[]> {
  const memberships = await store.membershipsOfUser(auth.userId);
  const mine: MyOrganization[] = [];
  for (const membership of memberships) {
    if (membership.status !== 'active' || membership.userId !== auth.userId) continue;
    const organization = await store.findOrganization(membership.organizationId);
    if (organization?.status === 'active') mine.push({ organization, membership });
  }
  return mine;
}
