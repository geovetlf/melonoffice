import type { TenantContext } from '@melonoffice/tenancy';

/**
 * What the AI Gateway needs from the Credits engine (ADR-0023), and nothing more (ADR-0027).
 * The signatures are those of `CreditService`, so the engine plugs in as it is: the gateway
 * creates no second credits engine, ledger or wallet. Billing stays separate: it decides the
 * plan, never an AI call's consumption.
 */
export interface AICreditsPort {
  balanceOf(
    tenant: TenantContext,
  ): Promise<
    | { readonly status: 'present'; readonly balance: number }
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
}

/**
 * Where an AI call is in its accounting:
 *
 * - `estimated`: the most it can cost is known, before the call;
 * - `reserved`: the balance was checked to cover that estimate. The engine has no hold yet, so
 *   this is a check, not a hold; a real reservation extends the ledger later;
 * - `consumed`: the actual cost was spent from the wallet, once, by the request's id;
 * - `refunded`: given back after being consumed;
 * - `failed`: the call did not complete, or could not be charged; nothing was spent;
 * - `free`: it completed at zero cost.
 */
export type AICreditState = 'estimated' | 'reserved' | 'consumed' | 'refunded' | 'failed' | 'free';

/** The ledger reference of an AI call: the same request is charged once, whatever retries. */
export const creditReferenceOf = (requestId: string): string => `ai:${requestId}`;
