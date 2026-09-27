import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type {
  IsoTimestamp,
  OrganizationId,
  Workflow,
  WorkflowId,
  WorkflowVersion,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { canonicalJson } from '@melonoffice/tools';
import {
  checkNextWorkflow,
  checkStoredWorkflow,
  checkStoredWorkflowVersion,
  isWorkflowId,
  WorkflowError,
  workflowVersionKey,
  type WorkflowRepository,
  type WorkflowWrite,
} from '@melonoffice/workflows';

/**
 * `workflows/{workflowId}` holds each workflow's status and current version, and
 * `workflowVersions/{workflowId}_{version}` each version, written once with `create` and never
 * updated (ADR-0028). Steps are stored as canonical JSON next to the version's digest, which is
 * checked when read. The organization is a field every read checks.
 */
export const WORKFLOWS = 'workflows';
export const WORKFLOW_VERSIONS = 'workflowVersions';

interface WorkflowDocument {
  readonly organizationId: string;
  readonly status: string;
  readonly version: number;
  readonly name: string;
  readonly revision: number;
  readonly createdAt: FirestoreTimestamp;
  readonly createdBy: string;
  readonly updatedAt: FirestoreTimestamp;
}

interface WorkflowVersionDocument {
  readonly organizationId: string;
  readonly workflowId: string;
  readonly version: number;
  readonly name: string;
  readonly steps: string;
  readonly digest: string;
  readonly createdAt: FirestoreTimestamp;
  readonly createdBy: string;
}

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;

const toWorkflowDocument = (w: Workflow): WorkflowDocument => ({
  organizationId: w.organizationId,
  status: w.status,
  version: w.version,
  name: w.name,
  revision: w.revision,
  createdAt: ts(w.createdAt),
  createdBy: w.createdBy,
  updatedAt: ts(w.updatedAt),
});

function toWorkflow(id: string, d: WorkflowDocument): Workflow {
  try {
    return checkStoredWorkflow({
      id: id as WorkflowId,
      organizationId: d.organizationId as OrganizationId,
      status: d.status as Workflow['status'],
      version: d.version,
      name: d.name,
      revision: d.revision,
      createdAt: iso(d.createdAt),
      createdBy: d.createdBy as Workflow['createdBy'],
      updatedAt: iso(d.updatedAt),
    });
  } catch {
    throw new Error('invalid workflow record');
  }
}

const toVersionDocument = (v: WorkflowVersion): WorkflowVersionDocument => ({
  organizationId: v.organizationId,
  workflowId: v.workflowId,
  version: v.version,
  name: v.name,
  steps: canonicalJson(v.steps),
  digest: v.digest,
  createdAt: ts(v.createdAt),
  createdBy: v.createdBy,
});

function toVersion(d: WorkflowVersionDocument): WorkflowVersion {
  try {
    return checkStoredWorkflowVersion({
      workflowId: d.workflowId as WorkflowId,
      organizationId: d.organizationId as OrganizationId,
      version: d.version,
      name: d.name,
      steps: JSON.parse(d.steps) as WorkflowVersion['steps'],
      digest: d.digest,
      createdAt: iso(d.createdAt),
      createdBy: d.createdBy as WorkflowVersion['createdBy'],
    });
  } catch {
    throw new WorkflowError('invalid_workflow', 'stored_version');
  }
}

export class FirestoreWorkflowRepository implements WorkflowRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, id: WorkflowId): Promise<Workflow | undefined> {
    if (!isOrganizationId(organizationId) || !isWorkflowId(id)) return undefined;
    const snapshot = await this.db.collection(WORKFLOWS).doc(id).get();
    const data = snapshot.data() as WorkflowDocument | undefined;
    if (data?.organizationId !== organizationId) return undefined;
    return toWorkflow(snapshot.id, data);
  }

  async findVersion(
    organizationId: OrganizationId,
    id: WorkflowId,
    version: number,
  ): Promise<WorkflowVersion | undefined> {
    if (!isOrganizationId(organizationId) || !isWorkflowId(id) || !Number.isSafeInteger(version)) {
      return undefined;
    }
    const snapshot = await this.db
      .collection(WORKFLOW_VERSIONS)
      .doc(workflowVersionKey(id, version))
      .get();
    const data = snapshot.data() as WorkflowVersionDocument | undefined;
    if (data?.organizationId !== organizationId || data.workflowId !== id) return undefined;
    return toVersion(data);
  }

  // Single-field index on organizationId only; sorted here, so no composite index is needed.
  async list(organizationId: OrganizationId, limit: number): Promise<readonly Workflow[]> {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(WORKFLOWS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toWorkflow(doc.id, doc.data() as WorkflowDocument))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  async create({ workflow, version }: Required<WorkflowWrite>): Promise<void> {
    await this.db.runTransaction(async (t) => {
      t.create(this.db.collection(WORKFLOWS).doc(workflow.id), toWorkflowDocument(workflow));
      t.create(
        this.db.collection(WORKFLOW_VERSIONS).doc(workflowVersionKey(workflow.id, version.version)),
        toVersionDocument(version),
      );
    });
  }

  async update(
    organizationId: OrganizationId,
    id: WorkflowId,
    change: (current: Workflow) => WorkflowWrite,
  ): Promise<Workflow> {
    if (!isOrganizationId(organizationId) || !isWorkflowId(id)) {
      throw new WorkflowError('workflow_not_found');
    }
    const doc = this.db.collection(WORKFLOWS).doc(id);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as WorkflowDocument | undefined;
      if (data?.organizationId !== organizationId) throw new WorkflowError('workflow_not_found');
      const current = toWorkflow(snapshot.id, data);
      const write = change(current);
      checkNextWorkflow(current, write);
      t.set(doc, toWorkflowDocument(write.workflow));
      if (write.version !== undefined) {
        // `create` fails if the version exists: a version is never overwritten.
        t.create(
          this.db.collection(WORKFLOW_VERSIONS).doc(workflowVersionKey(id, write.version.version)),
          toVersionDocument(write.version),
        );
      }
      return write.workflow;
    });
  }
}
