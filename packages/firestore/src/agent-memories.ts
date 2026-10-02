import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AgentMemoryRepository } from '@melonoffice/agents';
import type {
  AgentMemory,
  AgentMemoryKind,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `agentMemories/{memoryId}` (ADR-0117): one note of one agent's own memory. The organization and
 * the agent are fields every read checks. Read by equality on both (Firestore's single-field
 * indexes serve it: no composite index), at most a few dozen notes per agent. Written only by the
 * API and the worker, each change with its audit events in one transaction. Never Company Brain's.
 */
export const AGENT_MEMORIES = 'agentMemories';

export interface AgentMemoryDocument {
  readonly organizationId: string;
  readonly specialistId: string;
  readonly kind: string;
  readonly text: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly createdAt: FirestoreTimestamp;
  readonly expiresAt: FirestoreTimestamp;
}

const KINDS: readonly string[] = ['preference', 'lesson', 'note'];

function toDocument(m: AgentMemory): AgentMemoryDocument {
  return {
    organizationId: m.organizationId,
    specialistId: m.specialistId,
    kind: m.kind,
    text: m.text,
    sourceType: m.source.type,
    sourceId: m.source.id,
    createdAt: Timestamp.fromDate(new Date(m.createdAt)),
    expiresAt: Timestamp.fromDate(new Date(m.expiresAt)),
  };
}

// Stored values are checked, not trusted: a malformed note is skipped, never repaired.
function toMemory(id: string, d: AgentMemoryDocument): AgentMemory | undefined {
  if (!KINDS.includes(d.kind) || typeof d.text !== 'string') return undefined;
  if (d.sourceType !== 'task' && d.sourceType !== 'person') return undefined;
  return Object.freeze({
    id,
    organizationId: d.organizationId as OrganizationId,
    specialistId: d.specialistId as SpecialistId,
    kind: d.kind as AgentMemoryKind,
    text: d.text,
    source:
      d.sourceType === 'task'
        ? { type: 'task' as const, id: d.sourceId as ExecutionId }
        : { type: 'person' as const, id: d.sourceId as UserId },
    createdAt: d.createdAt.toDate().toISOString() as IsoTimestamp,
    expiresAt: d.expiresAt.toDate().toISOString() as IsoTimestamp,
  });
}

export class FirestoreAgentMemoryRepository implements AgentMemoryRepository {
  constructor(private readonly db: Firestore) {}

  async list(organizationId: OrganizationId, specialistId: SpecialistId) {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(AGENT_MEMORIES)
      .where('organizationId', '==', organizationId)
      .where('specialistId', '==', specialistId)
      .limit(200)
      .get();
    return snapshot.docs.flatMap((doc) => {
      const data = doc.data() as AgentMemoryDocument;
      if (data.organizationId !== organizationId || data.specialistId !== specialistId) return [];
      const memory = toMemory(doc.id, data);
      return memory === undefined ? [] : [memory];
    });
  }

  async write(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    change: Parameters<AgentMemoryRepository['write']>[2],
  ) {
    if (!isOrganizationId(organizationId)) throw new Error('invalid organization');
    const collection = this.db.collection(AGENT_MEMORIES);
    await this.db.runTransaction(async (t) => {
      const added = await Promise.all(change.add.map((m) => t.get(collection.doc(m.id))));
      const removed = await Promise.all(change.remove.map((id) => t.get(collection.doc(id))));
      for (const [index, note] of change.add.entries()) {
        if (note.organizationId !== organizationId || note.specialistId !== specialistId) {
          throw new Error('memory organization');
        }
        // The same note again (a repeated task end) is left as it is.
        if (!added[index]?.exists) t.create(collection.doc(note.id), toDocument(note));
      }
      for (const snapshot of removed) {
        const data = snapshot.data() as AgentMemoryDocument | undefined;
        // Only this agent's notes of this organization are ever deleted.
        if (data?.organizationId === organizationId && data.specialistId === specialistId) {
          t.delete(snapshot.ref);
        }
      }
      for (const event of change.events) {
        if (event.organizationId !== organizationId) throw new Error('audit_event_organization');
        t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
      }
    });
  }
}
