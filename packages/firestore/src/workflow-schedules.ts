import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { FieldPath, Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type {
  IsoTimestamp,
  OrganizationId,
  PlanId,
  UserId,
  WorkflowId,
  WorkflowRecurrence,
  WorkflowSchedule,
  WorkflowScheduleOutcome,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import {
  checkNextSchedule,
  checkStoredSchedule,
  isWorkflowId,
  type LapsedSchedulePage,
  WorkflowError,
  type WorkflowScheduleChange,
  type WorkflowScheduleRepository,
} from '@melonoffice/workflows';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `workflowSchedules/{workflowId}`: one workflow's schedule (ADR-0185). The organization is a
 * field every read checks. Every change is one transaction with its audit events. The sweep's
 * recovery reads `nextRunAt` by a range on that one field, which the automatic single-field
 * index serves; a schedule that is off has no `nextRunAt`, so it never matches.
 */
export const WORKFLOW_SCHEDULES = 'workflowSchedules';

interface ScheduleDocument {
  readonly organizationId: string;
  readonly workflowId: string;
  readonly status: string;
  readonly recurrence: WorkflowRecurrence;
  readonly timeZone: string;
  readonly workflowVersion: number;
  readonly confirmedBy: string;
  readonly confirmedAt: FirestoreTimestamp;
  readonly nextRunAt: FirestoreTimestamp | null;
  readonly last: {
    readonly occurrence: FirestoreTimestamp;
    readonly outcome: string;
    readonly at: FirestoreTimestamp;
    readonly planId: string | null;
  } | null;
  readonly revision: number;
  readonly updatedAt: FirestoreTimestamp;
}

const ts = (iso: string) => Timestamp.fromDate(new Date(iso));
const iso = (t: FirestoreTimestamp) => t.toDate().toISOString() as IsoTimestamp;

function toDocument(s: WorkflowSchedule): ScheduleDocument {
  return {
    organizationId: s.organizationId,
    workflowId: s.workflowId,
    status: s.status,
    recurrence: structuredClone(s.recurrence) as WorkflowRecurrence,
    timeZone: s.timeZone,
    workflowVersion: s.workflowVersion,
    confirmedBy: s.confirmedBy,
    confirmedAt: ts(s.confirmedAt),
    nextRunAt: s.nextRunAt === undefined ? null : ts(s.nextRunAt),
    last:
      s.last === undefined
        ? null
        : {
            occurrence: ts(s.last.occurrence),
            outcome: s.last.outcome,
            at: ts(s.last.at),
            planId: s.last.planId ?? null,
          },
    revision: s.revision,
    updatedAt: ts(s.updatedAt),
  };
}

function toSchedule(d: ScheduleDocument): WorkflowSchedule {
  return checkStoredSchedule(
    Object.freeze({
      workflowId: d.workflowId as WorkflowId,
      organizationId: d.organizationId as OrganizationId,
      status: d.status as WorkflowSchedule['status'],
      recurrence: d.recurrence,
      timeZone: d.timeZone,
      workflowVersion: d.workflowVersion,
      confirmedBy: d.confirmedBy as UserId,
      confirmedAt: iso(d.confirmedAt),
      ...(d.nextRunAt === null ? {} : { nextRunAt: iso(d.nextRunAt) }),
      ...(d.last === null
        ? {}
        : {
            last: Object.freeze({
              occurrence: iso(d.last.occurrence),
              outcome: d.last.outcome as WorkflowScheduleOutcome,
              at: iso(d.last.at),
              ...(d.last.planId === null ? {} : { planId: d.last.planId as PlanId }),
            }),
          }),
      revision: d.revision,
      updatedAt: iso(d.updatedAt),
    }),
  );
}

export class FirestoreWorkflowScheduleRepository implements WorkflowScheduleRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, workflowId: WorkflowId) {
    if (!isOrganizationId(organizationId) || !isWorkflowId(workflowId)) return undefined;
    const snapshot = await this.db.collection(WORKFLOW_SCHEDULES).doc(workflowId).get();
    const data = snapshot.data() as ScheduleDocument | undefined;
    if (data?.organizationId !== organizationId) return undefined;
    return toSchedule(data);
  }

  async update(
    organizationId: OrganizationId,
    workflowId: WorkflowId,
    change: (current: WorkflowSchedule | undefined) => WorkflowScheduleChange,
  ): Promise<WorkflowSchedule> {
    if (!isOrganizationId(organizationId) || !isWorkflowId(workflowId)) {
      throw new WorkflowError('workflow_not_found');
    }
    const doc = this.db.collection(WORKFLOW_SCHEDULES).doc(workflowId);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as ScheduleDocument | undefined;
      // Another organization's schedule for this id is never seen nor overwritten.
      if (data !== undefined && data.organizationId !== organizationId) {
        throw new WorkflowError('workflow_not_found');
      }
      const current = data === undefined ? undefined : toSchedule(data);
      const write = change(current);
      checkNextSchedule(current, organizationId, workflowId, write);
      t.set(doc, toDocument(write.schedule));
      this.#audit(t, write.events);
      return write.schedule;
    });
  }

  async due(before: IsoTimestamp, limit: number): Promise<readonly WorkflowSchedule[]> {
    const cutoff = new Date(before);
    if (Number.isNaN(cutoff.getTime()) || !Number.isSafeInteger(limit) || limit < 1) return [];
    const snapshot = await this.db
      .collection(WORKFLOW_SCHEDULES)
      .where('nextRunAt', '<=', Timestamp.fromDate(cutoff))
      .orderBy('nextRunAt', 'asc')
      .limit(limit)
      .get();
    return snapshot.docs.flatMap((doc) => {
      try {
        const schedule = toSchedule(doc.data() as ScheduleDocument);
        return schedule.status === 'on' ? [schedule] : [];
      } catch {
        // A record that does not read as a schedule is never run.
        return [];
      }
    });
  }

  async lapsedOff(
    before: IsoTimestamp,
    limit: number,
    after?: WorkflowId,
  ): Promise<LapsedSchedulePage> {
    const cutoff = new Date(before);
    if (Number.isNaN(cutoff.getTime()) || !Number.isSafeInteger(limit) || limit < 1) {
      return { schedules: [] };
    }
    // One equality and the document id as the order. The automatic single-field index on `last.outcome`
    // serves it with no composite index (ADR-0187): two equalities, or an equality with a range, would
    // need one. Status and lease are read from each record, which is cheap: few claims are open at once.
    let query = this.db
      .collection(WORKFLOW_SCHEDULES)
      .where('last.outcome', '==', 'claimed')
      .orderBy(FieldPath.documentId());
    if (after !== undefined) query = query.startAfter(after);
    const snapshot = await query.limit(limit).get();
    const schedules = snapshot.docs.flatMap((doc) => {
      try {
        const schedule = toSchedule(doc.data() as ScheduleDocument);
        return schedule.status === 'off' &&
          schedule.last !== undefined &&
          Date.parse(schedule.last.at) <= cutoff.getTime()
          ? [schedule]
          : [];
      } catch {
        // A record that does not read as a schedule is never run.
        return [];
      }
    });
    const last = snapshot.docs[snapshot.docs.length - 1];
    return {
      schedules,
      ...(snapshot.size === limit && last !== undefined ? { next: last.id as WorkflowId } : {}),
    };
  }

  #audit(t: Transaction, events: readonly AuditEvent[]): void {
    for (const e of events) t.create(this.db.collection(AUDIT_LOGS).doc(e.id), toAuditDocument(e));
  }
}
