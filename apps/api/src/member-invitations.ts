import { actorOf, buildAuditEvent, type AuditEventInput } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import type { CommercialMembership, IsoTimestamp, MemberInvitation } from '@melonoffice/domain';
import { isCommercialRoleName } from '@melonoffice/rbac';
import {
  commercialMembershipIdOf,
  hashInvitationToken,
  INVITATION_TTL_MS,
  invitationStatusAt,
  isInvitationToken,
  isInvitedPerson,
  isMemberInvitationId,
  isTenancyError,
  newInvitationToken,
  newMemberInvitationId,
  parentAllows,
  parseInvitationEmail,
  TenancyError,
} from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import { recordOutcome, requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';
import { createCommercialGuard, type CommercialDependencies } from './commercial.js';

/**
 * Invitations to join a partner or agency account (ADR-0093). Nobody becomes a member without
 * agreeing: an admin invites a person by email with one of the account's roles, the link is shown
 * once for the admin to send (no email provider, ADR-0089), and only that person, signed in with
 * that email verified, can take it or decline it. Taking it creates the membership in the same
 * write, within the account's member limit. The account must be active. Every step is audited;
 * neither the email nor the link's secret is ever recorded.
 *
 * The person does not need an organization of their own to join.
 */

const bad = (c: Context<AuthEnv>, field: string) =>
  c.json({ error: 'invalid_commercial_request', field }, 400);

const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const value: unknown = await c.req.json().catch(() => undefined);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

/** What the account's admins see of its member invitations. Never the secret or its hash. */
const invitationView = (i: MemberInvitation, at: Date) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  status: invitationStatusAt(i, at),
  expiresAt: i.expiresAt,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
});

