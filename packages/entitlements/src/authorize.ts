import type { OrganizationId, UserId } from '@melonoffice/domain';
import { checkLimit, checkScopedLimit } from './limits.js';
import {
  kindOf,
  type FeatureKey,
  type LimitKey,
  type LimitMapKey,
  type ListKey,
} from './registry.js';
import type { EffectiveEntitlements } from './resolve.js';

/**
 * Who is acting. GIA and specialists always act for a user and carry that
 * user's permissions, never their own (no parallel authority path, D-25).
 */
export interface Principal {
  readonly kind: 'user' | 'gia' | 'specialist';
  readonly orgId: OrganizationId;
  /** The human user, or the user GIA or the specialist is acting for. */
  readonly userId: UserId;
  /** Permissions of that user's role in this organization, resolved by the caller. */
  readonly permissions: ReadonlySet<string>;
}

/** What an action requires. Every requirement listed must hold. */
export interface ActionDefinition {
  readonly id: string;
  /** The role permission the user needs. */
  readonly permission: string;
  /** A feature the organization must be entitled to. */
  readonly feature?: FeatureKey;
  /** A release flag that must be on. */
  readonly releaseFlag?: string;
  /** A list entitlement that must contain the request's `listItem` (for example a department type). */
  readonly list?: ListKey;
  /** A limit the request's `usage` must stay under. A per-scope limit also needs `scope`. */
  readonly limit?: LimitKey | LimitMapKey;
  /** The action changes plans, entitlements, limits or permissions. Only a user may run it, never GIA or a specialist. */
  readonly governance?: boolean;
}

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly action: ActionDefinition;
  readonly entitlements: EffectiveEntitlements;
  readonly releaseFlags: ReadonlySet<string>;
  /** Current usage of the action's limit, read in the same transaction as the write. */
  readonly usage?: number;
  /** Units the action would add. Defaults to 1. */
  readonly requested?: number;
  readonly scope?: string;
  readonly listItem?: string;
}

export type DenyReason =
  | 'cross_tenant'
  | 'governance_requires_user'
  | 'missing_permission'
  | 'not_entitled'
  | 'not_released'
  | 'not_in_allowed_list'
  | 'usage_unknown'
  | 'limit_reached';

export type AuthorizationDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: DenyReason };

const isCount = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value >= 0;

const deny = (reason: DenyReason): AuthorizationDecision => ({ allowed: false, reason });

/**
 * The single authorization check (plan §10, §11A.2): role permission ∧
 * feature entitled ∧ release flag on ∧ within limit. It denies whenever a
 * requirement cannot be proven, including missing usage or scope.
 */
export function authorize(request: AuthorizationRequest): AuthorizationDecision {
  const { principal, action, entitlements } = request;
  const values = entitlements.values;

  if (principal.orgId !== entitlements.orgId) return deny('cross_tenant');
  if (action.governance === true && principal.kind !== 'user') {
    return deny('governance_requires_user');
  }
  if (!principal.permissions.has(action.permission)) return deny('missing_permission');
  if (action.feature !== undefined && !values[action.feature]) return deny('not_entitled');
  if (action.releaseFlag !== undefined && !request.releaseFlags.has(action.releaseFlag)) {
    return deny('not_released');
  }
  if (action.list !== undefined) {
    if (request.listItem === undefined || !values[action.list].includes(request.listItem)) {
      return deny('not_in_allowed_list');
    }
  }
  if (action.limit !== undefined) {
    const requested = request.requested ?? 1;
    if (!isCount(request.usage) || !isCount(requested) || requested < 1) {
      return deny('usage_unknown');
    }
    let result;
    if (kindOf(action.limit) === 'limitMap') {
      if (request.scope === undefined) return deny('usage_unknown');
      result = checkScopedLimit(
        entitlements,
        action.limit as LimitMapKey,
        request.scope,
        request.usage,
        requested,
      );
    } else {
      result = checkLimit(entitlements, action.limit as LimitKey, request.usage, requested);
    }
    if (!result.allowed) return deny('limit_reached');
  }
  return { allowed: true };
}
