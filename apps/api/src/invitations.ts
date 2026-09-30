import { actorOf, buildAuditEvent, type AuditEventInput } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  BillingRelationship,
  CommercialAccountType,
  CustomerInvitation,
  CustomerMode,
  CustomerRelationship,
  IsoTimestamp,
} from '@melonoffice/domain';
import {
  customerRelationshipIdOf,
  hashInvitationToken,
  INVITATION_TTL_MS,
  invitationStatusAt,
  isCustomerInvitationId,
  isCustomerMode,
  isInvitationToken,
  isInvitedPerson,
  isTenancyError,
  newCustomerInvitationId,
  newInvitationToken,
  parseCustomerScopes,
  parseInvitationEmail,
  resolveTenant,
  TenancyError,
  type TenantContext,
} from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import { recordOutcome, requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';
import { createCommercialGuard, type CommercialDependencies } from './commercial.js';

/**
 * Invitations by email to become a partner's or agency's customer (ADR-0089), over the commercial
 * layer of ADR-0086. Geovet's rules:
 *
 * - An invitation names a person by email. It grants nothing: it is pending until that very
 *   person, signed in with that email verified, takes it or declines it. It can also be revoked
 *   by the account, and it expires.
 * - The organization is never chosen by the client: it is the one the invited person belongs to,
 *   resolved from their own membership. Without one, they create it first (the usual
 *   `POST /v1/organizations`) and come back.
 * - The relationship is active only when the person taking it can decide for their organization
 *   (`relationship.manage`), with exactly the scopes they tick, none by default. Anyone else
 *   takes it for their owner: the relationship is pending, and the owner decides in their usual
 *   screen.
 * - Every step is audited, in the same write as its data. Neither the email nor the link's secret
 *   is ever recorded.
 */

/** Sends an invitation's email. Absent: no provider is configured and the partner shares the link. */
export interface InvitationMailer {
  send(input: {
    readonly to: string;
    readonly token: string;
    readonly accountName: string;
    readonly expiresAt: IsoTimestamp;
  }): Promise<void>;
}

export interface InvitationDependencies extends CommercialDependencies {
  readonly mailer?: InvitationMailer;
}

/** The modes each kind of account may use, as for a request by id (ADR-0086). */
const MODES: Readonly<Record<CommercialAccountType, readonly CustomerMode[]>> = {
  partner: ['direct', 'reseller', 'white_label', 'oem', 'enterprise'],
  agency: ['agency'],
};

const bad = (c: Context<AuthEnv>, field: string) =>
  c.json({ error: 'invalid_commercial_request', field }, 400);

const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const value: unknown = await c.req.json().catch(() => undefined);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

/** What the account sees of its own invitations. Never the secret or its hash. */
const invitationView = (i: CustomerInvitation, at: Date) => ({
  id: i.id,
  email: i.email,
  mode: i.mode,
  scopes: i.scopes,
  billing: i.billing ?? null,
  status: invitationStatusAt(i, at),
  expiresAt: i.expiresAt,
  organizationId: i.organizationId ?? null,
  createdAt: i.createdAt,
  updatedAt: i.updatedAt,
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

export function registerInvitationRoutes(app: Hono<AuthEnv>, deps: InvitationDependencies) {
  const { commercial, organizations, audit, authorization } = deps;
  const now = deps.now ?? (() => new Date());
  const { guarded, inAccount } = createCommercialGuard(deps);
  const event = (input: AuditEventInput, at: Date) => buildAuditEvent(input, at);

  /**
   * Records an expiry the first time anyone looks at a pending invitation past its time, and
   * answers the invitation as it now is.
   */
  const settle = async (
    c: Context<AuthEnv>,
    invitation: CustomerInvitation,
  ): Promise<CustomerInvitation> => {
    const at = now();
    if (invitationStatusAt(invitation, at) !== 'expired' || invitation.status === 'expired') {
      return invitation;
    }
    const expired: CustomerInvitation = {
      ...invitation,
      status: 'expired',
      updatedAt: at.toISOString() as IsoTimestamp,
    };
    try {
      await commercial.saveInvitation(expired, invitation, [
        event(
          {
            action: 'customer_invitation.expired',
            result: 'success',
            actor: actorOf(c.get('auth')),
            commercialAccountId: invitation.commercialAccountId,
            target: { type: 'customer_invitation', id: invitation.id },
            transition: { from: 'pending', to: 'expired' },
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return expired;
    } catch (error) {
      // Someone else recorded it, or changed it, first: answer what is stored now.
      if (!isTenancyError(error) || error.code !== 'commercial_conflict') throw error;
      return (await commercial.findInvitation(invitation.id)) ?? expired;
    }
  };

  // ---------------------------------------------------------------- the partner or agency

  const accountBase = '/v1/commercial/accounts/:accountId/invitations';

  // Invites a person by email. Pending, granting nothing, until they take it.
  app.post(
    accountBase,
    inAccount('commercial.invite_customer', async (c, context) => {
      const input = await body(c);
      let email;
      try {
        email = parseInvitationEmail(input.email);
      } catch {
        return bad(c, 'email');
      }
      if (!isCustomerMode(input.mode) || !MODES[context.accountType].includes(input.mode)) {
        return bad(c, 'mode');
      }
      let scopes;
      try {
        scopes = parseCustomerScopes(input.scopes ?? []);
      } catch {
        return bad(c, 'scopes');
      }
      const billing = input.billing;
      if (billing !== undefined && billing !== 'customer' && billing !== 'commercial_account') {
        return bad(c, 'billing');
      }
      const account = await commercial.findAccount(context.commercialAccountId);
      if (account?.limits?.customers === undefined) {
        throw new TenancyError('commercial_limit_reached');
      }
      const at = now();
      const open = (await commercial.invitationsOfAccount(context.commercialAccountId)).find(
        (i) => i.email === email && invitationStatusAt(i, at) === 'pending',
      );
      if (open !== undefined) return c.json({ error: 'invitation_exists' }, 409);

      const iso = at.toISOString() as IsoTimestamp;
      const { token, tokenHash } = newInvitationToken();
      const invitation: CustomerInvitation = {
        id: newCustomerInvitationId(),
        commercialAccountId: context.commercialAccountId,
        email,
        mode: input.mode,
        scopes,
        ...(billing === undefined ? {} : { billing: billing as BillingRelationship }),
        status: 'pending',
        tokenHash,
        expiresAt: new Date(at.getTime() + INVITATION_TTL_MS).toISOString() as IsoTimestamp,
        createdBy: context.userId,
        createdAt: iso,
        updatedAt: iso,
      };
      await commercial.saveInvitation(
        invitation,
        undefined,
        [
          event(
            {
              action: 'customer_invitation.created',
              result: 'success',
              actor: actorOf(c.get('auth')),
              commercialAccountId: context.commercialAccountId,
              target: { type: 'customer_invitation', id: invitation.id },
              reference: invitation.mode,
              ...requestFields(c),
            },
            at,
          ),
        ],
        account.limits.customers,
      );

      // With a provider, the email goes out and the secret stays with it. Without one, or when the
      // provider fails, the secret is answered once so the account can share the link itself.
      let delivery: 'email' | 'manual' | 'email_failed' = 'manual';
      if (deps.mailer !== undefined) {
        try {
          await deps.mailer.send({
            to: email,
            token,
            accountName: account.name,
            expiresAt: invitation.expiresAt,
          });
          delivery = 'email';
        } catch {
          delivery = 'email_failed';
        }
        await recordOutcome(c, audit, {
          action: 'customer_invitation.sent',
          result: delivery === 'email' ? 'success' : 'failure',
          actor: actorOf(c.get('auth')),
          commercialAccountId: context.commercialAccountId,
          target: { type: 'customer_invitation', id: invitation.id },
          ...(delivery === 'email' ? {} : { reason: 'email_failed' }),
          ...requestFields(c),
        });
      }
      return c.json(
        {
          invitation: invitationView(invitation, at),
          delivery,
          ...(delivery === 'email' ? {} : { token }),
        },
        201,
      );
    }),
  );

  app.get(
    accountBase,
    inAccount('commercial.read', async (c, context) => {
      const views = [];
      for (const found of await commercial.invitationsOfAccount(context.commercialAccountId)) {
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
    inAccount('commercial.invite_customer', async (c, context) => {
      const id = c.req.param('invitationId') ?? '';
      const found = isCustomerInvitationId(id) ? await commercial.findInvitation(id) : undefined;
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
      const revoked: CustomerInvitation = {
        ...current,
        status: 'revoked',
        updatedAt: at.toISOString() as IsoTimestamp,
      };
      await commercial.saveInvitation(revoked, current, [
        event(
          {
            action: 'customer_invitation.revoked',
            result: 'success',
            actor: actorOf(c.get('auth')),
            commercialAccountId: context.commercialAccountId,
            target: { type: 'customer_invitation', id: current.id },
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
    const found = await commercial.findInvitationByTokenHash(hashInvitationToken(input.token));
    return { input, invitation: found === undefined ? undefined : await settle(c, found) };
  };

  /**
   * The invited person's organization, from their own active memberships: never from the request.
   * `undefined` when they have none yet; `ambiguous` when there is more than one to choose from.
   */
  const organizationOf = async (
    auth: AuthenticatedContext,
  ): Promise<TenantContext | 'ambiguous' | undefined> => {
    const active = (await organizations.membershipsOfUser(auth.userId)).filter(
      (m) => m.status === 'active' && m.userId === auth.userId,
    );
    if (active.length > 1) return 'ambiguous';
    const [only] = active;
    if (only === undefined) return undefined;
    try {
      return await resolveTenant(auth, only.organizationId, organizations);
    } catch (error) {
      if (isTenancyError(error)) return undefined;
      throw error;
    }
  };

  const canDecide = (tenant: TenantContext) =>
    tenant.actor === 'user' && authorization.authorize(tenant, 'relationship.manage').allowed;

  /** A refusal to the person holding the link, audited. */
  const refuse = async (
    c: Context<AuthEnv>,
    action: 'customer_invitation.accepted' | 'customer_invitation.rejected',
    invitation: CustomerInvitation,
    reason: 'not_invited_person' | 'email_not_verified' | 'invitation_not_pending',
  ) => {
    await recordOutcome(c, audit, {
      action,
      result: 'denied',
      actor: actorOf(c.get('auth')),
      commercialAccountId: invitation.commercialAccountId,
      target: { type: 'customer_invitation', id: invitation.id },
      reason,
      ...requestFields(c),
    });
    return reason === 'invitation_not_pending'
      ? c.json({ error: reason, status: invitation.status }, 409)
      : c.json({ error: reason === 'email_not_verified' ? reason : 'invitation_forbidden' }, 403);
  };

  /** Whether this person may act on this invitation: its person, with that email verified. */
  const personCheck = (auth: AuthenticatedContext, invitation: CustomerInvitation) => {
    if (isInvitedPerson(auth, invitation)) return undefined;
    const sameEmail =
      auth.actor === 'user' && auth.email?.trim().toLowerCase() === invitation.email;
    return sameEmail && !auth.emailVerified ? 'email_not_verified' : 'not_invited_person';
  };

  // What the link offers: who invites, for what, and whether this person can take it.
  app.post('/v1/invitations/lookup', async (c) => {
    const auth = c.get('auth');
    const { invitation } = await byToken(c);
    if (invitation === undefined) return c.json({ error: 'invitation_not_found' }, 404);
    const account = await commercial.findAccount(invitation.commercialAccountId);
    const blocked = personCheck(auth, invitation);
    const tenant = blocked === undefined ? await organizationOf(auth) : undefined;
    return c.json({
      invitation: {
        account: account === undefined ? null : { name: account.name, type: account.type },
        mode: invitation.mode,
        scopes: invitation.scopes,
        status: invitation.status,
        expiresAt: invitation.expiresAt,
        updatedAt: invitation.updatedAt,
      },
      person: blocked ?? 'invited',
      organization:
        tenant === undefined
          ? null
          : tenant === 'ambiguous'
            ? 'ambiguous'
            : { id: tenant.organizationId, canDecide: canDecide(tenant) },
    });
  });

  app.post('/v1/invitations/accept', async (c) => {
    const auth = c.get('auth');
    const { input, invitation } = await byToken(c);
    if (invitation === undefined) return c.json({ error: 'invitation_not_found' }, 404);
    const blocked = personCheck(auth, invitation);
    if (blocked !== undefined) {
      return refuse(c, 'customer_invitation.accepted', invitation, blocked);
    }
    if (invitation.status !== 'pending') {
      return refuse(c, 'customer_invitation.accepted', invitation, 'invitation_not_pending');
    }
    if (input.expectedUpdatedAt !== invitation.updatedAt) {
      return c.json({ error: 'commercial_conflict' }, 409);
    }
    const tenant = await organizationOf(auth);
    if (tenant === undefined) return c.json({ error: 'organization_required' }, 409);
    if (tenant === 'ambiguous') return c.json({ error: 'organization_ambiguous' }, 409);

    const account = await commercial.findAccount(invitation.commercialAccountId);
    if (account?.status !== 'active') {
      return refuse(c, 'customer_invitation.accepted', invitation, 'invitation_not_pending');
    }
    const current = await commercial.findRelationship(
      invitation.commercialAccountId,
      tenant.organizationId,
    );
    if (current !== undefined && current.status !== 'ended') {
      return c.json({ error: 'relationship_exists' }, 409);
    }

    // Someone who can decide grants exactly what they tick, never more than was asked for, none
    // by default. Anyone else takes it for their owner, who decides later.
    const decides = canDecide(tenant);
    let scopes = invitation.scopes;
    if (decides) {
      try {
        scopes = parseCustomerScopes(input.scopes ?? []);
      } catch {
        return bad(c, 'scopes');
      }
      if (!scopes.every((s) => invitation.scopes.includes(s))) return bad(c, 'scopes');
    }

    const at = now();
    const iso = at.toISOString() as IsoTimestamp;
    const relationship: CustomerRelationship = {
      id: customerRelationshipIdOf(invitation.commercialAccountId, tenant.organizationId),
      commercialAccountId: invitation.commercialAccountId,
      organizationId: tenant.organizationId,
      mode: invitation.mode,
      status: decides ? 'active' : 'pending',
      scopes,
      ...(invitation.billing === undefined ? {} : { billing: invitation.billing }),
      ...(decides ? { acceptedBy: tenant.userId } : {}),
      createdAt: iso,
      updatedAt: iso,
    };
    const accepted: CustomerInvitation = {
      ...invitation,
      status: 'accepted',
      decidedBy: tenant.userId,
      organizationId: tenant.organizationId,
      updatedAt: iso,
    };
    const common = {
      result: 'success' as const,
      actor: actorOf(tenant),
      organizationId: tenant.organizationId,
      commercialAccountId: invitation.commercialAccountId,
      ...requestFields(c),
    };
    const limit = account.limits?.customers;
    if (limit === undefined) return c.json({ error: 'commercial_limit_reached' }, 409);
    return guarded(c, async () => {
      await commercial.acceptInvitation(
        accepted,
        invitation,
        relationship,
        current,
        [
          event(
            {
              ...common,
              action: 'customer_invitation.accepted',
              target: { type: 'customer_invitation', id: invitation.id },
              transition: { from: 'pending', to: 'accepted' },
            },
            at,
          ),
          event(
            {
              ...common,
              action: 'customer_relationship.created',
              target: { type: 'customer_relationship', id: relationship.id },
              reference: relationship.mode,
            },
            at,
          ),
          ...(decides
            ? [
                event(
                  {
                    ...common,
                    action: 'customer_relationship.updated',
                    target: { type: 'customer_relationship', id: relationship.id },
                    transition: { from: 'pending', to: 'active' },
                  },
                  at,
                ),
              ]
            : []),
        ],
        limit,
      );
      return c.json({ relationship: relationshipView(relationship) });
    });
  });

  app.post('/v1/invitations/reject', async (c) => {
    const auth = c.get('auth');
    const { input, invitation } = await byToken(c);
    if (invitation === undefined) return c.json({ error: 'invitation_not_found' }, 404);
    const blocked = personCheck(auth, invitation);
    if (blocked !== undefined) {
      return refuse(c, 'customer_invitation.rejected', invitation, blocked);
    }
    if (invitation.status !== 'pending') {
      return refuse(c, 'customer_invitation.rejected', invitation, 'invitation_not_pending');
    }
    if (input.expectedUpdatedAt !== invitation.updatedAt) {
      return c.json({ error: 'commercial_conflict' }, 409);
    }
    const at = now();
    const rejected: CustomerInvitation = {
      ...invitation,
      status: 'rejected',
      decidedBy: auth.userId,
      updatedAt: at.toISOString() as IsoTimestamp,
    };
    return guarded(c, async () => {
      await commercial.saveInvitation(rejected, invitation, [
        event(
          {
            action: 'customer_invitation.rejected',
            result: 'success',
            actor: actorOf(auth),
            commercialAccountId: invitation.commercialAccountId,
            target: { type: 'customer_invitation', id: invitation.id },
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
