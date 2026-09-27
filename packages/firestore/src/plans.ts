import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type {
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanDecision,
  PlanId,
  PlanVersion,
} from '@melonoffice/domain';
import {
  checkNextPlan,
  checkStoredPlan,
  checkStoredPlanVersion,
  isPlanId,
  PlanningError,
  planVersionKey,
  type PlanCreate,
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
  readonly decision: {
    decision: string;
    version: number;
    digest: string;
    decidedBy: string;
    decidedAt: FirestoreTimestamp;
  } | null;
  readonly revision: number;
  readonly createdAt: FirestoreTimestamp;
  readonly createdBy: string;
  readonly updatedAt: FirestoreTimestamp;
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
    decision:
      plan.decision === undefined
        ? null
        : {
            decision: plan.decision.decision,
            version: plan.decision.version,
            digest: plan.decision.digest,
            decidedBy: plan.decision.decidedBy,
            decidedAt: ts(plan.decision.decidedAt),
          },
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
    ...(d.decision === null
      ? {}
      : {
          decision: {
            decision: d.decision.decision as PlanDecision['decision'],
            version: d.decision.version,
            digest: d.decision.digest,
            decidedBy: d.decision.decidedBy,
            decidedAt: iso(d.decision.decidedAt),
          },
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

/** Plans in Firestore. Each write is one transaction with its audit events. */
export class FirestorePlanRepository implements PlanRepository {
  constructor(private readonly db: Firestore) {}

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
