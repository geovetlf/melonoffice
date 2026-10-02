import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import {
  checkNextRevision,
  checkStoredExecution,
  ExecutionError,
  isExecutionId,
  OPEN_STATUSES,
  type OpenExecutionIndex,
  type OpenOrganizationIndex,
  type ExecutionRepository,
  type ExecutionWrite,
} from '@melonoffice/execution';
import type {
  Execution,
  ExecutionFailure,
  ExecutionId,
  ExecutionNode,
  ExecutionRef,
  ExecutionVerification,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  VersionRef,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `executions/{executionId}` (ADR-0024). The id is a random UUID, globally unique; the
 * organization is a field every read checks. The graph lives in the same document, so the
 * execution and its nodes always change together. Written only by the API, never by clients.
 */
export const EXECUTIONS = 'executions';

interface NodeDocument {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly status: string;
  readonly dependsOn: readonly string[];
  readonly owner: VersionRef | null;
  readonly input: ExecutionRef | null;
  /** Absent in nodes stored before ADR-0026: read as none. */
  readonly tool?: { id: string; version: number } | null;
  readonly approvalId?: string | null;
  /** ADR-0103. Absent on nodes stored before it. */
  readonly approvalRequired?: boolean | null;
  readonly output: ExecutionRef | null;
  readonly error: { code: string; ref: ExecutionRef | null } | null;
  readonly startedAt: FirestoreTimestamp | null;
  readonly completedAt: FirestoreTimestamp | null;
  /** Absent in nodes stored before ADR-0029: read as the first attempt, no key. */
  readonly attempt?: number | null;
  readonly idempotencyKey?: string | null;
}

interface VerificationDocument {
  readonly schemaVersion: number;
  readonly executionId: string;
  readonly result: string;
  readonly verifiedAt: FirestoreTimestamp;
  readonly correlationId: string;
  readonly nodes: readonly {
    nodeId: string;
    policy: string;
    result: string;
    checks: readonly { code: string; result: string; evidence: ExecutionRef }[];
  }[];
}

interface ExecutionDocument {
  readonly organizationId: string;
  readonly userId: string;
  readonly mode: string;
  readonly status: string;
  readonly input: ExecutionRef;
  readonly nodes: readonly NodeDocument[];
  readonly currentNodeId: string | null;
  readonly parentExecutionId: string | null;
  readonly workflowId: string | null;
  readonly specialistId: string | null;
  readonly specialistVersion: number | null;
  readonly departmentId: string | null;
  readonly requestId: string | null;
  readonly versionSnapshot: { schemaVersion: number; components: readonly VersionRef[] };
  readonly result: ExecutionRef | null;
  readonly failure: { code: string; ref: ExecutionRef | null } | null;
  readonly cancellation: { at: FirestoreTimestamp; by: string; reason: string } | null;
  /** Absent in executions stored before ADR-0029: read as none. */
  readonly verification?: VerificationDocument | null;
  readonly revision: number;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
  readonly startedAt: FirestoreTimestamp | null;
  readonly completedAt: FirestoreTimestamp | null;
}

const at = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const atOrNull = (value: IsoTimestamp | undefined): FirestoreTimestamp | null =>
  value === undefined ? null : at(value);
const iso = (timestamp: FirestoreTimestamp): IsoTimestamp =>
  timestamp.toDate().toISOString() as IsoTimestamp;
const ref = (value: ExecutionRef): ExecutionRef => ({ type: value.type, id: value.id });
const failureDocument = (failure: ExecutionFailure | undefined) =>
  failure === undefined
    ? null
    : { code: failure.code, ref: failure.ref === undefined ? null : ref(failure.ref) };

function verificationDocument(v: ExecutionVerification | undefined): VerificationDocument | null {
  if (v === undefined) return null;
  return {
    schemaVersion: v.schemaVersion,
    executionId: v.executionId,
    result: v.result,
    verifiedAt: at(v.verifiedAt),
    correlationId: v.correlationId,
    nodes: v.nodes.map((n) => ({
      nodeId: n.nodeId,
      policy: n.policy,
      result: n.result,
      checks: n.checks.map((c) => ({ code: c.code, result: c.result, evidence: ref(c.evidence) })),
    })),
  };
}

export function toExecutionDocument(execution: Execution): ExecutionDocument {
  return {
    organizationId: execution.organizationId,
    userId: execution.userId,
    mode: execution.mode,
    status: execution.status,
    input: ref(execution.input),
    nodes: execution.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
      status: node.status,
      dependsOn: [...node.dependsOn],
      owner: node.owner === undefined ? null : { ...node.owner },
      input: node.input === undefined ? null : ref(node.input),
      tool: node.tool === undefined ? null : { id: node.tool.id, version: node.tool.version },
      approvalId: node.approvalId ?? null,
      approvalRequired: node.approvalRequired ?? null,
      output: node.output === undefined ? null : ref(node.output),
      error: failureDocument(node.error),
      startedAt: atOrNull(node.startedAt),
      completedAt: atOrNull(node.completedAt),
      attempt: node.attempt ?? null,
      idempotencyKey: node.idempotencyKey ?? null,
    })),
    currentNodeId: execution.currentNodeId ?? null,
    parentExecutionId: execution.parentExecutionId ?? null,
    workflowId: execution.workflowId ?? null,
    specialistId: execution.specialistId ?? null,
    specialistVersion: execution.specialistVersion ?? null,
    departmentId: execution.departmentId ?? null,
    requestId: execution.requestId ?? null,
    versionSnapshot: {
      schemaVersion: execution.versionSnapshot.schemaVersion,
      components: execution.versionSnapshot.components.map((c) => ({ ...c })),
    },
    result: execution.result === undefined ? null : ref(execution.result),
    failure: failureDocument(execution.failure),
    cancellation:
      execution.cancellation === undefined
        ? null
        : {
            at: at(execution.cancellation.at),
            by: execution.cancellation.by,
            reason: execution.cancellation.reason,
          },
    verification: verificationDocument(execution.verification),
    revision: execution.revision,
    createdAt: at(execution.createdAt),
    updatedAt: at(execution.updatedAt),
    startedAt: atOrNull(execution.startedAt),
    completedAt: atOrNull(execution.completedAt),
  };
}

