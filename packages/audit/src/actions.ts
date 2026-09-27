import type { AuditResult } from './event.js';

export interface AuditActionDefinition {
  readonly category: 'auth' | 'tenancy' | 'authorization' | 'entitlements' | 'billing' | 'credits';
  readonly description: string;
  /** The results this action is recorded with. Anything else is a programming error. */
  readonly results: readonly AuditResult[];
}

/**
 * Every auditable action, in one place (ADR-0020). Ids are `category.verb`, stable once used. An
 * action is added only when the code that performs it records it.
 */
export const AUDIT_ACTIONS = {
  'auth.register': {
    category: 'auth',
    description: 'A verified identity signed in for the first time and got an internal user.',
    results: ['success'],
  },
  'auth.sign_in': {
    category: 'auth',
    description: 'An existing user signed in (POST /v1/me).',
    results: ['success'],
  },
  'organization.create': {
    category: 'tenancy',
    description: 'A user created an organization, or was refused or failed trying.',
    results: ['success', 'denied', 'failure'],
  },
  'membership.create': {
    category: 'tenancy',
    description: 'A membership was created (today: the owner membership of a new organization).',
    results: ['success'],
  },
  'plan.assign': {
    category: 'entitlements',
    description: 'An organization was given a plan (today: its initial plan, when it is created).',
    results: ['success'],
  },
  'billing.subscription_created': {
    category: 'billing',
    description:
      "An organization's subscription was created (today: its first, with the organization).",
    results: ['success'],
  },
  'credits.grant': {
    category: 'credits',
    description: "Credits were added to an organization's wallet (ADR-0023).",
    results: ['success'],
  },
  'credits.consume': {
    category: 'credits',
    description: "Credits were spent from an organization's wallet.",
    results: ['success'],
  },
  'credits.refund': {
    category: 'credits',
    description: 'Credits were given back for an earlier consume.',
    results: ['success'],
  },
  'tenancy.resolve': {
    category: 'tenancy',
    description: 'A user asked to act in an organization and tenancy refused it.',
    results: ['denied'],
  },
  'authorization.check': {
    category: 'authorization',
    description: 'A member asked for an action and RBAC refused it.',
    results: ['denied'],
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const isAuditAction = (value: unknown): value is AuditAction =>
  typeof value === 'string' && Object.hasOwn(AUDIT_ACTIONS, value);
