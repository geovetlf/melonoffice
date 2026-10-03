import type { TenantContext } from '@melonoffice/tenancy';

/**
 * What the AI Gateway needs from the Credits engine (ADR-0023), and nothing more (ADR-0027).
 * The signatures are those of `CreditService`, so the engine plugs in as it is: the gateway
 * creates no second credits engine, ledger or wallet. Billing stays separate: it decides the
 * plan, never an AI call's consumption.
 */
export interface AICreditsPort {
  balanceOf(tenant: TenantContext): Promise<
    | {
        readonly status: 'present';
        readonly balance: number;
        /** The balance less what is held for running operations (ADR-0123). */
        readonly available?: number;
      }
    | { readonly status: 'unavailable'; readonly reason: string }
  >;
  /** Idempotent by `referenceId`; refuses rather than going below zero. */
  consume(
    tenant: TenantContext,
    request: { readonly amount: number; readonly referenceId: string; readonly reason: string },
  ): Promise<{ readonly balance: number; readonly replayed: boolean }>;
  refund(
    tenant: TenantContext,
    request: {
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
      readonly refundOf: string;
    },
  ): Promise<{ readonly balance: number; readonly replayed: boolean }>;
  /**
   * Holds, settle and release (ADR-0123). The Credits engine has them; with them, a call holds
   * its most expensive candidate before the provider is called, and settles its real cost after.
   */
  hold?(
    tenant: TenantContext,
    request: {
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
      readonly ttlMs: number;
    },
  ): Promise<{ readonly balance: number; readonly replayed: boolean }>;
  settle?(
    tenant: TenantContext,
    request: { readonly holdOf: string; readonly amount: number; readonly reason: string },
  ): Promise<{ readonly balance: number; readonly replayed: boolean }>;
  release?(
    tenant: TenantContext,
    request: { readonly holdOf: string; readonly reason: string },
  ): Promise<{ readonly balance: number; readonly replayed: boolean }>;
}

/**
 * How long an AI call's hold lasts if the call never settles it (a crashed worker): well past
 * any call's deadline and retries, short enough not to block a wallet for long.
 */
export const AI_HOLD_TTL_MS = 30 * 60 * 1000;

/**
 * Where an AI call is in its accounting:
 *
 * - `estimated`: the most it can cost is known, before the call;
 * - `reserved`: the estimate is held in the wallet (ADR-0123), so no other operation can spend it;
 *   with a port that has no holds, the balance was only checked;
 * - `consumed`: the actual cost was spent from the wallet, once, by the request's id;
 * - `refunded`: given back after being consumed;
 * - `failed`: the call did not complete, or could not be charged; nothing was spent;
 * - `free`: it completed at zero cost.
 */
export type AICreditState = 'estimated' | 'reserved' | 'consumed' | 'refunded' | 'failed' | 'free';

/** The ledger reference of an AI call: the same request is charged once, whatever retries. */
export const creditReferenceOf = (requestId: string): string => `ai:${requestId}`;
