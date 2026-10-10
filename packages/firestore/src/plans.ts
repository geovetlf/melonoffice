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
  Plan,
  PlanConditionResult,
  PlanDecision,
  PlanId,
  PlanVersion,
  WorkflowId,
} from '@melonoffice/domain';
import {
  checkNextPlan,
  checkStoredPlan,
  checkStoredPlanVersion,
  isPlanId,
  pageOfPlans,
  PlanningError,
  planVersionKey,
  type CreatingPlanPage,
  type PlanCreate,
  type PlanPage,
  type PlanPosition,
  type PlanRepository,
  type PlanUpdate,
} from '@melonoffice/planning';
import { isOrganizationId } from '@melonoffice/tenancy';
import { canonicalJson } from '@melonoffice/tools';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `plans/{planId}` holds each plan's status, current version, delegations and decision
 * (ADR-0028). `planVersions/{planId}_{version}` holds each version, written once with `create`
 * and never updated: its content is stored as canonical JSON next to its SHA-256 digest, and a
 * version whose content no longer matches the digest is refused when read. The organization is
 * a field every read checks. Written only by the API, never by clients.
 */
export const PLANS = 'plans';
export const PLAN_VERSIONS = 'planVersions';

interface PlanDocument {
  readonly organizationId: string;
  readonly executionId: string;
  readonly status: string;
  readonly version: number;
  readonly delegations: readonly { stepId: string; executionId: string }[];
  /** Absent in plans written before delegation states existed: read as not delegated. */
  readonly delegationState?: string | null;
  readonly delegationFailure?: string | null;
  /** The workflow and version it was made from (ADR-0180); absent on older plans. */
  readonly workflowId?: string | null;
  readonly workflowVersion?: number | null;
  /** The schedule's occurrence that made it (ADR-0185); absent when a person started it. */
  readonly workflowOccurrence?: FirestoreTimestamp | null;
  readonly decision: {
    decision: string;
    version: number;
    digest: string;
    decidedBy: string;
    decidedAt: FirestoreTimestamp;
    /** ADR-0185: `schedule` for a standing approval; absent otherwise. */
    via?: string;
  } | null;
  /** What each condition step did (WF-4). Absent in plans written before conditions ran. */
  readonly conditions?: readonly ConditionDocument[];
  /** ADR-0146: absent on plans written before, and on plans no step asked approval for. */
  readonly stepApprovals?: readonly StepApprovalDocument[];
  /** ADR-0152: absent on plans written before, and on plans with no wait step started. */
  readonly waits?: readonly {
    readonly stepId: string;
    readonly startedAt: FirestoreTimestamp;
    readonly until: FirestoreTimestamp;
  }[];
  /** ADR-0163: absent on plans written before, and on plans no step was blocked in. */
  readonly budgetBlocks?: readonly {
    readonly stepId: string;
    readonly usedCredits: number;
    readonly neededCredits: number;
    readonly capCredits: number;
    readonly blockedAt: FirestoreTimestamp;
  }[];
  /** ADR-0153: absent on plans written before, and on plans no step was retried in. */
  readonly attempts?: readonly {
    readonly stepId: string;
    readonly attempt: number;
    readonly executionId: string;
    readonly after: string;
    readonly failure: string;
    readonly recordedAt: FirestoreTimestamp;
    readonly notBefore: FirestoreTimestamp;
  }[];
  readonly revision: number;
  readonly createdAt: FirestoreTimestamp;
  readonly createdBy: string;
  readonly updatedAt: FirestoreTimestamp;
}

interface StepApprovalDocument {
  readonly stepId: string;
  readonly approvalId: string;
  readonly requestedAt: FirestoreTimestamp;
  /** ADR-0151: on a tool step's approval, the specialist step it holds back. */
  readonly performedBy?: string;
  readonly declined?: { readonly reason: string; readonly at: FirestoreTimestamp } | null;
}

interface ConditionDocument {
  readonly stepId: string;
  readonly result: string;
  readonly decision: { id: string; type: string; version: number; outcome: string } | null;
  readonly failure: string | null;
  readonly evaluatedAt: FirestoreTimestamp;
}

interface PlanVersionDocument {
  readonly organizationId: string;
  readonly planId: string;
  readonly version: number;
  /** Canonical JSON of request, steps, risk, approval, estimate and source. */
  readonly content: string;
  readonly digest: string;
  readonly createdAt: FirestoreTimestamp;
  readonly createdBy: string;
}

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;

