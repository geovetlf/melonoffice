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
 * Who acted.
 *
 * - `user`: a person, directly or through GIA (the user stays the actor; GIA is only the channel).
 * - `system` `runtime`: the execution runtime (ADR-0029), always for the user who started the
 *   work (`initiatedBy`), so the chain user → runtime → operation → execution → organization is
 *   rebuilt from the event. It never stands for a human decision.
 * - `anonymous`: exists in the model only; nothing produces it.
 */
export type AuditActor =
  | {
      readonly type: 'user';
      readonly userId: UserId;
      /** `gia` when GIA acted for the user. The user stays the actor; GIA is only the channel. */
      readonly via: 'direct' | 'gia';
    }
  | {
      readonly type: 'system';
      readonly id: 'runtime';
      /** The user who started the work the runtime is doing. */
      readonly initiatedBy: UserId;
      readonly via: 'runtime';
    }
  | { readonly type: 'anonymous' };

export interface AuditTarget {
  readonly type:
    | 'user'
    | 'organization'
    | 'membership'
    | 'subscription'
    | 'credit_entry'
    | 'execution'
    | 'approval'
    | 'plan'
    | 'workflow';
  readonly id: string;
}

/** A plan reference as recorded: which plan and which exact version. */
export interface AuditPlan {
  readonly id: string;
  readonly version: number;
}

/** A status change, for `execution.state_changed` (ADR-0024): stable status codes only. */
export interface AuditTransition {
  readonly from: string;
  readonly to: string;
}

/** A tool version as recorded, for `tool.*` events (ADR-0026). Never its input or output. */
export interface AuditTool {
  readonly id: string;
  readonly version: number;
}

/**
 * An execution job as recorded, for `execution.job_*` events (ADR-0030): which unit of work and
 * which lease. Never an input or an output.
 */
export interface AuditJob {
  readonly id: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly leaseId?: string;
}

/** An AI model as recorded, for `ai.*` events (ADR-0027). Never a prompt or an output. */
export interface AuditModel {
  readonly provider: string;
  readonly id: string;
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
  /** The target's version the event is about, for `workflow.*` events (ADR-0028). */
  readonly targetVersion?: number;
  /**
   * The organization the client asked for, kept apart from `organizationId` because it is
   * untrusted. Only recorded when well-formed; it never means the actor had access to it.
   */
  readonly requestedOrganizationId?: string;
  /** The permission RBAC checked, for `authorization.check`. */
  readonly permission?: string;
  /** The plan assigned, for `plan.assign` (ADR-0021) and `billing.subscription_created` (ADR-0022). */
  readonly plan?: AuditPlan;
  /** The status change, for `execution.state_changed`. */
  readonly transition?: AuditTransition;
  /** The tool version, for `tool.*` events. */
  readonly tool?: AuditTool;
  /** The job, for `execution.job_*` events. */
  readonly job?: AuditJob;
  /** The model, for `ai.*` events. */
  readonly model?: AuditModel;
  /** The model that could not answer, for `ai.provider_fallback`. */
  readonly previousModel?: AuditModel;
  /**
   * A stable code saying why: for `denied` and `failure`, an error code; for a successful
   * change, its cause (for example why an execution was cancelled), or the operation's reason
   * code for a credits movement. Never a message.
   */
  readonly reason?: string;
  /** The caller's idempotency key of a credits operation (ADR-0023). The amounts stay in the ledger. */
  readonly reference?: string;
  readonly requestId?: string;
  readonly source: AuditSource;
}

export type AuditEventInput = Omit<AuditEvent, 'id' | 'occurredAt'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z_]{0,63}$/;
const PERMISSION = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const REQUEST_ID = /^[\w-]{1,128}$/;
const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const isAuditModel = (m: AuditModel): boolean =>
  PROVIDER_ID.test(m.provider) && MODEL_ID.test(m.id);
