import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';
import { AUDIT_ACTIONS, isAuditAction, type AuditAction } from './actions.js';

export type AuditEventId = string & { readonly __brand: 'AuditEventId' };

/**
 * - `success`: the action was allowed and completed.
 * - `denied`: tenancy, RBAC or a policy (such as the one-organization limit) refused it.
 * - `failure`: it was allowed but failed technically (for example, storage was unavailable).
 *
 * A failed authentication is none of these: it is not recorded (ADR-0020).
 */
export type AuditResult = 'success' | 'denied' | 'failure';

/**
 * Who acted. Only `user` is recorded today; `system` and `anonymous` exist in the model for
 * future events and are not produced by any code yet.
 */
export type AuditActor =
  | {
      readonly type: 'user';
      readonly userId: UserId;
      /** `gia` when GIA acted for the user. The user stays the actor; GIA is only the channel. */
      readonly via: 'direct' | 'gia';
    }
  | { readonly type: 'system' | 'anonymous' };

export interface AuditTarget {
  readonly type: 'user' | 'organization' | 'membership' | 'subscription';
  readonly id: string;
}

/** A plan reference as recorded: which plan and which exact version. */
export interface AuditPlan {
  readonly id: string;
  readonly version: number;
}

/** The component that recorded the event. */
export type AuditSource = 'api';

/**
 * One fact, built on the server from verified context only. There is deliberately no free-form
 * metadata: every field is structured and checked.
 */
export interface AuditEvent {
  readonly id: AuditEventId;
  readonly occurredAt: IsoTimestamp;
  readonly action: AuditAction;
  readonly result: AuditResult;
  readonly actor: AuditActor;
  /** The organization the actor was authorized to act in, from a resolved tenant. Never client input. */
  readonly organizationId?: OrganizationId;
  readonly target?: AuditTarget;
  /**
   * The organization the client asked for, kept apart from `organizationId` because it is
   * untrusted. Only recorded when well-formed; it never means the actor had access to it.
   */
  readonly requestedOrganizationId?: string;
  /** The permission RBAC checked, for `authorization.check`. */
  readonly permission?: string;
  /** The plan assigned, for `plan.assign` (ADR-0021) and `billing.subscription_created` (ADR-0022). */
  readonly plan?: AuditPlan;
  /** A stable code saying why, for `denied` and `failure` (an error code, never a message). */
  readonly reason?: string;
  readonly requestId?: string;
  readonly source: AuditSource;
}

export type AuditEventInput = Omit<AuditEvent, 'id' | 'occurredAt'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z_]{0,63}$/;
const PERMISSION = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const REQUEST_ID = /^[\w-]{1,128}$/;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Builds an event, checking every field so nothing unexpected reaches storage. Untrusted parts
 * (the requested organization, the request id) are dropped when malformed instead of stored.
 * Throws on a programming error: an unknown action or a result the action does not allow.
 */
export function buildAuditEvent(input: AuditEventInput, at: Date): AuditEvent {
  if (!isAuditAction(input.action)) throw new Error(`unknown audit action ${String(input.action)}`);
  const allowed: readonly AuditResult[] = AUDIT_ACTIONS[input.action].results;
  if (!allowed.includes(input.result)) {
    throw new Error(`audit action ${input.action} cannot be ${input.result}`);
  }
  if (input.reason !== undefined && !CODE.test(input.reason))
    throw new Error('invalid audit reason');
  if (input.permission !== undefined && !PERMISSION.test(input.permission)) {
    throw new Error('invalid audit permission');
  }
  if (
    input.plan !== undefined &&
    (!PLAN_ID.test(input.plan.id) ||
      !Number.isInteger(input.plan.version) ||
      input.plan.version < 1)
  ) {
    throw new Error('invalid audit plan');
  }
  const actor: AuditActor =
    input.actor.type === 'user'
      ? Object.freeze({ type: 'user', userId: input.actor.userId, via: input.actor.via })
      : Object.freeze({ type: input.actor.type });
  const requested = input.requestedOrganizationId;
  return Object.freeze({
    id: randomUUID() as AuditEventId,
    occurredAt: at.toISOString() as IsoTimestamp,
    action: input.action,
    result: input.result,
    actor,
    ...(input.organizationId === undefined ? {} : { organizationId: input.organizationId }),
    ...(input.target === undefined
      ? {}
      : { target: Object.freeze({ type: input.target.type, id: input.target.id }) }),
    ...(requested !== undefined && UUID.test(requested)
      ? { requestedOrganizationId: requested }
      : {}),
    ...(input.permission === undefined ? {} : { permission: input.permission }),
    ...(input.plan === undefined
      ? {}
      : { plan: Object.freeze({ id: input.plan.id, version: input.plan.version }) }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.requestId !== undefined && REQUEST_ID.test(input.requestId)
      ? { requestId: input.requestId }
      : {}),
    source: input.source,
  });
}

/** The actor of an authenticated request: its verified user, and GIA as the channel if GIA acted. */
export function actorOf(auth: {
  readonly actor: 'user' | 'gia';
  readonly userId: UserId;
}): AuditActor {
  return Object.freeze({
    type: 'user',
    userId: auth.userId,
    via: auth.actor === 'gia' ? 'gia' : 'direct',
  });
}
