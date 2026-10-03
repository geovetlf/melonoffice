import { actorOf, buildAuditEvent } from '@melonoffice/audit';
import type {
  CommercialAccount,
  CommercialAccountId,
  IsoTimestamp,
  MemberInvitation,
} from '@melonoffice/domain';
import {
  canChangeAccountStatus,
  INVITATION_TTL_MS,
  invitationStatusAt,
  isCommercialAccountId,
  newCommercialAccountId,
  newInvitationToken,
  newMemberInvitationId,
  parseCommercialAccountName,
  parseInvitationEmail,
  TenancyError,
  type CommercialContext,
} from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import { requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';
import {
  accountView,
  createCommercialGuard,
  parseAccountLimits,
  type CommercialDependencies,
} from './commercial.js';

/**
 * A white label's resellers (ADR-0098). A white label creates its resellers, each with the
 * invitation of its first admin (the link is shown once, ADR-0093), sees them, and suspends or
 * reactivates them. It reaches only accounts whose parent is itself: another white label's
 * resellers answer exactly like an unknown id. It never reaches a reseller's members' or
 * customers' own data; a reseller's customers grant their scopes to that reseller only.
 *
 * A reseller never gets these routes: only `white_label.admin` holds `commercial.manage_resellers`,
 * and `commercial.read` here answers only inside a white label.
 */

const bad = (c: Context<AuthEnv>, field: string) =>
  c.json({ error: 'invalid_commercial_request', field }, 400);

const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const value: unknown = await c.req.json().catch(() => undefined);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

export function registerResellerRoutes(app: Hono<AuthEnv>, deps: CommercialDependencies) {
  const { commercial } = deps;
  const now = deps.now ?? (() => new Date());
  const { inAccount } = createCommercialGuard(deps);
  const base = '/v1/commercial/accounts/:accountId/resellers';

  /** The white label of the path, as stored; `undefined` for any other kind of account. */
  const whiteLabelOf = async (context: CommercialContext) => {
    if (context.accountType !== 'white_label') return undefined;
    const account = await commercial.findAccount(context.commercialAccountId);
    return account?.type === 'white_label' ? account : undefined;
  };

  /** One of this white label's own resellers; any other id is `commercial_account_forbidden`. */
  const ownReseller = async (context: CommercialContext, id: string | undefined) => {
    const reseller = isCommercialAccountId(id) ? await commercial.findAccount(id) : undefined;
    if (
      reseller === undefined ||
      reseller.type !== 'reseller' ||
      reseller.parentAccountId !== context.commercialAccountId
    ) {
      throw new TenancyError('commercial_account_forbidden');
    }
    return reseller;
  };

  // The white label's resellers: each account, its first admin's pending invitation (email and
  // expiry, never the link) and how many customers it serves. Nothing inside those customers.
  app.get(
    base,
    inAccount('commercial.read', async (c, context) => {
      const parent = await whiteLabelOf(context);
      if (parent === undefined) throw new TenancyError('commercial_account_forbidden');
      const at = now();
      const resellers = await commercial.accountsWithParent(parent.id);
      const views = await Promise.all(
        resellers
          .filter((r) => r.type === 'reseller' && r.parentAccountId === parent.id)
          .map(async (r) => {
            const [relationships, invitations] = await Promise.all([
              commercial.relationshipsOfAccount(r.id),
              commercial.memberInvitationsOfAccount(r.id),
            ]);
            const pending = invitations.filter((i) => invitationStatusAt(i, at) === 'pending');
            return {
              ...accountView(r),
              customers: relationships.filter((x) => x.status === 'active').length,
              pendingAdmins: pending.map((i) => ({ email: i.email, expiresAt: i.expiresAt })),
            };
          }),
      );
      return c.json({ resellers: views, limit: parent.limits?.resellers ?? null });
    }),
  );

  // Creates a reseller with its limits, never above the white label's own, and invites its first
  // admin by email. The link is answered once; nobody is a member until they accept it.
  app.post(
    base,
    inAccount('commercial.manage_resellers', async (c, context) => {
      const parent = await whiteLabelOf(context);
      if (parent === undefined) throw new TenancyError('commercial_account_forbidden');
      const input = await body(c);
      let name: string;
      try {
        name = parseCommercialAccountName(input.name);
      } catch {
        return bad(c, 'name');
      }
      let email: string;
      try {
        email = parseInvitationEmail(input.adminEmail);
      } catch {
        return bad(c, 'adminEmail');
      }
      const limits = parseAccountLimits('reseller', input.limits);
      const own = parent.limits;
      if (
        limits?.customers === undefined ||
        limits.members === undefined ||
        own?.customers === undefined ||
        own.members === undefined ||
        limits.customers > own.customers ||
        limits.members > own.members
      ) {
        return bad(c, 'limits');
      }
      if (own.resellers === undefined) throw new TenancyError('commercial_limit_reached');

      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const account: CommercialAccount = {
        id: newCommercialAccountId(),
        type: 'reseller',
        name,
        status: 'active',
        limits: { customers: limits.customers, members: limits.members },
        parentAccountId: parent.id,
        createdAt: iso,
        updatedAt: iso,
      };
      const { token, tokenHash } = newInvitationToken();
      const invitation: MemberInvitation = {
        id: newMemberInvitationId(),
        commercialAccountId: account.id,
        email,
        role: 'reseller.admin',
        status: 'pending',
        tokenHash,
        expiresAt: new Date(at.getTime() + INVITATION_TTL_MS).toISOString() as IsoTimestamp,
        createdBy: context.userId,
        createdAt: iso,
        updatedAt: iso,
      };
      const common = {
        result: 'success',
        actor: actorOf(c.get('auth')),
        commercialAccountId: account.id,
        ...requestFields(c),
      } as const;
      await commercial.createChildAccount(
        account,
        parent,
        invitation,
        [
          buildAuditEvent(
            {
              action: 'commercial_account.created',
              ...common,
              target: { type: 'commercial_account', id: account.id },
              reference: `reseller_of:${parent.id}`,
            },
            at,
          ),
          buildAuditEvent(
            {
              action: 'member_invitation.created',
              ...common,
              target: { type: 'member_invitation', id: invitation.id },
              reference: invitation.role,
            },
            at,
          ),
        ],
        own.resellers,
      );
      return c.json(
        {
          reseller: {
            ...accountView(account),
            customers: 0,
            pendingAdmins: [{ email, expiresAt: invitation.expiresAt }],
          },
          token,
        },
        201,
      );
    }),
  );

  // Suspends or reactivates one of its resellers. Closing an account stays the platform's.
  app.post(
    `${base}/:resellerId/status`,
    inAccount('commercial.manage_resellers', async (c, context) => {
      const parent = await whiteLabelOf(context);
      if (parent === undefined) throw new TenancyError('commercial_account_forbidden');
      const reseller = await ownReseller(context, c.req.param('resellerId'));
      const input = await body(c);
      const status = input.status;
      if (status !== 'active' && status !== 'suspended') return bad(c, 'status');
      if (typeof input.expectedUpdatedAt !== 'string') return bad(c, 'expectedUpdatedAt');
      if (input.expectedUpdatedAt !== reseller.updatedAt) {
        throw new TenancyError('commercial_conflict');
      }
      if (!canChangeAccountStatus(reseller.status, status)) {
        return c.json({ error: 'invalid_account_transition' }, 409);
      }
      // A version is its timestamp: it must move even when two writes share a millisecond,
      // or a stale `expectedUpdatedAt` would still match.
      const previous = Date.parse(reseller.updatedAt);
      const clock = now();
      const at = clock.getTime() > previous ? clock : new Date(previous + 1);
      const next: CommercialAccount = {
        ...reseller,
        status,
        updatedAt: at.toISOString() as IsoTimestamp,
      };
      await commercial.saveAccount(next, reseller, [
        buildAuditEvent(
          {
            action: 'commercial_account.status_changed',
            result: 'success',
            actor: actorOf(c.get('auth')),
            commercialAccountId: reseller.id as CommercialAccountId,
            target: { type: 'commercial_account', id: reseller.id },
            transition: { from: reseller.status, to: status },
            reference: `reseller_of:${parent.id}`,
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ reseller: accountView(next) });
    }),
  );
}