const JOB_NODE = /^[A-Za-z0-9_-]{1,64}$/;
const REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;

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
  if (input.reference !== undefined && !REFERENCE.test(input.reference)) {
    throw new Error('invalid audit reference');
  }
  if (
    input.transition !== undefined &&
    (!CODE.test(input.transition.from) || !CODE.test(input.transition.to))
  ) {
    throw new Error('invalid audit transition');
  }
  if (
    input.tool !== undefined &&
    (!TOOL_ID.test(input.tool.id) ||
      !Number.isSafeInteger(input.tool.version) ||
      input.tool.version < 1)
  ) {
    throw new Error('invalid audit tool');
  }
  if (
    (input.model !== undefined && !isAuditModel(input.model)) ||
    (input.previousModel !== undefined && !isAuditModel(input.previousModel))
  ) {
    throw new Error('invalid audit model');
  }
  if (
    input.targetVersion !== undefined &&
    (input.target === undefined ||
      !Number.isSafeInteger(input.targetVersion) ||
      input.targetVersion < 1)
  ) {
    throw new Error('invalid audit target version');
  }
  if (
    input.job !== undefined &&
    (!UUID.test(input.job.id) ||
      !JOB_NODE.test(input.job.nodeId) ||
      !Number.isSafeInteger(input.job.attempt) ||
      input.job.attempt < 1 ||
      (input.job.leaseId !== undefined && !UUID.test(input.job.leaseId)))
  ) {
    throw new Error('invalid audit job');
  }
  if (
    input.plan !== undefined &&
    (!PLAN_ID.test(input.plan.id) ||
      !Number.isInteger(input.plan.version) ||
      input.plan.version < 1)
  ) {
    throw new Error('invalid audit plan');
  }
  const actor: AuditActor = copyActor(input.actor);
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
    ...(input.targetVersion === undefined ? {} : { targetVersion: input.targetVersion }),
    ...(requested !== undefined && UUID.test(requested)
      ? { requestedOrganizationId: requested }
      : {}),
    ...(input.permission === undefined ? {} : { permission: input.permission }),
    ...(input.plan === undefined
      ? {}
      : { plan: Object.freeze({ id: input.plan.id, version: input.plan.version }) }),
    ...(input.transition === undefined
      ? {}
      : { transition: Object.freeze({ from: input.transition.from, to: input.transition.to }) }),
    ...(input.tool === undefined
      ? {}
      : { tool: Object.freeze({ id: input.tool.id, version: input.tool.version }) }),
    ...(input.job === undefined
      ? {}
      : {
          job: Object.freeze({
            id: input.job.id,
            nodeId: input.job.nodeId,
            attempt: input.job.attempt,
            ...(input.job.leaseId === undefined ? {} : { leaseId: input.job.leaseId }),
          }),
        }),
    ...(input.model === undefined
      ? {}
      : { model: Object.freeze({ provider: input.model.provider, id: input.model.id }) }),
    ...(input.previousModel === undefined
      ? {}
      : {
          previousModel: Object.freeze({
            provider: input.previousModel.provider,
            id: input.previousModel.id,
          }),
        }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.reference === undefined ? {} : { reference: input.reference }),
    ...(input.requestId !== undefined && REQUEST_ID.test(input.requestId)
      ? { requestId: input.requestId }
      : {}),
    source: input.source,
  });
}

const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A checked copy with only the actor's own fields. A malformed actor is a programming error. */
function copyActor(actor: AuditActor): AuditActor {
  switch (actor.type) {
    case 'user':
      if (actor.via !== 'direct' && actor.via !== 'gia') throw new Error('invalid audit actor');
      return Object.freeze({ type: 'user', userId: actor.userId, via: actor.via });
    case 'system':
      if (actor.id !== 'runtime' || actor.via !== 'runtime' || !USER_ID.test(actor.initiatedBy)) {
        throw new Error('invalid audit actor');
      }
      return Object.freeze({
        type: 'system',
        id: 'runtime',
        initiatedBy: actor.initiatedBy,
        via: 'runtime',
      });
    case 'anonymous':
      return Object.freeze({ type: 'anonymous' });
    default:
      throw new Error('invalid audit actor');
  }
}

/**
 * The actor of a request or a tenant: the verified user, with GIA as the channel if GIA acted;
 * or, for the runtime (ADR-0029), the system actor `runtime` initiated by that user. A runtime
 * action is never recorded as the user's own.
 */
export function actorOf(auth: {
  readonly actor: 'user' | 'gia' | 'runtime';
  readonly userId: UserId;
}): AuditActor {
  if (auth.actor === 'runtime') {
    return Object.freeze({
      type: 'system',
      id: 'runtime',
      initiatedBy: auth.userId,
      via: 'runtime',
    });
  }
  return Object.freeze({
    type: 'user',
    userId: auth.userId,
    via: auth.actor === 'gia' ? 'gia' : 'direct',
  });
}