export function toPlanDocument(plan: Plan): PlanDocument {
  return {
    organizationId: plan.organizationId,
    executionId: plan.executionId,
    status: plan.status,
    version: plan.version,
    delegations: plan.delegations.map((d) => ({ stepId: d.stepId, executionId: d.executionId })),
    delegationState: plan.delegationState ?? null,
    delegationFailure: plan.delegationFailure ?? null,
    workflowId: plan.workflow?.id ?? null,
    workflowVersion: plan.workflow?.version ?? null,
    ...(plan.workflow?.occurrence === undefined
      ? {}
      : { workflowOccurrence: ts(plan.workflow.occurrence) }),
    decision:
      plan.decision === undefined
        ? null
        : {
            decision: plan.decision.decision,
            version: plan.decision.version,
            digest: plan.decision.digest,
            decidedBy: plan.decision.decidedBy,
            decidedAt: ts(plan.decision.decidedAt),
            ...(plan.decision.via === undefined ? {} : { via: plan.decision.via }),
          },
    ...(plan.conditions === undefined
      ? {}
      : {
          conditions: plan.conditions.map((c) => ({
            stepId: c.stepId,
            result: c.result,
            decision: c.decision === undefined ? null : { ...c.decision },
            failure: c.failure ?? null,
            evaluatedAt: ts(c.evaluatedAt),
          })),
        }),
    ...(plan.waits === undefined
      ? {}
      : {
          waits: plan.waits.map((w) => ({
            stepId: w.stepId,
            startedAt: ts(w.startedAt),
            until: ts(w.until),
          })),
        }),
    ...(plan.budgetBlocks === undefined
      ? {}
      : {
          budgetBlocks: plan.budgetBlocks.map((b) => ({
            stepId: b.stepId,
            usedCredits: b.usedCredits,
            neededCredits: b.neededCredits,
            capCredits: b.capCredits,
            blockedAt: ts(b.blockedAt),
          })),
        }),
    ...(plan.attempts === undefined
      ? {}
      : {
          attempts: plan.attempts.map((a) => ({
            stepId: a.stepId,
            attempt: a.attempt,
            executionId: a.executionId,
            after: a.after,
            failure: a.failure,
            recordedAt: ts(a.recordedAt),
            notBefore: ts(a.notBefore),
          })),
        }),
    ...(plan.stepApprovals === undefined
      ? {}
      : {
          stepApprovals: plan.stepApprovals.map((a) => ({
            stepId: a.stepId,
            approvalId: a.approvalId,
            requestedAt: ts(a.requestedAt),
            ...(a.performedBy === undefined ? {} : { performedBy: a.performedBy }),
            declined:
              a.declined === undefined
                ? null
                : { reason: a.declined.reason, at: ts(a.declined.at) },
          })),
        }),
    revision: plan.revision,
    createdAt: ts(plan.createdAt),
    createdBy: plan.createdBy,
    updatedAt: ts(plan.updatedAt),
  };
}

function toPlan(id: string, d: PlanDocument): Plan {
  const plan = {
    id,
    organizationId: d.organizationId,
    executionId: d.executionId,
    status: d.status,
    version: d.version,
    delegations: d.delegations.map((x) => ({ stepId: x.stepId, executionId: x.executionId })),
    ...(d.delegationState === undefined || d.delegationState === null
      ? {}
      : { delegationState: d.delegationState }),
    ...(d.delegationFailure === undefined || d.delegationFailure === null
      ? {}
      : { delegationFailure: d.delegationFailure }),
    ...(typeof d.workflowId === 'string' && typeof d.workflowVersion === 'number'
      ? {
          workflow: {
            id: d.workflowId as WorkflowId,
            version: d.workflowVersion,
            ...(d.workflowOccurrence === undefined || d.workflowOccurrence === null
              ? {}
              : { occurrence: iso(d.workflowOccurrence) }),
          },
        }
      : {}),
    ...(d.decision === null
      ? {}
      : {
          decision: {
            decision: d.decision.decision as PlanDecision['decision'],
            version: d.decision.version,
            digest: d.decision.digest,
            decidedBy: d.decision.decidedBy,
            decidedAt: iso(d.decision.decidedAt),
            ...(d.decision.via === 'schedule' ? { via: 'schedule' as const } : {}),
          },
        }),
    ...(d.conditions === undefined
      ? {}
      : {
          conditions: d.conditions.map((c) => ({
            stepId: c.stepId,
            result: c.result as PlanConditionResult['result'],
            ...(c.decision === null ? {} : { decision: { ...c.decision } }),
            ...(c.failure === null ? {} : { failure: c.failure }),
            evaluatedAt: iso(c.evaluatedAt),
          })),
        }),
    ...(d.waits === undefined
      ? {}
      : {
          waits: d.waits.map((w) => ({
            stepId: w.stepId,
            startedAt: iso(w.startedAt),
            until: iso(w.until),
          })),
        }),
    ...(d.budgetBlocks === undefined
      ? {}
      : {
          budgetBlocks: d.budgetBlocks.map((b) => ({
            stepId: b.stepId,
            usedCredits: b.usedCredits,
            neededCredits: b.neededCredits,
            capCredits: b.capCredits,
            blockedAt: iso(b.blockedAt),
          })),
        }),
    ...(d.attempts === undefined
      ? {}
      : {
          attempts: d.attempts.map((a) => ({
            stepId: a.stepId,
            attempt: a.attempt,
            executionId: a.executionId,
            after: a.after,
            failure: a.failure,
            recordedAt: iso(a.recordedAt),
            notBefore: iso(a.notBefore),
          })),
        }),
    ...(d.stepApprovals === undefined
      ? {}
      : {
          stepApprovals: d.stepApprovals.map((a) => ({
            stepId: a.stepId,
            approvalId: a.approvalId,
            requestedAt: iso(a.requestedAt),
            ...(typeof a.performedBy === 'string' ? { performedBy: a.performedBy } : {}),
            ...(a.declined === null || a.declined === undefined
              ? {}
              : { declined: { reason: a.declined.reason, at: iso(a.declined.at) } }),
          })),
        }),
    revision: d.revision,
    createdAt: iso(d.createdAt),
    createdBy: d.createdBy,
    updatedAt: iso(d.updatedAt),
  } as unknown as Plan;
  try {
    return checkStoredPlan(plan);
  } catch {
    throw new Error('invalid plan record');
  }
}