const fromFailure = (failure: { code: string; ref: ExecutionRef | null } | null) =>
  failure === null
    ? {}
    : { code: failure.code, ...(failure.ref === null ? {} : { ref: failure.ref }) };

/** Reads a document back, checking it: a malformed record is refused, never used. */
function toExecution(id: string, d: ExecutionDocument): Execution {
  const nodes: ExecutionNode[] = d.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    label: n.label,
    status: n.status,
    dependsOn: n.dependsOn,
    ...(n.owner === null ? {} : { owner: n.owner }),
    ...(n.input === null ? {} : { input: n.input }),
    ...(n.tool == null ? {} : { tool: n.tool }),
    ...(n.approvalId == null ? {} : { approvalId: n.approvalId }),
    ...(n.approvalRequired === true ? { approvalRequired: true } : {}),
    ...(n.output === null ? {} : { output: n.output }),
    ...(n.error === null ? {} : { error: fromFailure(n.error) }),
    ...(n.startedAt === null ? {} : { startedAt: iso(n.startedAt) }),
    ...(n.completedAt === null ? {} : { completedAt: iso(n.completedAt) }),
    ...(n.attempt == null ? {} : { attempt: n.attempt }),
    ...(n.idempotencyKey == null ? {} : { idempotencyKey: n.idempotencyKey }),
  })) as ExecutionNode[];
  const execution = {
    id,
    organizationId: d.organizationId,
    userId: d.userId,
    mode: d.mode,
    status: d.status,
    input: d.input,
    nodes,
    ...(d.currentNodeId === null ? {} : { currentNodeId: d.currentNodeId }),
    ...(d.parentExecutionId === null ? {} : { parentExecutionId: d.parentExecutionId }),
    ...(d.workflowId === null ? {} : { workflowId: d.workflowId }),
    ...(d.specialistId === null ? {} : { specialistId: d.specialistId }),
    // Absent in executions stored before ADR-0025: read as no assignment.
    ...(d.specialistVersion == null ? {} : { specialistVersion: d.specialistVersion }),
    ...(d.departmentId == null ? {} : { departmentId: d.departmentId }),
    ...(d.requestId === null ? {} : { requestId: d.requestId }),
    versionSnapshot: d.versionSnapshot,
    ...(d.result === null ? {} : { result: d.result }),
    ...(d.failure === null ? {} : { failure: fromFailure(d.failure) }),
    ...(d.cancellation === null
      ? {}
      : {
          cancellation: {
            at: iso(d.cancellation.at),
            by: d.cancellation.by,
            reason: d.cancellation.reason,
          },
        }),
    ...(d.verification == null
      ? {}
      : { verification: { ...d.verification, verifiedAt: iso(d.verification.verifiedAt) } }),
    revision: d.revision,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    ...(d.startedAt === null ? {} : { startedAt: iso(d.startedAt) }),
    ...(d.completedAt === null ? {} : { completedAt: iso(d.completedAt) }),
  } as unknown as Execution;
  try {
    return checkStoredExecution(execution);
  } catch {
    throw new Error('invalid execution record');
  }
}

