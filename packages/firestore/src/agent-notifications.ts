import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { FieldPath, Timestamp } from '@google-cloud/firestore';
import { AGENT_NOTIFICATION_KINDS, type AgentNotificationRepository } from '@melonoffice/agents';
import type {
  AgentNotification,
  AgentNotificationKind,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';

/**
 * `agentNotifications/{id}` (ADR-0117): one in-app notice to one person. The id starts with the
 * inverted time, so the person's notices are read newest first by equality on the organization and
 * the person, ordered by document id: Firestore's single-field indexes serve it, no composite
 * index. Unread ones add equality on `read`. Written only by the API and the worker.
 */
export const AGENT_NOTIFICATIONS = 'agentNotifications';

export interface AgentNotificationDocument {
  readonly organizationId: string;
  readonly recipientId: string;
  readonly kind: string;
  readonly specialistId: string;
  readonly taskId: string;
  readonly code: string | null;
  readonly otherSpecialistId: string | null;
  readonly read: boolean;
  readonly createdAt: FirestoreTimestamp;
  readonly readAt: FirestoreTimestamp | null;
  readonly expiresAt: FirestoreTimestamp;
}

const at = (iso: string) => Timestamp.fromDate(new Date(iso));
const iso = (t: FirestoreTimestamp) => t.toDate().toISOString() as IsoTimestamp;

function toDocument(n: AgentNotification): AgentNotificationDocument {
  return {
    organizationId: n.organizationId,
    recipientId: n.recipientId,
    kind: n.kind,
    specialistId: n.specialistId,
    taskId: n.taskId,
    code: n.code,
    otherSpecialistId: n.otherSpecialistId,
    read: n.readAt !== null,
    createdAt: at(n.createdAt),
    readAt: n.readAt === null ? null : at(n.readAt),
    expiresAt: at(n.expiresAt),
  };
}

// Stored values are checked, not trusted: a malformed notice is skipped, never repaired.
function toNotification(id: string, d: AgentNotificationDocument): AgentNotification | undefined {
  if (!(AGENT_NOTIFICATION_KINDS as readonly string[]).includes(d.kind)) return undefined;
  if (typeof d.taskId !== 'string' || typeof d.specialistId !== 'string') return undefined;
  return Object.freeze({
    id,
    organizationId: d.organizationId as OrganizationId,
    recipientId: d.recipientId as UserId,
    kind: d.kind as AgentNotificationKind,
    specialistId: d.specialistId as SpecialistId,
    taskId: d.taskId,
    code: typeof d.code === 'string' ? d.code : null,
    otherSpecialistId:
      typeof d.otherSpecialistId === 'string' ? (d.otherSpecialistId as SpecialistId) : null,
    createdAt: iso(d.createdAt),
    readAt: d.readAt === null ? null : iso(d.readAt),
    expiresAt: iso(d.expiresAt),
  });
}

export class FirestoreAgentNotificationRepository implements AgentNotificationRepository {
  constructor(private readonly db: Firestore) {}

  #mine(organizationId: OrganizationId, recipientId: UserId) {
    return this.db
      .collection(AGENT_NOTIFICATIONS)
      .where('organizationId', '==', organizationId)
      .where('recipientId', '==', recipientId);
  }

  async put(notification: AgentNotification) {
    const ref = this.db.collection(AGENT_NOTIFICATIONS).doc(notification.id);
    // `create` refuses an existing id: a repeated delivery keeps the first notice as it is.
    await ref.create(toDocument(notification)).catch((error: unknown) => {
      if ((error as { code?: unknown }).code !== 6) throw error;
    });
  }

  async page(
    organizationId: OrganizationId,
    recipientId: UserId,
    request: { readonly after?: string; readonly limit: number },
  ) {
    if (!isOrganizationId(organizationId)) return { items: [], hasMore: false };
    let query = this.#mine(organizationId, recipientId).orderBy(FieldPath.documentId());
    if (request.after !== undefined) query = query.startAfter(request.after);
    const snapshot = await query.limit(request.limit + 1).get();
    const items = snapshot.docs.flatMap((doc) => {
      const n = toNotification(doc.id, doc.data() as AgentNotificationDocument);
      return n === undefined || n.organizationId !== organizationId ? [] : [n];
    });
    return { items: items.slice(0, request.limit), hasMore: snapshot.docs.length > request.limit };
  }

  async unread(organizationId: OrganizationId, recipientId: UserId, limit: number) {
    if (!isOrganizationId(organizationId)) return 0;
    const snapshot = await this.#mine(organizationId, recipientId)
      .where('read', '==', false)
      .limit(limit)
      .get();
    return snapshot.size;
  }

  async markRead(
    organizationId: OrganizationId,
    recipientId: UserId,
    id: string,
    readAt: IsoTimestamp,
  ) {
    if (!isOrganizationId(organizationId)) return false;
    const ref = this.db.collection(AGENT_NOTIFICATIONS).doc(id);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const d = snapshot.data() as AgentNotificationDocument | undefined;
      if (d?.organizationId !== organizationId || d.recipientId !== recipientId) return false;
      if (!d.read) tx.update(ref, { read: true, readAt: at(readAt) });
      return true;
    });
  }

  async markAllRead(
    organizationId: OrganizationId,
    recipientId: UserId,
    readAt: IsoTimestamp,
    limit: number,
  ) {
    if (!isOrganizationId(organizationId)) return 0;
    const snapshot = await this.#mine(organizationId, recipientId)
      .where('read', '==', false)
      .limit(limit)
      .get();
    if (snapshot.empty) return 0;
    const batch = this.db.batch();
    for (const doc of snapshot.docs) batch.update(doc.ref, { read: true, readAt: at(readAt) });
    await batch.commit();
    return snapshot.size;
  }
}
