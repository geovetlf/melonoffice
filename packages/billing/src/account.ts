import type {
  InitialBilling,
  IsoTimestamp,
  Organization,
  PlanRef,
  SubscriptionId,
} from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';
import { BillingError } from './errors.js';
import { isPlanRef } from './lifecycle.js';

/**
 * The billing a new organization starts with (ADR-0022): its account and a first, `active`
 * subscription on `plan`. It is written in the same transaction as the organization, and the
 * account's id is the organization's, so an organization can never get two accounts.
 *
 * The plan comes from the server (today the default plan, ADR-0021), never from the client. No
 * trial and no payment is involved: no provider exists yet.
 */
export function openBilling(organization: Organization, plan: PlanRef): InitialBilling {
  if (!isPlanRef(plan)) throw new BillingError('invalid_plan');
  const at: IsoTimestamp = organization.createdAt;
  const subscriptionId = randomUUID() as SubscriptionId;
  return Object.freeze({
    account: Object.freeze({
      organizationId: organization.id,
      subscriptionId,
      createdAt: at,
      updatedAt: at,
    }),
    subscription: Object.freeze({
      id: subscriptionId,
      organizationId: organization.id,
      plan: Object.freeze({ id: plan.id, version: plan.version }),
      status: 'active',
      createdAt: at,
      updatedAt: at,
    }),
  });
}
