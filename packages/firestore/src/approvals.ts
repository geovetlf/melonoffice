import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import {
  ApprovalError,
  checkNextApproval,
  checkStoredApproval,
  isApprovalId,
  type ApprovalRepository,
  type ApprovalWrite,
} from '@melonoffice/approvals';
import type { AuditEvent } from '@melonoffice/audit';
import type { Approval, ApprovalId, IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `approvals/{approvalId}` holds each tool approval (ADR-0026): the operation it is bound to,
 * with the input as a digest only, and its status. The organization is a field every read
 * checks. Written only by the API, never by clients, together with its audit events.
 */
export const APPROVALS = 'approvals';

interface OperationDocument {
  readonly organizationId: string;
  readonly executionId: string;
  readonly nodeId: string;
  readonly specialistId: string;
  readonly specialistVersion: number;
  readonly toolId: string;
  readonly toolVersion: number;
  readonly action: string;
  readonly inputDigest: string;
}

export interface ApprovalDocument {
  readonly organizationId: string;
  readonly operation: OperationDocument;
  readonly bindingDigest: string;
  readonly requestedBy: string;
  readonly riskLevel: string;
  readonly reason: string;
  readonly impact: string;
  readonly estimatedCredits: number | null;
  readonly status: string;
  readonly requestedAt: FirestoreTimestamp;
  readonly expiresAt: FirestoreTimestamp;
  readonly decidedAt: FirestoreTimestamp | null;
  readonly decidedBy: string | null;
  /** Why it was withdrawn (ADR-0181); absent on older approvals. */
  readonly cancelReason?: string | null;
  readonly revision: number;
}

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;

export function toApprovalDocument(a: Approval): ApprovalDocument {
  const o = a.operation;
  return {
    organizationId: a.organizationId,
    operation: {
      organizationId: o.organizationId,
      executionId: o.executionId,
      nodeId: o.nodeId,
      specialistId: o.specialistId,
      specialistVersion: o.specialistVersion,
      toolId: o.toolId,
      toolVersion: o.toolVersion,
      action: o.action,
      inputDigest: o.inputDigest,
    },
    bindingDigest: a.bindingDigest,
    requestedBy: a.requestedBy,
    riskLevel: a.riskLevel,
    reason: a.reason,
    impact: a.impact,
    estimatedCredits: a.estimatedCredits ?? null,
    status: a.status,
    requestedAt: ts(a.requestedAt),
    expiresAt: ts(a.expiresAt),
    decidedAt: a.decidedAt === undefined ? null : ts(a.decidedAt),
    decidedBy: a.decidedBy ?? null,
    cancelReason: a.cancelReason ?? null,
    revision: a.revision,
  };
}

// Stored values are checked, not trusted: a malformed record is refused, never repaired.
function toApproval(id: string, d: ApprovalDocument): Approval {
  const approval = {
    id,
    organizationId: d.organizationId,
    operation: { ...d.operation },
    bindingDigest: d.bindingDigest,
    requestedBy: d.requestedBy,
    riskLevel: d.riskLevel,
    reason: d.reason,
    impact: d.impact,
    ...(d.estimatedCredits == null ? {} : { estimatedCredits: d.estimatedCredits }),
    status: d.status,
    requestedAt: iso(d.requestedAt),
    expiresAt: iso(d.expiresAt),
    ...(d.decidedAt == null ? {} : { decidedAt: iso(d.decidedAt) }),
    ...(d.decidedBy == null ? {} : { decidedBy: d.decidedBy }),
    ...(d.cancelReason == null ? {} : { cancelReason: d.cancelReason }),
    revision: d.revision,
  } as unknown as Approval;
  try {
    return checkStoredApproval(approval);
  } catch {
    throw new Error('invalid approval record');
  }
}

/** Approvals in Firestore. Each write is one transaction with its audit events. */
export class FirestoreApprovalRepository implements ApprovalRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, id: ApprovalId): Promise<Approval | undefined> {
    if (!isOrganizationId(organizationId) || !isApprovalId(id)) return undefined;
    const snapshot = await this.db.collection(APPROVALS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as ApprovalDocument;
    // Another organization's approval is absent, exactly like a missing one.
    if (data.organizationId !== organizationId) return undefined;
    return toApproval(snapshot.id, data);
  }

  // Uses Firestore's automatic single-field index on organizationId; sorted here, so no
  // composite index is needed. An organization's approvals are few until X6 runs tools at scale.
  async list(organizationId: OrganizationId, limit: number): Promise<readonly Approval[]> {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(APPROVALS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toApproval(doc.id, doc.data() as ApprovalDocument))
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0))
      .slice(0, limit);
  }

  async create({ approval, events }: ApprovalWrite): Promise<void> {
    checkStoredApproval(approval);
    await this.db.runTransaction(async (t) => {
      t.create(this.db.collection(APPROVALS).doc(approval.id), toApprovalDocument(approval));
      this.#append(t, events);
    });
  }

  async update(
    organizationId: OrganizationId,
    id: ApprovalId,
    change: (current: Approval) => ApprovalWrite,
  ): Promise<Approval> {
    if (!isOrganizationId(organizationId) || !isApprovalId(id)) {
      throw new ApprovalError('approval_not_found');
    }
    const doc = this.db.collection(APPROVALS).doc(id);
    // Firestore re-runs the function when the document changed after it was read, so a second
    // decision always sees the first one and is refused.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as ApprovalDocument | undefined;
      if (data?.organizationId !== organizationId) {
        throw new ApprovalError('approval_not_found');
      }
      const current = toApproval(snapshot.id, data);
      const { approval, events } = change(current);
      checkNextApproval(current, approval);
      t.set(doc, toApprovalDocument(approval));
      this.#append(t, events);
      return approval;
    });
  }

  #append(t: Transaction, events: readonly AuditEvent[]): void {
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
