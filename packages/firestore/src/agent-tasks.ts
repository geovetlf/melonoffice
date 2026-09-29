import type {
  DocumentData,
  Firestore,
  Timestamp as FirestoreTimestamp,
} from '@google-cloud/firestore';
import { FieldPath, Timestamp } from '@google-cloud/firestore';
import { pageOfTasks, type AgentTaskRepository, type TaskPosition } from '@melonoffice/agents';
import type {
  AgentTask,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';

/**
 * `agentTasks/{taskId}` (ADR-0063): what a person asked an agent, written once. The task id is
 * its execution's id; the organization is a field every read checks. An agent's list is read one
 * page at a time with the composite index `organizationId, specialistId, createdAt desc`.
 */
export const AGENT_TASKS = 'agentTasks';

/** The most tasks read at once while the list's index does not exist yet. */
const FALLBACK_LIMIT = 500;

interface AgentTaskDocument {
  readonly organizationId: string;
  readonly specialistId: string;
  readonly specialistVersion: number;
  readonly request: string;
  readonly requestedBy: string;
  readonly createdAt: FirestoreTimestamp;
}

const toDocument = (task: AgentTask): AgentTaskDocument => ({
  organizationId: task.organizationId,
  specialistId: task.specialistId,
  specialistVersion: task.specialistVersion,
  request: task.request,
  requestedBy: task.requestedBy,
  createdAt: Timestamp.fromDate(new Date(task.createdAt)),
});

const toTask = (id: string, data: DocumentData): AgentTask => {
  const d = data as AgentTaskDocument;
  return Object.freeze({
    id: id as ExecutionId,
    organizationId: d.organizationId as OrganizationId,
    specialistId: d.specialistId as SpecialistId,
    specialistVersion: d.specialistVersion,
    request: d.request,
    requestedBy: d.requestedBy as UserId,
    createdAt: d.createdAt.toDate().toISOString() as IsoTimestamp,
  });
};

/** A query Firestore refuses until its composite index exists (gRPC FAILED_PRECONDITION). */
const isMissingIndex = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 9 &&
  /index/i.test(String((error as { message?: unknown }).message));

export class FirestoreAgentTaskRepository implements AgentTaskRepository {
  constructor(
    private readonly db: Firestore,
    /** Told when a list had to be read without its index (ADR-0061's fallback). */
    private readonly options: { readonly onIndexMissing?: (query: string) => void } = {},
  ) {}

  async create(task: AgentTask): Promise<AgentTask> {
    const doc = this.db.collection(AGENT_TASKS).doc(task.id);
    // Written once: a repeat of the same request finds the stored task, never overwrites it.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      if (snapshot.exists) {
        const stored = toTask(snapshot.id, snapshot.data() as DocumentData);
        if (stored.organizationId !== task.organizationId) throw new Error('task id taken');
        return stored;
      }
      t.create(doc, toDocument(task));
      return task;
    });
  }

  async find(organizationId: OrganizationId, id: ExecutionId): Promise<AgentTask | undefined> {
    const snapshot = await this.db.collection(AGENT_TASKS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const task = toTask(snapshot.id, snapshot.data() as DocumentData);
    return task.organizationId === organizationId ? task : undefined;
  }

  async page(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    request: { readonly after?: TaskPosition; readonly limit: number },
  ) {
    const mine = this.db
      .collection(AGENT_TASKS)
      .where('organizationId', '==', organizationId)
      .where('specialistId', '==', specialistId);
    let query = mine.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (request.after !== undefined) {
      query = query.startAfter(Timestamp.fromDate(new Date(request.after.at)), request.after.id);
    }
    try {
      const snapshot = await query.limit(request.limit + 1).get();
      const items = snapshot.docs.map((doc) => toTask(doc.id, doc.data()));
      return Object.freeze({
        items: Object.freeze(items.slice(0, request.limit)),
        hasMore: items.length > request.limit,
      });
    } catch (error) {
      if (!isMissingIndex(error)) throw error;
      this.options.onIndexMissing?.('agent_tasks');
      // Equality filters only need Firestore's automatic indexes.
      const snapshot = await mine.limit(FALLBACK_LIMIT).get();
      return pageOfTasks(
        snapshot.docs.map((doc) => toTask(doc.id, doc.data())),
        request,
      );
    }
  }
}