export function registerMemberInvitationRoutes(app: Hono<AuthEnv>, deps: CommercialDependencies) {
  const { commercial, audit } = deps;
  const now = deps.now ?? (() => new Date());
  const { guarded, inAccount } = createCommercialGuard(deps);
  const event = (input: AuditEventInput, at: Date) => buildAuditEvent(input, at);

  /** Records an expiry the first time anyone looks at it, and answers it as it now is. */
  const settle = async (
    c: Context<AuthEnv>,
    invitation: MemberInvitation,
  ): Promise<MemberInvitation> => {
    const at = now();
    if (invitationStatusAt(invitation, at) !== 'expired' || invitation.status === 'expired') {
      return invitation;
    }
    const expired: MemberInvitation = {
      ...invitation,
      status: 'expired',
      updatedAt: at.toISOString() as IsoTimestamp,
    };
    try {
      await commercial.saveMemberInvitation(expired, invitation, [
        event(
          {
            action: 'member_invitation.expired',
            result: 'success',
            actor: actorOf(c.get('auth')),
            commercialAccountId: invitation.commercialAccountId,
            target: { type: 'member_invitation', id: invitation.id },
            transition: { from: 'pending', to: 'expired' },
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return expired;
    } catch (error) {
      if (!isTenancyError(error) || error.code !== 'commercial_conflict') throw error;
      return (await commercial.findMemberInvitation(invitation.id)) ?? expired;
    }
  };

  // ---------------------------------------------------------------- the account's admins

  const accountBase = '/v1/commercial/accounts/:accountId/member-invitations';

  // Invites a person by email with one of the account's roles. Pending, granting nothing.
  app.post(
    accountBase,
    inAccount('commercial.manage_members', async (c, context) => {
      const input = await body(c);
      let email;
      try {
        email = parseInvitationEmail(input.email);
      } catch {
        return bad(c, 'email');
      }
      if (!isCommercialRoleName(input.role) || !input.role.startsWith(`${context.accountType}.`)) {
        return bad(c, 'role');
      }
      const role = input.role;
      const account = await commercial.findAccount(context.commercialAccountId);
      if (account?.limits?.members === undefined) {
        throw new TenancyError('commercial_limit_reached');
      }
      const at = now();
      const open = (await commercial.memberInvitationsOfAccount(context.commercialAccountId)).find(
        (i) => i.email === email && invitationStatusAt(i, at) === 'pending',
      );
      if (open !== undefined) return c.json({ error: 'invitation_exists' }, 409);

      const iso = at.toISOString() as IsoTimestamp;
      const { token, tokenHash } = newInvitationToken();
      const invitation: MemberInvitation = {
        id: newMemberInvitationId(),
        commercialAccountId: context.commercialAccountId,
        email,
        role,
        status: 'pending',
        tokenHash,
        expiresAt: new Date(at.getTime() + INVITATION_TTL_MS).toISOString() as IsoTimestamp,
        createdBy: context.userId,
        createdAt: iso,
        updatedAt: iso,
      };
      await commercial.saveMemberInvitation(
        invitation,
        undefined,
        [
          event(
            {
              action: 'member_invitation.created',
              result: 'success',
              actor: actorOf(c.get('auth')),
              commercialAccountId: context.commercialAccountId,
              target: { type: 'member_invitation', id: invitation.id },
              reference: role,
              ...requestFields(c),
            },
            at,
          ),
        ],
        // At most as many pending invitations as the account may have members.
        account.limits.members,
      );
      // The secret is answered once, for the admin to send the link themselves.
      return c.json({ invitation: invitationView(invitation, at), token }, 201);
    }),
  );

  app.get(
    accountBase,
    inAccount('commercial.read', async (c, context) => {
      const views = [];
      for (const found of await commercial.memberInvitationsOfAccount(
        context.commercialAccountId,
      )) {
        if (found.commercialAccountId !== context.commercialAccountId) continue;
        views.push(invitationView(await settle(c, found), now()));
      }
      views.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return c.json({ invitations: views });
    }),
  );

  // Withdraws a pending invitation. Its link stops working at once.
  app.post(
    `${accountBase}/:invitationId/revoke`,
    inAccount('commercial.manage_members', async (c, context) => {
      const id = c.req.param('invitationId') ?? '';
      const found = isMemberInvitationId(id)
        ? await commercial.findMemberInvitation(id)
        : undefined;
      if (found === undefined || found.commercialAccountId !== context.commercialAccountId) {
        return c.json({ error: 'invitation_not_found' }, 404);
      }
      const input = await body(c);
      if (input.expectedUpdatedAt !== found.updatedAt) {
        return c.json({ error: 'commercial_conflict' }, 409);
      }
      const current = await settle(c, found);
      if (current.status !== 'pending') return c.json({ error: 'invitation_not_pending' }, 409);
      const at = now();
      const revoked: MemberInvitation = {
        ...current,
        status: 'revoked',
        updatedAt: at.toISOString() as IsoTimestamp,
      };
      await commercial.saveMemberInvitation(revoked, current, [
        event(
          {
            action: 'member_invitation.revoked',
            result: 'success',
            actor: actorOf(c.get('auth')),
            commercialAccountId: context.commercialAccountId,
            target: { type: 'member_invitation', id: current.id },
            transition: { from: 'pending', to: 'revoked' },
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ invitation: invitationView(revoked, at) });
    }),
  );

  // ---------------------------------------------------------------- the invited person

  /** The invitation a link's secret opens. The secret travels in the body, never in a URL. */
  const byToken = async (c: Context<AuthEnv>) => {
    const input = await body(c);
    if (!isInvitationToken(input.token)) return { input, invitation: undefined };
    const found = await commercial.findMemberInvitationByTokenHash(
      hashInvitationToken(input.token),
    );
    return { input, invitation: found === undefined ? undefined : await settle(c, found) };
  };

  const personCheck = (auth: AuthenticatedContext, invitation: MemberInvitation) => {
    if (isInvitedPerson(auth, invitation)) return undefined;
    const sameEmail =
      auth.actor === 'user' && auth.email?.trim().toLowerCase() === invitation.email;
    return sameEmail && !auth.emailVerified ? 'email_not_verified' : 'not_invited_person';
  };

  const refuse = async (
    c: Context<AuthEnv>,
    action: 'member_invitation.accepted' | 'member_invitation.rejected',
    invitation: MemberInvitation,
    reason: 'not_invited_person' | 'email_not_verified' | 'invitation_not_pending',
  ) => {
    await recordOutcome(c, audit, {
      action,
      result: 'denied',
      actor: actorOf(c.get('auth')),
      commercialAccountId: invitation.commercialAccountId,
      target: { type: 'member_invitation', id: invitation.id },
      reason,
      ...requestFields(c),
    });
    return reason === 'invitation_not_pending'
      ? c.json({ error: reason, status: invitation.status }, 409)
      : c.json({ error: reason === 'email_not_verified' ? reason : 'invitation_forbidden' }, 403);
  };

  // What the link offers: which account, which role, and whether this person can take it.
  app.post('/v1/member-invitations/lookup', async (c) => {
    const { invitation } = await byToken(c);
    if (invitation === undefined) return c.json({ error: 'invitation_not_found' }, 404);
    const account = await commercial.findAccount(invitation.commercialAccountId);
    return c.json({
      invitation: {
        account: account === undefined ? null : { name: account.name, type: account.type },
        role: invitation.role,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        updatedAt: invitation.updatedAt,
      },
      person: personCheck(c.get('auth'), invitation) ?? 'invited',
    });
  });

  app.post('/v1/member-invitations/accept', async (c) => {
    const auth = c.get('auth');
    const { input, invitation } = await byToken(c);
    if (invitation === undefined) return c.json({ error: 'invitation_not_found' }, 404);
    const blocked = personCheck(auth, invitation);
    if (blocked !== undefined) return refuse(c, 'member_invitation.accepted', invitation, blocked);
    if (invitation.status !== 'pending') {
      return refuse(c, 'member_invitation.accepted', invitation, 'invitation_not_pending');
    }
    if (input.expectedUpdatedAt !== invitation.updatedAt) {
      return c.json({ error: 'commercial_conflict' }, 409);
    }
    // A suspended or closed account gains nobody (ADR-0091), nor a reseller whose white label is
    // not active (ADR-0098).
    const account = await commercial.findAccount(invitation.commercialAccountId);
    if (account?.status !== 'active' || !(await parentAllows(account, commercial))) {
      return c.json({ error: 'commercial_account_inactive' }, 409);
    }
    const limit = account.limits?.members;
    if (limit === undefined) return c.json({ error: 'commercial_limit_reached' }, 409);
    const current = await commercial.findMembership(invitation.commercialAccountId, auth.userId);
    if (current?.status === 'active') return c.json({ error: 'already_member' }, 409);

    const at = now();
    const iso = at.toISOString() as IsoTimestamp;
    const membership: CommercialMembership = {
      id: commercialMembershipIdOf(invitation.commercialAccountId, auth.userId),
      commercialAccountId: invitation.commercialAccountId,
      userId: auth.userId,
      role: invitation.role,
      status: 'active',
      createdAt: current?.createdAt ?? iso,
      updatedAt: iso,
    };
    const accepted: MemberInvitation = {
      ...invitation,
      status: 'accepted',
      decidedBy: auth.userId,
      updatedAt: iso,
    };
    const common = {
      result: 'success' as const,
      actor: actorOf(auth),
      commercialAccountId: invitation.commercialAccountId,
      ...requestFields(c),
    };
    return guarded(c, async () => {
      await commercial.acceptMemberInvitation(
        accepted,
        invitation,
        membership,
        current,
        [
          event(
            {
              ...common,
              action: 'member_invitation.accepted',
              target: { type: 'member_invitation', id: invitation.id },
              transition: { from: 'pending', to: 'accepted' },
            },
            at,
          ),
          event(
            {
              ...common,
              action: 'commercial_membership.created',
              target: { type: 'commercial_membership', id: membership.id },
              reference: membership.role,
            },
            at,
          ),
        ],
        limit,
      );
      return c.json({
        account: { id: account.id, name: account.name, type: account.type },
        role: membership.role,
      });
    });
  });

  app.post('/v1/member-invitations/reject', async (c) => {
    const auth = c.get('auth');
    const { input, invitation } = await byToken(c);
    if (invitation === undefined) return c.json({ error: 'invitation_not_found' }, 404);
    const blocked = personCheck(auth, invitation);
    if (blocked !== undefined) return refuse(c, 'member_invitation.rejected', invitation, blocked);
    if (invitation.status !== 'pending') {
      return refuse(c, 'member_invitation.rejected', invitation, 'invitation_not_pending');
    }
    if (input.expectedUpdatedAt !== invitation.updatedAt) {
      return c.json({ error: 'commercial_conflict' }, 409);
    }
    const at = now();
    const rejected: MemberInvitation = {
      ...invitation,
      status: 'rejected',
      decidedBy: auth.userId,
      updatedAt: at.toISOString() as IsoTimestamp,
    };
    return guarded(c, async () => {
      await commercial.saveMemberInvitation(rejected, invitation, [
        event(
          {
            action: 'member_invitation.rejected',
            result: 'success',
            actor: actorOf(auth),
            commercialAccountId: invitation.commercialAccountId,
            target: { type: 'member_invitation', id: invitation.id },
            transition: { from: 'pending', to: 'rejected' },
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ status: 'rejected' });
    });
  });
}
