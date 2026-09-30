import {
  actorOf,
  buildAuditEvent,
  type AuditEventInput,
  type AuditService,
} from '@melonoffice/audit';
import { isAIUsageError, type AIUsageLedger } from '@melonoffice/ai-usage';
import type { UserDirectory } from '@melonoffice/auth';
import type { BillingService } from '@melonoffice/billing';
import type {
  BillingRelationship,
  CommercialAccount,
  CommercialLimits,
  CommercialAccountId,
  CommercialMembership,
  CustomerRelationship,
  IsoTimestamp,
  OrganizationId,
  PlanRef,
  UserId,
} from '@melonoffice/domain';
import {
  isCommercialRoleName,
  type AuthorizationService,
  type CommercialAuthorization,
  type Permission,
} from '@melonoffice/rbac';
import {
  canChangeAccountStatus,
  canChangeRelationshipStatus,
  commercialMembershipIdOf,
  customerAccessOf,
  customerRelationshipIdOf,
  isCommercialAccountType,
  customerModesOf,
  parentAllows,
  isCustomerMode,
  isOrganizationId,
  isTenancyError,
  listCustomersOf,
  newCommercialAccountId,
  parseCommercialAccountName,
  parseCustomerScopes,
  parseRequestedCustomerScopes,
  resolveCommercialContext,
  TenancyError,
  type CommercialContext,
  type CustomerAccess,
  type CommercialRepository,
  type PlatformAdminContext,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { recordOutcome, requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';
import { withPermission } from './authorization.js';
import { platformAdminOf } from './platform-admin.js';

/**
 * The commercial layer's routes (ADR-0086), over ADR-0085's model:
 *
 * - `/v1/platform/commercial-accounts`: the platform administrator creates partner and agency
 *   accounts and names their first admin (Geovet's decision "Solo plataforma").
 * - `/v1/commercial/accounts/:accountId/...`: a partner's or agency's people run their account and
 *   invite customers, with `COMMERCIAL_ROLES` ("Admin y soporte").
 * - `/v1/organizations/:organizationId/commercial-relationships/...`: the organization's owner
 *   accepts, narrows or ends each relationship. Nothing is reachable before they accept.
 *
 * Every write is audited in the same step as its data. Every refusal answers one code, so ids
 * cannot be probed. GIA and the runtime have no commercial path.
 */

export interface CommercialDependencies {
  readonly commercial: CommercialRepository;
  readonly organizations: TenancyStore;
  /** The platform administrators' user ids (ADR-0082). */
  readonly admins: ReadonlySet<string>;
  readonly authorization: AuthorizationService;
  readonly commercialAuthorization: CommercialAuthorization;
  readonly audit: AuditService;
  /** Who has signed in, so only a real user is added to an account (ADR-0091). */
  readonly users?: Pick<UserDirectory, 'findById'>;
  /** The plan in force, for a customer's summary. Absent: the summary says `null`. */
  readonly currentPlan?: (organizationId: OrganizationId) => Promise<PlanRef | undefined>;
  /** A customer's subscription, for its `billing` scope (ADR-0088). Absent: `null`. */
  readonly subscriptionOf?: BillingService['subscriptionOf'];
  /** The one AI usage ledger, for a customer's `usage` scope (ADR-0088). Absent: 503. */
  readonly usage?: Pick<AIUsageLedger, 'summary'>;
  readonly now?: () => Date;
}

const STATUS: Partial<Record<string, ContentfulStatusCode>> = {
  commercial_account_forbidden: 403,
  customer_forbidden: 403,
  commercial_conflict: 409,
  commercial_limit_reached: 409,
  invalid_commercial_account_name: 400,
  invalid_customer_scopes: 400,
};

const LIMIT_MAX = 100_000;
const isLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= LIMIT_MAX;
/**
 * An account's limits as sent: customers and members for every kind, and resellers for a white
 * label (ADR-0098). `undefined` when any is missing or out of range.
 */
export function parseAccountLimits(
  type: CommercialAccount['type'],
  value: unknown,
): CommercialLimits | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const limits = value as Record<string, unknown>;
  if (!isLimit(limits.customers) || !isLimit(limits.members) || limits.members < 1) {
    return undefined;
  }
  if (type !== 'white_label') return { customers: limits.customers, members: limits.members };
  if (!isLimit(limits.resellers)) return undefined;
  return { customers: limits.customers, members: limits.members, resellers: limits.resellers };
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const bad = (c: Context<AuthEnv>, field: string) =>
  c.json({ error: 'invalid_commercial_request', field }, 400);

const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const value: unknown = await c.req.json().catch(() => undefined);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

export const accountView = (a: CommercialAccount) => ({
  id: a.id,
  type: a.type,
  name: a.name,
  status: a.status,
  limits: a.limits ?? null,
  // The white label a reseller belongs to (ADR-0098).
  parentAccountId: a.parentAccountId ?? null,
  // The version a platform change names (ADR-0091).
  updatedAt: a.updatedAt,
});

const memberView = (m: CommercialMembership) => ({
  userId: m.userId,
  role: m.role,
  status: m.status,
  updatedAt: m.updatedAt,
});

const relationshipView = (r: CustomerRelationship) => ({
  commercialAccountId: r.commercialAccountId,
  organizationId: r.organizationId,
  mode: r.mode,
  status: r.status,
  scopes: r.scopes,
  billing: r.billing ?? null,
  updatedAt: r.updatedAt,
});

/**
 * The guard every route inside a partner's or agency's account goes through (ADR-0086), shared by
 * the commercial and branding routes.
 */
export function createCommercialGuard({
  commercial,
  audit,
  commercialAuthorization,
}: Pick<CommercialDependencies, 'commercial' | 'audit' | 'commercialAuthorization'>) {
  /** Runs a write whose events it builds; tenancy's codes answer as themselves. */
  const guarded = async (c: Context<AuthEnv>, work: () => Promise<Response>): Promise<Response> => {
    try {
      return await work();
    } catch (error) {
      if (isTenancyError(error)) {
        return c.json({ error: error.code }, STATUS[error.code] ?? 400);
      }
      throw error;
    }
  };

  /**
   * Resolves the caller in the account of the path and checks the permission. Every refusal is
   * `commercial_account_forbidden` (not a member, inactive, unknown account) or
   * `permission_denied` (a member whose role does not allow it), both audited.
   */
  const inAccount =
    (
      permission: Permission,
      handler: (c: Context<AuthEnv>, context: CommercialContext) => Promise<Response>,
    ) =>
    async (c: Context<AuthEnv>) => {
      const auth = c.get('auth');
      let context: CommercialContext;
      try {
        context = await resolveCommercialContext(auth, c.req.param('accountId'), commercial);
      } catch (error) {
        if (!isTenancyError(error)) throw error;
        await recordOutcome(c, audit, {
          action: 'commercial.access',
          result: 'denied',
          actor: actorOf(auth),
          permission,
          reason: error.code,
          ...requestFields(c),
        });
        return c.json({ error: error.code }, 403);
      }
      const decision = commercialAuthorization.authorize(context, permission);
      if (!decision.allowed) {
        await recordOutcome(c, audit, {
          action: 'commercial.access',
          result: 'denied',
          actor: actorOf(auth),
          commercialAccountId: context.commercialAccountId,
          permission,
          reason: decision.reason,
          ...requestFields(c),
        });
        return c.json({ error: 'permission_denied' }, 403);
      }
      return guarded(c, () => handler(c, context));
    };

  return { guarded, inAccount };
}

export function registerCommercialRoutes(app: Hono<AuthEnv>, deps: CommercialDependencies) {
  const { commercial, organizations, admins, audit, commercialAuthorization } = deps;
  const now = deps.now ?? (() => new Date());
  const { guarded, inAccount } = createCommercialGuard(deps);

  const event = (input: AuditEventInput, at: Date) => buildAuditEvent(input, at);
  /** Whether this user has signed in to MelonOffice; true when no directory is wired (tests). */
  const userExists = async (userId: UserId) =>
    deps.users === undefined || (await deps.users.findById(userId)) !== undefined;

  // ---------------------------------------------------------------- platform administrator

  app.get('/v1/platform/commercial-accounts', async (c) => {
    const admin = await platformAdminOf(c, admins);
    if (admin instanceof Response) return admin;
    const accounts = await commercial.listAccounts();
    return c.json({ accounts: accounts.map(accountView) });
  });

  app.post('/v1/platform/commercial-accounts', async (c) => {
    const auth = c.get('auth');
    const platform = await platformAdminOf(c, admins, {
      audit,
      action: 'commercial_account.created',
    });
    if (platform instanceof Response) return platform;
    const input = await body(c);
    if (!isCommercialAccountType(input.type)) return bad(c, 'type');
    let name: string;
    try {
      name = parseCommercialAccountName(input.name);
    } catch {
      return bad(c, 'name');
    }
    if (typeof input.adminUserId !== 'string' || !UUID.test(input.adminUserId)) {
      return bad(c, 'adminUserId');
    }
    const limits = parseAccountLimits(input.type, input.limits);
    if (limits === undefined) return bad(c, 'limits');
    if (!(await userExists(input.adminUserId as UserId))) return bad(c, 'adminUserId');
    const at = now();
    const iso = at.toISOString() as IsoTimestamp;
    const account: CommercialAccount = {
      id: newCommercialAccountId(),
      type: input.type,
      name,
      status: 'active',
      limits,
      createdAt: iso,
      updatedAt: iso,
    };
    const adminUserId = input.adminUserId as UserId;
    const admin: CommercialMembership = {
      id: commercialMembershipIdOf(account.id, adminUserId),
      commercialAccountId: account.id,
      userId: adminUserId,
      role: `${account.type}.admin`,
      status: 'active',
      createdAt: iso,
      updatedAt: iso,
    };
    const common = {
      result: 'success',
      actor: actorOf(auth),
      actorRole: platform.role,
      commercialAccountId: account.id,
      ...requestFields(c),
    } as const;
    await commercial.createAccount(account, admin, [
      event(
        {
          action: 'commercial_account.created',
          ...common,
          target: { type: 'commercial_account', id: account.id },
          reference: account.type,
        },
        at,
      ),
      event(
        {
          action: 'commercial_membership.created',
          ...common,
          target: { type: 'commercial_membership', id: admin.id },
          reference: admin.role,
        },
        at,
      ),
    ]);
    return c.json({ account: accountView(account), admin: memberView(admin) }, 201);
  });

  /**
   * A platform administrator's change to an account (ADR-0091): the administrator check first,
   * then the change. Every refusal after the check (bad input, a transition the account cannot
   * make, a close not confirmed, a stale version) is audited as denied with its code, so every
   * attempt leaves a trace, not only the ones that changed something.
   */
  const platformChange = (
    c: Context<AuthEnv>,
    action: 'commercial_account.status_changed' | 'commercial_account.limits_changed',
    work: (admin: PlatformAdminContext) => Promise<Response>,
  ) =>
    guarded(c, async () => {
      const admin = await platformAdminOf(c, admins, { audit, action });
      if (admin instanceof Response) return admin;
      const response = await guarded(c, () => work(admin));
      if (response.status >= 400) {
        const payload = (await response
          .clone()
          .json()
          .catch(() => ({}))) as Record<string, unknown>;
        const id = c.req.param('accountId') ?? '';
        await recordOutcome(c, audit, {
          action,
          result: 'denied',
          actor: actorOf(c.get('auth')),
          actorRole: admin.role,
          ...(UUID.test(id) ? { target: { type: 'commercial_account', id } } : {}),
          reason: typeof payload.error === 'string' ? payload.error : `http_${response.status}`,
          ...requestFields(c),
        });
      }
      return response;
    });

  /**
   * The account the platform administrator names in the path, with the version they read. Every
   * refusal after the administrator check says what was wrong with the request, never whether
   * another account exists: the administrator sees every account anyway.
   */
  const accountToChange = async (c: Context<AuthEnv>, input: Record<string, unknown>) => {
    const id = c.req.param('accountId') ?? '';
    const account = UUID.test(id)
      ? await commercial.findAccount(id as CommercialAccountId)
      : undefined;
    if (account === undefined) return c.json({ error: 'commercial_account_not_found' }, 404);
    if (typeof input.expectedUpdatedAt !== 'string') return bad(c, 'expectedUpdatedAt');
    if (input.expectedUpdatedAt !== account.updatedAt) {
      throw new TenancyError('commercial_conflict');
    }
    return account;
  };

  // Suspends, reactivates or closes an account (ADR-0091). Suspended: nobody in it can act, since
  // `resolveCommercialContext` requires an active account; reactivated: they can again. Closed is
  // final and asks for the account's exact name. Nothing is deleted: members, relationships,
  // invitations, brand and history stay, and the id is never reused.
  app.post('/v1/platform/commercial-accounts/:accountId/status', (c) =>
    platformChange(c, 'commercial_account.status_changed', async (admin) => {
      const input = await body(c);
      const status = input.status;
      if (status !== 'active' && status !== 'suspended' && status !== 'closed') {
        return bad(c, 'status');
      }
      const account = await accountToChange(c, input);
      if (account instanceof Response) return account;
      if (!canChangeAccountStatus(account.status, status)) {
        return c.json({ error: 'invalid_account_transition' }, 409);
      }
      if (status === 'closed' && input.confirmName !== account.name) {
        return c.json({ error: 'close_not_confirmed' }, 400);
      }
      const at = now();
      const next: CommercialAccount = {
        ...account,
        status,
        updatedAt: at.toISOString() as IsoTimestamp,
      };
      await commercial.saveAccount(next, account, [
        event(
          {
            action: 'commercial_account.status_changed',
            result: 'success',
            actor: actorOf(c.get('auth')),
            actorRole: admin.role,
            commercialAccountId: account.id,
            target: { type: 'commercial_account', id: account.id },
            transition: { from: account.status, to: status },
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ account: accountView(next) });
    }),
  );

  // Changes an account's limits (ADR-0091). A lower limit removes nobody: it only stops new
  // customers or members until the account is under it again.
  app.post('/v1/platform/commercial-accounts/:accountId/limits', (c) =>
    platformChange(c, 'commercial_account.limits_changed', async (admin) => {
      const input = await body(c);
      const account = await accountToChange(c, input);
      if (account instanceof Response) return account;
      const limits = parseAccountLimits(account.type, input.limits);
      if (limits === undefined) return bad(c, 'limits');
      if (account.status === 'closed') return c.json({ error: 'commercial_account_closed' }, 409);
      const at = now();
      const next: CommercialAccount = {
        ...account,
        limits,
        updatedAt: at.toISOString() as IsoTimestamp,
      };
      await commercial.saveAccount(next, account, [
        event(
          {
            action: 'commercial_account.limits_changed',
            result: 'success',
            actor: actorOf(c.get('auth')),
            actorRole: admin.role,
            commercialAccountId: account.id,
            target: { type: 'commercial_account', id: account.id },
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ account: accountView(next) });
    }),
  );

  // ---------------------------------------------------------------- partner and agency

  // The accounts the caller belongs to: active memberships in active accounts, their own only.
  app.get('/v1/commercial/accounts', async (c) => {
    const auth = c.get('auth');
    // Only a person with a verified email administers a commercial account (ADR-0098).
    if (auth.actor !== 'user' || !auth.emailVerified) return c.json({ accounts: [] });
    const mine = [];
    for (const m of await commercial.membershipsOfUser(auth.userId)) {
      if (m.status !== 'active' || m.userId !== auth.userId) continue;
      const account = await commercial.findAccount(m.commercialAccountId);
      if (account?.status === 'active' && (await parentAllows(account, commercial))) {
        mine.push({ ...accountView(account), role: m.role });
      }
    }
    return c.json({ accounts: mine });
  });

  app.get(
    '/v1/commercial/accounts/:accountId',
    inAccount('commercial.read', async (c, context) => {
      const account = await commercial.findAccount(context.commercialAccountId);
      if (account === undefined) throw new TenancyError('commercial_account_forbidden');
      return c.json({ account: accountView(account), role: context.role });
    }),
  );

  app.get(
    '/v1/commercial/accounts/:accountId/members',
    inAccount('commercial.read', async (c, context) => {
      const members = await commercial.membersOfAccount(context.commercialAccountId);
      return c.json({
        members: members
          .filter((m) => m.commercialAccountId === context.commercialAccountId)
          .map(memberView),
      });
    }),
  );

  // Changes an active member's role. `expectedUpdatedAt` names the version read. Nobody joins
  // here: a new member, or one removed, joins only by accepting an invitation (ADR-0093).
  app.post(
    '/v1/commercial/accounts/:accountId/members',
    inAccount('commercial.manage_members', async (c, context) => {
      const input = await body(c);
      if (typeof input.userId !== 'string' || !UUID.test(input.userId)) return bad(c, 'userId');
      if (!isCommercialRoleName(input.role) || !input.role.startsWith(`${context.accountType}.`)) {
        return bad(c, 'role');
      }
      const userId = input.userId as UserId;
      const role = input.role;
      const current = await commercial.findMembership(context.commercialAccountId, userId);
      if (current === undefined || current.status !== 'active') {
        return c.json({ error: 'member_invitation_required' }, 409);
      }
      if (current.updatedAt !== input.expectedUpdatedAt) {
        throw new TenancyError('commercial_conflict');
      }
      if (userId === context.userId && role !== current.role) {
        // Nobody changes their own role: an admin cannot lock the account out by accident.
        return c.json({ error: 'cannot_change_own_role' }, 409);
      }
      const at = now();
      const membership: CommercialMembership = {
        ...current,
        role,
        updatedAt: at.toISOString() as IsoTimestamp,
      };
      await commercial.saveMembership(membership, current, [
        event(
          {
            action: 'commercial_membership.updated',
            result: 'success',
            actor: actorOf(c.get('auth')),
            commercialAccountId: context.commercialAccountId,
            target: { type: 'commercial_membership', id: membership.id },
            reference: role,
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ member: memberView(membership) });
    }),
  );

  app.post(
    '/v1/commercial/accounts/:accountId/members/:userId/revoke',
    inAccount('commercial.manage_members', async (c, context) => {
      const userId = c.req.param('userId') as UserId;
      if (userId === context.userId) return c.json({ error: 'cannot_revoke_self' }, 409);
      const current = UUID.test(userId)
        ? await commercial.findMembership(context.commercialAccountId, userId)
        : undefined;
      if (current === undefined || current.status === 'revoked') {
        return c.json({ error: 'member_not_found' }, 404);
      }
      const at = now();
      await commercial.saveMembership(
        { ...current, status: 'revoked', updatedAt: at.toISOString() as IsoTimestamp },
        current,
        [
          event(
            {
              action: 'commercial_membership.revoked',
              result: 'success',
              actor: actorOf(c.get('auth')),
              commercialAccountId: context.commercialAccountId,
              target: { type: 'commercial_membership', id: current.id },
              ...requestFields(c),
            },
            at,
          ),
        ],
      );
      return c.json({ revoked: true });
    }),
  );

  // The account's active customers; a customer's name only where it granted `summary`.
  app.get(
    '/v1/commercial/accounts/:accountId/customers',
    inAccount('commercial.read', async (c, context) => {
      const customers = await listCustomersOf(context, commercial, organizations);
      const views = [];
      for (const access of customers) {
        const named = commercialAuthorization.authorize(
          context,
          'customer.read_summary',
          access,
        ).allowed;
        const organization = named
          ? await organizations.findOrganization(access.organizationId)
          : undefined;
        views.push({
          organizationId: access.organizationId,
          mode: access.mode,
          scopes: [...access.scopes],
          name: organization?.name ?? null,
        });
      }
      const pending = (await commercial.relationshipsOfAccount(context.commercialAccountId))
        .filter((r) => r.status === 'pending')
        .map((r) => ({ organizationId: r.organizationId, mode: r.mode, scopes: r.scopes }));
      return c.json({ customers: views, pending });
    }),
  );

  // Asks an organization to become a customer. Pending until its owner accepts it.
  app.post(
    '/v1/commercial/accounts/:accountId/customers',
    inAccount('commercial.invite_customer', async (c, context) => {
      const input = await body(c);
      if (!isOrganizationId(input.organizationId)) return bad(c, 'organizationId');
      const account = await commercial.findAccount(context.commercialAccountId);
      if (account === undefined) throw new TenancyError('commercial_account_forbidden');
      if (!isCustomerMode(input.mode) || !customerModesOf(account).includes(input.mode)) {
        return bad(c, 'mode');
      }
      let scopes;
      try {
        scopes = parseRequestedCustomerScopes(input.scopes ?? []);
      } catch {
        return bad(c, 'scopes');
      }
      const billing = input.billing;
      if (billing !== undefined && billing !== 'customer' && billing !== 'commercial_account') {
        return bad(c, 'billing');
      }
      const organizationId = input.organizationId;
      const organization = await organizations.findOrganization(organizationId);
      if (organization?.status !== 'active') throw new TenancyError('customer_forbidden');
      if (account.limits?.customers === undefined) {
        throw new TenancyError('commercial_limit_reached');
      }
      const current = await commercial.findRelationship(
        context.commercialAccountId,
        organizationId,
      );
      if (current !== undefined && current.status !== 'ended') {
        return c.json({ error: 'relationship_exists' }, 409);
      }
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const relationship: CustomerRelationship = {
        id: customerRelationshipIdOf(context.commercialAccountId, organizationId),
        commercialAccountId: context.commercialAccountId,
        organizationId,
        mode: input.mode,
        status: 'pending',
        scopes,
        ...(billing === undefined ? {} : { billing: billing as BillingRelationship }),
        createdAt: iso,
        updatedAt: iso,
      };
      await commercial.saveRelationship(
        relationship,
        current,
        [
          event(
            {
              action: 'customer_relationship.created',
              result: 'success',
              actor: actorOf(c.get('auth')),
              commercialAccountId: context.commercialAccountId,
              organizationId,
              target: { type: 'customer_relationship', id: relationship.id },
              reference: relationship.mode,
              ...requestFields(c),
            },
            at,
          ),
        ],
        account.limits.customers,
      );
      return c.json({ relationship: relationshipView(relationship) }, 201);
    }),
  );

  /**
   * A read inside one customer of this very account: an active relationship with an active
   * organization, and the scope the permission needs. Every refusal is `customer_forbidden`; a
   * missing scope or role is audited.
   */
  const inCustomer = (
    permission: 'customer.read_summary' | 'customer.read_usage' | 'customer.read_billing',
    handler: (c: Context<AuthEnv>, access: CustomerAccess) => Promise<Response>,
  ) =>
    inAccount('commercial.read', async (c, context) => {
      const access = await customerAccessOf(
        context,
        c.req.param('organizationId') ?? '',
        commercial,
        organizations,
      );
      const decision = commercialAuthorization.authorize(context, permission, access);
      if (!decision.allowed) {
        await recordOutcome(c, audit, {
          action: 'commercial.access',
          result: 'denied',
          actor: actorOf(c.get('auth')),
          commercialAccountId: context.commercialAccountId,
          organizationId: access.organizationId,
          permission,
          reason: decision.reason,
          ...requestFields(c),
        });
        return c.json({ error: 'customer_forbidden' }, 403);
      }
      return handler(c, access);
    });

  const customer = '/v1/commercial/accounts/:accountId/customers/:organizationId';

  // A customer's summary, only where it granted `summary`.
  app.get(
    customer,
    inCustomer('customer.read_summary', async (c, access) => {
      const organization = await organizations.findOrganization(access.organizationId);
      if (organization === undefined) throw new TenancyError('customer_forbidden');
      const plan = (await deps.currentPlan?.(organization.id)) ?? null;
      return c.json({
        organization: { id: organization.id, name: organization.name, status: organization.status },
        mode: access.mode,
        scopes: [...access.scopes],
        plan,
      });
    }),
  );

  // How much AI a customer used (ADR-0088), only where it granted `usage`: operations and credits,
  // in total and by capability. Never who used it, which agent, provider or model, nor its cost.
  app.get(
    `${customer}/usage`,
    inCustomer('customer.read_usage', async (c, access) => {
      if (deps.usage === undefined) return c.json({ error: 'ai_usage_not_configured' }, 503);
      const from = c.req.query('from') ?? now().toISOString().slice(0, 10);
      const to = c.req.query('to') ?? from;
      if (!DAY.test(from) || !DAY.test(to)) return c.json({ error: 'invalid_request' }, 400);
      let summary;
      try {
        summary = await deps.usage.summary(access.organizationId, from, to);
      } catch (error) {
        if (isAIUsageError(error)) return c.json({ error: 'invalid_request' }, 400);
        throw error;
      }
      const bucket = (b: { operations: number; credits: number }) => ({
        operations: b.operations,
        credits: b.credits,
      });
      return c.json({
        from: summary.from,
        to: summary.to,
        totals: bucket(summary.totals),
        byCapability: Object.fromEntries(
          Object.entries(summary.by.capability ?? {}).map(([k, b]) => [k, bucket(b)]),
        ),
      });
    }),
  );

  // A customer's subscription (ADR-0088), only where it granted `billing`: plan, status and who
  // is billed. Nothing about payments; nothing here changes billing or credits.
  app.get(
    `${customer}/billing`,
    inCustomer('customer.read_billing', async (c, access) => {
      const relationship = await commercial.findRelationship(
        access.commercialAccountId,
        access.organizationId,
      );
      const subscription = (await deps.subscriptionOf?.(access.organizationId)) ?? null;
      return c.json({
        billedTo: relationship?.billing ?? null,
        subscription,
      });
    }),
  );

  // ---------------------------------------------------------------- the customer's owner

  const tenancyDeps = { store: organizations, authorization: deps.authorization, audit };
  const base = '/v1/organizations/:organizationId/commercial-relationships';

  app.get(
    base,
    withPermission('relationship.read', tenancyDeps, async (c, tenant) => {
      const relationships = await commercial.relationshipsOfOrganization(tenant.organizationId);
      const views = [];
      for (const r of relationships) {
        if (r.organizationId !== tenant.organizationId) continue;
        const account = await commercial.findAccount(r.commercialAccountId);
        views.push({
          ...relationshipView(r),
          account: account === undefined ? null : { name: account.name, type: account.type },
        });
      }
      return c.json({ relationships: views });
    }),
  );

  /** A decision of the owner's, directly: never GIA and never the runtime. */
  const ownerDecides = (
    handler: (
      c: Context<AuthEnv>,
      tenant: TenantContext,
      current: CustomerRelationship,
      input: Record<string, unknown>,
    ) => Promise<Response>,
  ) =>
    withPermission('relationship.manage', tenancyDeps, async (c, tenant) => {
      if (tenant.actor !== 'user') return c.json({ error: 'requires_user' }, 403);
      const accountId = c.req.param('accountId') ?? '';
      const current = UUID.test(accountId)
        ? await commercial.findRelationship(accountId as never, tenant.organizationId)
        : undefined;
      if (current === undefined || current.organizationId !== tenant.organizationId) {
        return c.json({ error: 'relationship_not_found' }, 404);
      }
      const input = await body(c);
      if (input.expectedUpdatedAt !== current.updatedAt) {
        return c.json({ error: 'commercial_conflict' }, 409);
      }
      return guarded(c, () => handler(c, tenant, current, input));
    });

  const change = async (
    c: Context<AuthEnv>,
    tenant: TenantContext,
    current: CustomerRelationship,
    next: CustomerRelationship,
  ) => {
    const at = now();
    const saved = { ...next, updatedAt: at.toISOString() as IsoTimestamp };
    await commercial.saveRelationship(saved, current, [
      event(
        {
          action: 'customer_relationship.updated',
          result: 'success',
          actor: actorOf(tenant),
          organizationId: tenant.organizationId,
          commercialAccountId: current.commercialAccountId,
          target: { type: 'customer_relationship', id: current.id },
          transition: { from: current.status, to: saved.status },
          ...requestFields(c),
        },
        at,
      ),
    ]);
    return c.json({ relationship: relationshipView(saved) });
  };

  /** Scopes the owner grants: known, and never more than the partner asked for. */
  const narrowed = (requested: readonly string[], value: unknown) => {
    const scopes = parseCustomerScopes(value);
    return scopes.every((s) => requested.includes(s)) ? scopes : undefined;
  };

  app.post(
    `${base}/:accountId/accept`,
    ownerDecides(async (c, tenant, current, input) => {
      if (current.status !== 'pending') return c.json({ error: 'relationship_not_pending' }, 409);
      // A suspended or closed partner gains no customer (ADR-0091): its request waits, or ends.
      const account = await commercial.findAccount(current.commercialAccountId);
      if (account?.status !== 'active') {
        return c.json({ error: 'commercial_account_inactive' }, 409);
      }
      let scopes;
      try {
        scopes = narrowed(current.scopes, input.scopes);
      } catch {
        return bad(c, 'scopes');
      }
      if (scopes === undefined) return bad(c, 'scopes');
      return change(c, tenant, current, {
        ...current,
        status: 'active',
        scopes,
        acceptedBy: tenant.userId,
      });
    }),
  );

  app.post(
    `${base}/:accountId/scopes`,
    ownerDecides(async (c, tenant, current, input) => {
      if (current.status !== 'active') return c.json({ error: 'relationship_not_active' }, 409);
      let scopes;
      try {
        scopes = narrowed(current.scopes, input.scopes);
      } catch {
        return bad(c, 'scopes');
      }
      if (scopes === undefined) return bad(c, 'scopes');
      return change(c, tenant, current, { ...current, scopes });
    }),
  );

  app.post(
    `${base}/:accountId/end`,
    ownerDecides(async (c, tenant, current) => {
      if (!canChangeRelationshipStatus(current.status, 'ended')) {
        return c.json({ error: 'relationship_ended' }, 409);
      }
      return change(c, tenant, current, { ...current, status: 'ended', scopes: [] });
    }),
  );
}