export function toPlanVersionDocument(version: PlanVersion): PlanVersionDocument {
  return {
    organizationId: version.organizationId,
    planId: version.planId,
    version: version.version,
    content: canonicalJson({
      request: version.request,
      steps: version.steps,
      riskLevel: version.riskLevel,
      approvalRequired: version.approvalRequired,
      estimate: version.estimate,
      source: version.source,
    }),
    digest: version.digest,
    createdAt: ts(version.createdAt),
    createdBy: version.createdBy,
  };
}

/** Reads a version back: its digest must still match. A changed or broken one is refused. */
function toPlanVersion(d: PlanVersionDocument): PlanVersion {
  try {
    const content = JSON.parse(d.content) as Pick<
      PlanVersion,
      'request' | 'steps' | 'riskLevel' | 'approvalRequired' | 'estimate' | 'source'
    >;
    return checkStoredPlanVersion({
      planId: d.planId as PlanId,
      organizationId: d.organizationId as OrganizationId,
      version: d.version,
      request: content.request,
      steps: content.steps,
      riskLevel: content.riskLevel,
      approvalRequired: content.approvalRequired,
      estimate: content.estimate,
      source: content.source,
      digest: d.digest,
      createdAt: iso(d.createdAt),
      createdBy: d.createdBy as PlanVersion['createdBy'],
    });
  } catch {
    throw new PlanningError('invalid_plan', 'stored_version');
  }
}

/** A query Firestore refuses until its composite index exists (gRPC FAILED_PRECONDITION). */
const isMissingIndex = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 9 &&
  /index/i.test(String((error as { message?: unknown }).message));

/** Plans in Firestore. Each write is one transaction with its audit events. */
export class FirestorePlanRepository implements PlanRepository {
  constructor(
    private readonly db: Firestore,
    /** Told when a page had to be read without its index (ADR-0061's fallback). */
    private readonly options: { readonly onIndexMissing?: (query: string) => void } = {},
  ) {}

