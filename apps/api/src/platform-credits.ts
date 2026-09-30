import { actorOf, type AuditService } from '@melonoffice/audit';
import {
  isCreditAmount,
  isCreditsError,
  type CreditService,
  type CreditStore,
} from '@melonoffice/credits';
import type { OrganizationId } from '@melonoffice/domain';
import { isOrganizationId, type TenancyStore } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import { recordOutcome, recordRequired, requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';
import { platformAdminOf } from './platform-admin.js';

/**
 * Manual credit grants by the MelonOffice platform administrator (ADR-0091), for selling by hand
 * before a payment provider exists: the credits are paid for outside MelonOffice and added here.
 *
 * A grant is not AI consumption: it goes through the one Credits engine's `grant`, on the same
 * wallet and ledger (a `grant` entry, never a `consume`), and later AI use spends it as usual.
 * There is no second wallet, balance or credits system, and no price: the administrator types the
 * number of credits.
 *
 * Retries are safe: the browser sends an idempotency key (a UUID it makes once per grant form), and
 * the ledger entry's id is derived from the organization and that key, so a double click, a refresh
 * or a network retry replays the first grant and moves nothing. The same key with a different
 * amount or reason is refused.
 */

/** Why the administrator adds credits: codes, never free text, so nothing personal is stored. */
export const PLATFORM_GRANT_REASONS = [
  'manual_purchase',
  'courtesy',
  'support_compensation',
  'testing',
] as const;
export type PlatformGrantReason = (typeof PLATFORM_GRANT_REASONS)[number];

const isGrantReason = (value: unknown): value is PlatformGrantReason =>
  (PLATFORM_GRANT_REASONS as readonly unknown[]).includes(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The ledger reference of a platform grant: its own namespace, so it never meets another. */
export const platformGrantReference = (idempotencyKey: string) =>
  `platform-grant:${idempotencyKey}`;

export interface PlatformCreditDependencies {
  readonly admins: ReadonlySet<string>;
  readonly audit: AuditService;
  readonly credits: CreditService;
  /** Only to read the balance shown before the administrator confirms. */
  readonly wallets: Pick<CreditStore, 'findWallet'>;
  readonly organizations: TenancyStore;
}

export function registerPlatformCreditRoutes(
  app: Hono<AuthEnv>,
  deps: PlatformCreditDependencies,
): void {
  const { admins, audit, credits, wallets, organizations } = deps;

  const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
    const value: unknown = await c.req.json().catch(() => undefined);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };

  // The organization the administrator is about to credit: its name, status and balance, so the
  // confirmation names the right company. Audited, like every platform read.
  app.get('/v1/platform/organizations/:organizationId', async (c) => {
    const admin = await platformAdminOf(c, admins, { audit, action: 'platform.organization_read' });
    if (admin instanceof Response) return admin;
    const id = c.req.param('organizationId');
    const organization = isOrganizationId(id)
      ? await organizations.findOrganization(id)
      : undefined;
    if (organization === undefined) return c.json({ error: 'organization_not_found' }, 404);
    const unaudited = await recordRequired(c, audit, {
      action: 'platform.organization_read',
      result: 'success',
      actor: actorOf(c.get('auth')),
      actorRole: admin.role,
      organizationId: organization.id,
      target: { type: 'organization', id: organization.id },
      ...requestFields(c),
    });
    if (unaudited) return unaudited;
    const wallet = await wallets.findWallet(organization.id);
    return c.json({
      organization: { id: organization.id, name: organization.name, status: organization.status },
      credits:
        wallet === undefined ? null : { balance: wallet.balance, updatedAt: wallet.updatedAt },
    });
  });

  app.post('/v1/platform/organizations/:organizationId/credit-grants', async (c) => {
    const admin = await platformAdminOf(c, admins, { audit, action: 'credits.platform_grant' });
    if (admin instanceof Response) return admin;
    const auth = c.get('auth');
    const requested = c.req.param('organizationId') ?? '';
    const input = await body(c);
    const refuse = async (
      status: 400 | 404 | 409,
      error: string,
      field?: 'amount' | 'reason' | 'idempotencyKey',
    ) => {
      await recordOutcome(c, audit, {
        action: 'credits.platform_grant',
        result: 'denied',
        actor: actorOf(auth),
        actorRole: admin.role,
        requestedOrganizationId: requested,
        reason:
          field === undefined
            ? error
            : `invalid_${field === 'idempotencyKey' ? 'idempotency_key' : field}`,
        ...(typeof input.idempotencyKey === 'string' && UUID.test(input.idempotencyKey)
          ? { reference: platformGrantReference(input.idempotencyKey) }
          : {}),
        ...requestFields(c),
      });
      return c.json({ error, ...(field === undefined ? {} : { field }) }, status);
    };

    if (typeof input.idempotencyKey !== 'string' || !UUID.test(input.idempotencyKey)) {
      return refuse(400, 'invalid_credit_grant', 'idempotencyKey');
    }
    if (!isCreditAmount(input.amount)) return refuse(400, 'invalid_credit_grant', 'amount');
    if (!isGrantReason(input.reason)) return refuse(400, 'invalid_credit_grant', 'reason');
    if (!isOrganizationId(requested)) return refuse(404, 'organization_not_found');
    const idempotencyKey = input.idempotencyKey;
    const reason = input.reason;

    let result;
    try {
      result = await credits.grantAsPlatform(admin, requested as OrganizationId, {
        amount: input.amount,
        referenceId: platformGrantReference(idempotencyKey),
        reason,
      });
    } catch (error) {
      if (!isCreditsError(error)) throw error;
      switch (error.code) {
        case 'organization_inactive':
          return refuse(404, 'organization_not_found');
        case 'credits_reference_conflict':
          // The key was already used for a different grant: nothing moves.
          return refuse(409, 'idempotency_key_reused');
        case 'credits_wallet_missing':
          return refuse(409, 'credits_wallet_missing');
        case 'credits_balance_limit':
          return refuse(409, 'credits_balance_limit');
        default:
          await recordOutcome(c, audit, {
            action: 'credits.platform_grant',
            result: 'failure',
            actor: actorOf(auth),
            actorRole: admin.role,
            requestedOrganizationId: requested,
            reason: error.code,
            reference: platformGrantReference(idempotencyKey),
            ...requestFields(c),
          });
          return c.json({ error: 'credit_grant_failed' }, 500);
      }
    }
    const { entry } = result;
    return c.json(
      {
        grant: {
          id: entry.id,
          organizationId: entry.organizationId,
          amount: entry.amount,
          reason: entry.reason,
          idempotencyKey,
          balanceAfter: entry.balanceAfter,
          createdAt: entry.createdAt,
        },
        // A replay answers the first grant, not the wallet now; `balance` is the wallet after it.
        balance: result.balance,
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201,
    );
  });
}
