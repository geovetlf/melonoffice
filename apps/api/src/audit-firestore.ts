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
  readonly organizationId: string | null;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly requestedOrganizationId: string | null;
  readonly permission: string | null;
  readonly planId: string | null;
  readonly planVersion: number | null;
  readonly transitionFrom: string | null;
  readonly transitionTo: string | null;
  readonly reason: string | null;
  readonly requestId: string | null;
  readonly source: string;
}

export function toAuditDocument(event: AuditEvent): AuditDocument {
  const user = event.actor.type === 'user' ? event.actor : undefined;
  return {
    occurredAt: Timestamp.fromDate(new Date(event.occurredAt)),
    action: event.action,
    result: event.result,
    actorType: event.actor.type,
    actorUserId: user?.userId ?? null,
    actorVia: user?.via ?? null,
    organizationId: event.organizationId ?? null,
    targetType: event.target?.type ?? null,
    targetId: event.target?.id ?? null,
    requestedOrganizationId: event.requestedOrganizationId ?? null,
    permission: event.permission ?? null,
    planId: event.plan?.id ?? null,
    planVersion: event.plan?.version ?? null,
    transitionFrom: event.transition?.from ?? null,
    transitionTo: event.transition?.to ?? null,
    reason: event.reason ?? null,
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
