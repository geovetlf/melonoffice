import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent, AuditStore } from '@melonoffice/audit';

/** `auditLogs/{eventId}` (ADR-0020). Written only by the API, only with `create`. */
export const AUDIT_LOGS = 'auditLogs';

/**
 * The stored shape: flat, so organization, actor, action and time can be queried directly.
 * Absent values are stored as null, so every document has the same fields.
 */
export interface AuditDocument {
  readonly occurredAt: FirestoreTimestamp;
  readonly action: string;
  readonly result: string;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly actorVia: string | null;
  /** For the system actor: which one (`runtime`, ADR-0029). */
  readonly actorId: string | null;
  /** For the system actor: the user who started the work it did. */
  readonly actorInitiatedBy: string | null;
  readonly organizationId: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly targetVersion: number | null;
  readonly requestedOrganizationId: string | null;
  readonly permission: string | null;
  readonly planId: string | null;
  readonly planVersion: number | null;
  readonly transitionFrom: string | null;
  readonly transitionTo: string | null;
  readonly toolId: string | null;
  readonly toolVersion: number | null;
  /** The job of an `execution.job_*` event (ADR-0030). */
  readonly jobId?: string | null;
  readonly jobNodeId?: string | null;
  readonly jobAttempt?: number | null;
  readonly jobLeaseId?: string | null;
  /** The node of an `execution.node_changed` or runtime node event (ADR-0031). */
  readonly nodeId?: string | null;
  /** The provider call of a `channel.delivery_*` event (ADR-0045). */
  readonly attempt?: number | null;
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly previousModelProvider: string | null;
  readonly previousModelId: string | null;
  readonly reason: string | null;
  readonly reference: string | null;
  readonly requestId: string | null;
  readonly source: string;
}

export function toAuditDocument(event: AuditEvent): AuditDocument {
  const user = event.actor.type === 'user' ? event.actor : undefined;
  const system = event.actor.type === 'system' ? event.actor : undefined;
  return {
    occurredAt: Timestamp.fromDate(new Date(event.occurredAt)),
    action: event.action,
    result: event.result,
    actorType: event.actor.type,
    actorUserId: user?.userId ?? null,
    actorVia: user?.via ?? system?.via ?? null,
    actorId: system?.id ?? null,
    actorInitiatedBy: system?.initiatedBy ?? null,
    organizationId: event.organizationId ?? null,
    targetType: event.target?.type ?? null,
    targetId: event.target?.id ?? null,
    targetVersion: event.targetVersion ?? null,
    requestedOrganizationId: event.requestedOrganizationId ?? null,
    permission: event.permission ?? null,
    planId: event.plan?.id ?? null,
    planVersion: event.plan?.version ?? null,
    transitionFrom: event.transition?.from ?? null,
    transitionTo: event.transition?.to ?? null,
    toolId: event.tool?.id ?? null,
    toolVersion: event.tool?.version ?? null,
    jobId: event.job?.id ?? null,
    jobNodeId: event.job?.nodeId ?? null,
    jobAttempt: event.job?.attempt ?? null,
    jobLeaseId: event.job?.leaseId ?? null,
    nodeId: event.nodeId ?? null,
    attempt: event.attempt ?? null,
    modelProvider: event.model?.provider ?? null,
    modelId: event.model?.id ?? null,
    previousModelProvider: event.previousModel?.provider ?? null,
    previousModelId: event.previousModel?.id ?? null,
    reason: event.reason ?? null,
    reference: event.reference ?? null,
    requestId: event.requestId ?? null,
    source: event.source,
  };
}

/**
 * Audit events in Firestore. Only `append` exists, and it uses `create`, which fails if the
 * document already exists, so a recorded event is never overwritten. A batch writes all or none.
 */
export class FirestoreAuditStore implements AuditStore {
  constructor(private readonly db: Firestore) {}

  async append(events: readonly AuditEvent[]): Promise<void> {
    const batch = this.db.batch();
    for (const event of events) {
      batch.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
    await batch.commit();
  }
}

/** Reads a stored event back as the event it records, for reconstruction and tests. */
export function fromAuditDocument(id: string, d: AuditDocument): AuditEvent {
  return {
    id,
    occurredAt: d.occurredAt.toDate().toISOString(),
    action: d.action,
    result: d.result,
    actor:
      d.actorType === 'user'
        ? { type: 'user', userId: d.actorUserId, via: d.actorVia }
        : d.actorType === 'system'
          ? { type: 'system', id: d.actorId, initiatedBy: d.actorInitiatedBy, via: d.actorVia }
          : { type: d.actorType },
    ...(d.organizationId === null ? {} : { organizationId: d.organizationId }),
    ...(d.targetType === null ? {} : { target: { type: d.targetType, id: d.targetId } }),
    ...(d.targetVersion == null ? {} : { targetVersion: d.targetVersion }),
    ...(d.requestedOrganizationId === null
      ? {}
      : { requestedOrganizationId: d.requestedOrganizationId }),
    ...(d.permission === null ? {} : { permission: d.permission }),
    ...(d.planId === null ? {} : { plan: { id: d.planId, version: d.planVersion } }),
    ...(d.transitionFrom === null
      ? {}
      : { transition: { from: d.transitionFrom, to: d.transitionTo } }),
    ...(d.toolId == null ? {} : { tool: { id: d.toolId, version: d.toolVersion } }),
    ...(d.jobId == null
      ? {}
      : {
          job: {
            id: d.jobId,
            nodeId: d.jobNodeId,
            attempt: d.jobAttempt,
            ...(d.jobLeaseId == null ? {} : { leaseId: d.jobLeaseId }),
          },
        }),
    ...(d.nodeId == null ? {} : { nodeId: d.nodeId }),
    ...(d.attempt == null ? {} : { attempt: d.attempt }),
    ...(d.modelId == null ? {} : { model: { provider: d.modelProvider, id: d.modelId } }),
    ...(d.previousModelId == null
      ? {}
      : { previousModel: { provider: d.previousModelProvider, id: d.previousModelId } }),
    ...(d.reason === null ? {} : { reason: d.reason }),
    ...(d.reference === null ? {} : { reference: d.reference }),
    ...(d.requestId === null ? {} : { requestId: d.requestId }),
    source: d.source,
  } as unknown as AuditEvent;
}