  async find(organizationId: OrganizationId, id: PlanId): Promise<Plan | undefined> {
    if (!isOrganizationId(organizationId) || !isPlanId(id)) return undefined;
    const snapshot = await this.db.collection(PLANS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as PlanDocument;
    // Another organization's plan is absent, exactly like a missing one.
    if (data.organizationId !== organizationId) return undefined;
    return toPlan(snapshot.id, data);
  }

  async findVersion(
    organizationId: OrganizationId,
    id: PlanId,
    version: number,
  ): Promise<PlanVersion | undefined> {
    if (!isOrganizationId(organizationId) || !isPlanId(id) || !Number.isSafeInteger(version)) {
      return undefined;
    }
    const snapshot = await this.db.collection(PLAN_VERSIONS).doc(planVersionKey(id, version)).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as PlanVersionDocument;
    if (data.organizationId !== organizationId || data.planId !== id) return undefined;
    return toPlanVersion(data);
  }

  // Uses Firestore's automatic single-field index on organizationId; sorted here, so no
  // composite index (and no Terraform) is needed.
  async list(organizationId: OrganizationId, limit: number): Promise<readonly Plan[]> {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(PLANS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toPlan(doc.id, doc.data() as PlanDocument))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * Two equality filters (ADR-0180): Firestore's automatic single-field indexes serve them, so no
   * composite index is needed. Sorted here, newest first.
   */
  async listForWorkflow(
    organizationId: OrganizationId,
    workflowId: WorkflowId,
    limit: number,
  ): Promise<readonly Plan[]> {
    if (!isOrganizationId(organizationId) || typeof workflowId !== 'string' || workflowId === '') {
      return [];
    }
    const snapshot = await this.db
      .collection(PLANS)
      .where('organizationId', '==', organizationId)
      .where('workflowId', '==', workflowId)
      .get();
    return snapshot.docs
      .map((doc) => toPlan(doc.id, doc.data() as PlanDocument))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  /**
   * Uses the composite index `organizationId, createdAt desc` (ADR-0150). Until it exists, the
   * organization's plans are read through the automatic index and paged here, as `list` reads
   * them, and the missing index is logged.
   */
  async page(
    organizationId: OrganizationId,
    request: { readonly after?: PlanPosition; readonly limit: number },
  ): Promise<PlanPage> {
    if (!isOrganizationId(organizationId)) return { items: [], hasMore: false };
    const mine = this.db.collection(PLANS).where('organizationId', '==', organizationId);
    let query = mine.orderBy('createdAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (request.after !== undefined) {
      query = query.startAfter(Timestamp.fromDate(new Date(request.after.at)), request.after.id);
    }
    try {
      const snapshot = await query.limit(request.limit + 1).get();
      const items = snapshot.docs.map((doc) => toPlan(doc.id, doc.data() as PlanDocument));
      return { items: items.slice(0, request.limit), hasMore: items.length > request.limit };
    } catch (error) {
      if (!isMissingIndex(error)) throw error;
      this.options.onIndexMissing?.('plans');
      const snapshot = await mine.get();
      return pageOfPlans(
        snapshot.docs.map((doc) => toPlan(doc.id, doc.data() as PlanDocument)),
        request,
      );
    }
  }

  /**
   * One equality and the document id as the order (ADR-0187): the automatic single-field index on
   * `delegationState` serves it, so no composite index is needed. A record that does not read as a
   * plan is never released, and it does not hold up the rest of its page.
   */
  async creatingPage(request: {
    readonly after?: PlanId;
    readonly limit: number;
  }): Promise<CreatingPlanPage> {
    if (!Number.isSafeInteger(request.limit) || request.limit < 1) return { plans: [] };
    let query = this.db
      .collection(PLANS)
      .where('delegationState', '==', 'creating')
      .orderBy(FieldPath.documentId());
    if (request.after !== undefined) query = query.startAfter(request.after);
    const snapshot = await query.limit(request.limit).get();
    const plans = snapshot.docs.flatMap((doc) => {
      try {
        return [toPlan(doc.id, doc.data() as PlanDocument)];
      } catch {
        return [];
      }
    });
    const last = snapshot.docs[snapshot.docs.length - 1];
    return {
      plans,
      ...(last !== undefined && snapshot.size === request.limit ? { next: last.id as PlanId } : {}),
    };
  }

  async create({ plan, version, events }: PlanCreate): Promise<void> {
    checkStoredPlan(plan);
    checkStoredPlanVersion(version);
    try {
      await this.db.runTransaction(async (t) => {
        t.create(this.db.collection(PLANS).doc(plan.id), toPlanDocument(plan));
        t.create(
          this.db.collection(PLAN_VERSIONS).doc(planVersionKey(plan.id, version.version)),
          toPlanVersionDocument(version),
        );
        this.#append(t, events);
      });
    } catch (error) {
      // gRPC 6: ALREADY_EXISTS. One plan per planning execution.
      if ((error as { code?: unknown }).code === 6) {
        throw new PlanningError('plan_concurrency_conflict');
      }
      throw error;
    }
  }

  async update(
    organizationId: OrganizationId,
    id: PlanId,
    change: (current: Plan, version: PlanVersion) => PlanUpdate,
  ): Promise<Plan> {
    if (!isOrganizationId(organizationId) || !isPlanId(id)) {
      throw new PlanningError('plan_not_found');
    }
    const doc = this.db.collection(PLANS).doc(id);
    // Firestore re-runs the function when the plan changed after it was read, so a second
    // decision or delegation always sees the first one and is refused.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as PlanDocument | undefined;
      if (data?.organizationId !== organizationId) throw new PlanningError('plan_not_found');
      const current = toPlan(snapshot.id, data);
      const versionSnapshot = await t.get(
        this.db.collection(PLAN_VERSIONS).doc(planVersionKey(id, current.version)),
      );
      const versionData = versionSnapshot.data() as PlanVersionDocument | undefined;
      if (versionData?.organizationId !== organizationId) {
        throw new PlanningError('plan_not_found');
      }
      const { plan, events } = change(current, toPlanVersion(versionData));
      checkNextPlan(current, plan);
      t.set(doc, toPlanDocument(plan));
      this.#append(t, events);
      return plan;
    });
  }

  #append(t: Transaction, events: readonly AuditEvent[]): void {
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