/** Executions in Firestore. Each write is one transaction with its audit events. */
export class FirestoreExecutionRepository
  implements ExecutionRepository, OpenExecutionIndex, OpenOrganizationIndex
{
  constructor(private readonly db: Firestore) {}

  /**
   * One query per open status, each with equality filters only, so Firestore serves them from
   * its automatic single-field indexes: no composite index (AE-4, ADR-0115). Ids only.
   */
  async openOfSpecialist(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    limit: number,
  ) {
    if (!isOrganizationId(organizationId) || !Number.isSafeInteger(limit) || limit < 1) {
      return { ids: Object.freeze([] as ExecutionId[]), more: false };
    }
    const pages = await Promise.all(
      OPEN_STATUSES.map((status) =>
        this.db
          .collection(EXECUTIONS)
          .where('organizationId', '==', organizationId)
          .where('specialistId', '==', specialistId)
          .where('status', '==', status)
          .select()
          .limit(limit + 1)
          .get(),
      ),
    );
    const ids = pages.flatMap((p) => p.docs.map((d) => d.id as ExecutionId)).sort();
    return {
      ids: Object.freeze(ids.slice(0, limit)),
      more: ids.length > limit || pages.some((p) => p.size > limit),
    };
  }

  /**
   * One count aggregation per open status, equality filters only (single-field indexes, no
   * composite index), each stopped at `limit` (ADR-0119): a count, never the documents.
   */
  async countOpenOfOrganization(organizationId: OrganizationId, limit: number) {
    if (!isOrganizationId(organizationId) || !Number.isSafeInteger(limit) || limit < 1) return 0;
    const counts = await Promise.all(
      OPEN_STATUSES.map(async (status) => {
        const snapshot = await this.db
          .collection(EXECUTIONS)
          .where('organizationId', '==', organizationId)
          .where('status', '==', status)
          .limit(limit)
          .count()
          .get();
        return snapshot.data().count;
      }),
    );
    return Math.min(
      counts.reduce((sum, n) => sum + n, 0),
      limit,
    );
  }

  async find(organizationId: OrganizationId, id: ExecutionId): Promise<Execution | undefined> {
    if (!isOrganizationId(organizationId) || !isExecutionId(id)) return undefined;
    const snapshot = await this.db.collection(EXECUTIONS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as ExecutionDocument;
    // Another organization's execution is absent, exactly like a missing one.
    if (data.organizationId !== organizationId) return undefined;
    return toExecution(snapshot.id, data);
  }

  async create({ execution, events }: ExecutionWrite): Promise<void> {
    await this.db.runTransaction(async (t) => {
      t.create(this.db.collection(EXECUTIONS).doc(execution.id), toExecutionDocument(execution));
      this.#append(t, events);
    });
  }

  async update(
    organizationId: OrganizationId,
    id: ExecutionId,
    change: (current: Execution) => ExecutionWrite,
  ): Promise<Execution> {
    if (!isOrganizationId(organizationId) || !isExecutionId(id)) {
      throw new ExecutionError('execution_not_found');
    }
    const doc = this.db.collection(EXECUTIONS).doc(id);
    // Firestore retries the whole function when the document changed after it was read, so
    // `change` always decides on the state it overwrites: no lost update.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as ExecutionDocument | undefined;
      if (data?.organizationId !== organizationId) {
        throw new ExecutionError('execution_not_found');
      }
      const current = toExecution(snapshot.id, data);
      const { execution, events } = change(current);
      checkNextRevision(current, execution);
      t.set(doc, toExecutionDocument(execution));
      this.#append(t, events);
      return execution;
    });
  }

  #append(t: Transaction, events: readonly AuditEvent[]): void {
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
