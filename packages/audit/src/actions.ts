import type { AuditResult } from './event.js';

export interface AuditActionDefinition {
  readonly category:
    | 'auth'
    | 'tenancy'
    | 'authorization'
    | 'entitlements'
    | 'billing'
    | 'credits'
    | 'execution'
    | 'tool'
    | 'ai';
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
  'execution.created': {
    category: 'execution',
    description: 'An execution was created for an organization (ADR-0024).',
    results: ['success'],
  },
  'execution.state_changed': {
    category: 'execution',
    description: "An execution's status changed; the event records from and to (ADR-0024).",
    results: ['success'],
  },
  'tool.authorization_checked': {
    category: 'tool',
    description:
      'The tool gate checked whether a tool may run for an execution node: allowed or denied, with the reason (ADR-0026).',
    results: ['success', 'denied'],
  },
  'tool.execution_requested': {
    category: 'tool',
    description: 'An execution node asked to run a tool version (ADR-0026).',
    results: ['success'],
  },
  'tool.execution_denied': {
    category: 'tool',
    description: 'A tool did not run because a guardrail or its approval refused it (ADR-0026).',
    results: ['denied'],
  },
  'tool.execution_completed': {
    category: 'tool',
    description: 'A tool ran and its output passed the post-execution guardrails (ADR-0026).',
    results: ['success'],
  },
  'tool.execution_failed': {
    category: 'tool',
    description:
      'A tool ran and failed, timed out, or its output was rejected by the post-execution guardrails (ADR-0026).',
    results: ['failure'],
  },
  'tool.approval_requested': {
    category: 'tool',
    description: 'A tool call needs a human approval, and one was requested (ADR-0026).',
    results: ['success'],
  },
  'tool.approval_approved': {
    category: 'tool',
    description: 'A user approved a pending tool approval, or was refused trying (ADR-0026).',
    results: ['success', 'denied'],
  },
  'tool.approval_rejected': {
    category: 'tool',
    description: 'A user rejected a pending tool approval, or was refused trying (ADR-0026).',
    results: ['success', 'denied'],
  },
  'tool.approval_expired': {
    category: 'tool',
    description: 'A pending tool approval ran out of time (ADR-0026).',
    results: ['success'],
  },
  'tool.approval_cancelled': {
    category: 'tool',
    description:
      'A pending tool approval was withdrawn, e.g. because its execution ended (ADR-0026).',
    results: ['success'],
  },
  'ai.request_denied': {
    category: 'ai',
    description:
      'The AI Gateway refused a call before any provider saw it: validation, authorization, policy, routing or credits (ADR-0027).',
    results: ['denied'],
  },
  'ai.provider_fallback': {
    category: 'ai',
    description:
      'The chosen model could not serve an AI call and the policy let another compatible model answer (ADR-0027).',
    results: ['success'],
  },
  'ai.request_failed': {
    category: 'ai',
    description:
      'An AI call reached a provider and did not complete: provider error, invalid response or charge failure (ADR-0027).',
    results: ['failure'],
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
