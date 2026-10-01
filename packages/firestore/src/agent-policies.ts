import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AgentAutonomy, IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import {
  checkStoredAgentPolicy,
  SpecialistError,
  type AgentPolicyRepository,
  type AgentPolicyWrite,
  type OrganizationAgentPolicy,
} from '@melonoffice/specialists';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `agentPolicies/{organizationId}` (AE-4.4, ADR-0116): an organization's rules for its agents,
 * one per organization, which is also a field every read checks. Written only by the API, with
 * its audit event, in one transaction. Read by a document id: no index.
 */
export const AGENT_POLICIES = 'agentPolicies';

export interface AgentPolicyDocument {
  readonly organizationId: string;
  readonly sensitiveCategories: readonly string[];
  readonly sensitiveActions: readonly string[];
  readonly sensitiveTools: readonly string[];
  readonly maxAutonomy: string;
  readonly revision: number;
  readonly updatedAt: FirestoreTimestamp;
  readonly updatedBy: string;
}

export function toAgentPolicyDocument(p: OrganizationAgentPolicy): AgentPolicyDocument {
  return {
    organizationId: p.organizationId,
    sensitiveCategories: [...p.sensitiveCategories],
    sensitiveActions: [...p.sensitiveActions],
    sensitiveTools: [...p.sensitiveTools],
    maxAutonomy: p.maxAutonomy,
    revision: p.revision,
    updatedAt: Timestamp.fromDate(new Date(p.updatedAt)),
    updatedBy: p.updatedBy,
  };
}

// Stored values are checked, not trusted: a malformed record is refused, never repaired.
function toAgentPolicy(d: AgentPolicyDocument): OrganizationAgentPolicy {
  try {
    return checkStoredAgentPolicy({
      organizationId: d.organizationId as OrganizationId,
      sensitiveCategories: d.sensitiveCategories,
      sensitiveActions: d.sensitiveActions,
      sensitiveTools: d.sensitiveTools,
      maxAutonomy: d.maxAutonomy as AgentAutonomy,
      revision: d.revision,
      updatedAt: d.updatedAt.toDate().toISOString() as IsoTimestamp,
      updatedBy: d.updatedBy as UserId,
    });
  } catch {
    throw new Error('invalid agent policy record');
  }
}

export class FirestoreAgentPolicyRepository implements AgentPolicyRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId): Promise<OrganizationAgentPolicy | undefined> {
    if (!isOrganizationId(organizationId)) return undefined;
    const snapshot = await this.db.collection(AGENT_POLICIES).doc(organizationId).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as AgentPolicyDocument;
    if (data.organizationId !== organizationId) return undefined;
    return toAgentPolicy(data);
  }

  async save(
    organizationId: OrganizationId,
    change: (current: OrganizationAgentPolicy | undefined) => AgentPolicyWrite,
  ): Promise<OrganizationAgentPolicy> {
    if (!isOrganizationId(organizationId)) throw new Error('invalid organization');
    const doc = this.db.collection(AGENT_POLICIES).doc(organizationId);
    // Firestore runs the function again when the policy changed before the commit, so `change`
    // always decides on the policy it replaces.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as AgentPolicyDocument | undefined;
      if (data !== undefined && data.organizationId !== organizationId) {
        throw new Error('invalid agent policy record');
      }
      const current = data === undefined ? undefined : toAgentPolicy(data);
      const write = change(current);
      if (write.policy.organizationId !== organizationId) throw new Error('policy organization');
      if (write.policy.revision !== (current?.revision ?? 0) + 1) {
        throw new SpecialistError('specialist_concurrency_conflict');
      }
      checkStoredAgentPolicy(write.policy);
      t.set(doc, toAgentPolicyDocument(write.policy));
      for (const event of write.events) {
        if (event.organizationId !== organizationId) throw new Error('audit_event_organization');
        t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
      }
      return write.policy;
    });
  }
}
