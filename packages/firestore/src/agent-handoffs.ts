import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import {
  AgentTaskError,
  HANDOFF_REASONS,
  type AgentHandoffRepository,
  type AgentHandoffWrite,
} from '@melonoffice/agents';
import type {
  AgentHandoff,
  AgentHandoffReason,
  AgentHandoffState,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `agentHandoffs/{parentTaskId}` (ADR-0117): one agent handing part of a task to another, one per
 * task. The organization is a field every read checks. Read by document id only: no index.
 * Written only by the API and the worker, each change with its audit events in one transaction.
 */
export const AGENT_HANDOFFS = 'agentHandoffs';

interface AgentRefDocument {
  readonly specialistId: string;
  readonly version: number;
}

export interface AgentHandoffDocument {
  readonly organizationId: string;
  readonly parentTaskId: string;
  readonly requestingAgent: AgentRefDocument;
  readonly department: string;
  readonly receivingAgent: AgentRefDocument | null;
  readonly reason: string;
  readonly request: string;
  readonly context: string;
  readonly state: string;
  readonly refusal: string | null;
  readonly childTaskId: string | null;
  readonly permissions: readonly string[] | null;
  readonly maxCredits: number | null;
  readonly decision: { readonly by: string; readonly at: FirestoreTimestamp } | null;
  readonly creditsConsumed: number | null;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

const STATES: readonly string[] = [
  'proposed',
  'accepted',
  'declined',
  'refused',
  'completed',
  'failed',
];
const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;

export function toAgentHandoffDocument(h: AgentHandoff): AgentHandoffDocument {
  return {
    organizationId: h.organizationId,
    parentTaskId: h.parentTaskId,
    requestingAgent: { ...h.requestingAgent },
    department: h.department,
    receivingAgent: h.receivingAgent === undefined ? null : { ...h.receivingAgent },
    reason: h.reason,
    request: h.request,
    context: h.context,
    state: h.state,
    refusal: h.refusal ?? null,
    childTaskId: h.childTaskId ?? null,
    permissions: h.permissions === undefined ? null : [...h.permissions],
    maxCredits: h.maxCredits ?? null,
    decision: h.decision === undefined ? null : { by: h.decision.by, at: ts(h.decision.at) },
    creditsConsumed: h.creditsConsumed ?? null,
    createdAt: ts(h.createdAt),
    updatedAt: ts(h.updatedAt),
  };
}

// Stored values are checked, not trusted: a malformed record is refused, never repaired.
function toAgentHandoff(id: string, d: AgentHandoffDocument): AgentHandoff {
  if (!STATES.includes(d.state) || !HANDOFF_REASONS.includes(d.reason as AgentHandoffReason)) {
    throw new Error('invalid agent handoff record');
  }
  const ref = (r: AgentRefDocument) => ({
    specialistId: r.specialistId as SpecialistId,
    version: r.version,
  });
  return Object.freeze({
    id: id as ExecutionId,
    organizationId: d.organizationId as OrganizationId,
    parentTaskId: d.parentTaskId as ExecutionId,
    requestingAgent: ref(d.requestingAgent),
    department: d.department,
    ...(d.receivingAgent === null ? {} : { receivingAgent: ref(d.receivingAgent) }),
    reason: d.reason as AgentHandoffReason,
    request: d.request,
    context: d.context,
    state: d.state as AgentHandoffState,
    ...(d.refusal === null ? {} : { refusal: d.refusal }),
    ...(d.childTaskId === null ? {} : { childTaskId: d.childTaskId as ExecutionId }),
    ...(d.permissions === null ? {} : { permissions: Object.freeze([...d.permissions]) }),
    ...(d.maxCredits === null ? {} : { maxCredits: d.maxCredits }),
    ...(d.decision === null
      ? {}
      : { decision: { by: d.decision.by as UserId, at: iso(d.decision.at) } }),
    ...(d.creditsConsumed === null ? {} : { creditsConsumed: d.creditsConsumed }),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  });
}

export class FirestoreAgentHandoffRepository implements AgentHandoffRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, id: ExecutionId) {
    if (!isOrganizationId(organizationId)) return undefined;
    const snapshot = await this.db.collection(AGENT_HANDOFFS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as AgentHandoffDocument;
    if (data.organizationId !== organizationId) return undefined;
    return toAgentHandoff(snapshot.id, data);
  }

  async create(write: AgentHandoffWrite) {
    const { handoff } = write;
    if (!isOrganizationId(handoff.organizationId)) throw new Error('invalid organization');
    const doc = this.db.collection(AGENT_HANDOFFS).doc(handoff.id);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      if (snapshot.exists) {
        const data = snapshot.data() as AgentHandoffDocument;
        if (data.organizationId !== handoff.organizationId) throw new Error('handoff organization');
        // A repeated task end: the handoff stored the first time stands.
        return toAgentHandoff(snapshot.id, data);
      }
      t.create(doc, toAgentHandoffDocument(handoff));
      this.events(t, handoff.organizationId, write);
      return handoff;
    });
  }

  async update(
    organizationId: OrganizationId,
    id: ExecutionId,
    change: (current: AgentHandoff) => AgentHandoffWrite,
  ) {
    if (!isOrganizationId(organizationId)) throw new AgentTaskError('handoff_not_found');
    const doc = this.db.collection(AGENT_HANDOFFS).doc(id);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as AgentHandoffDocument | undefined;
      if (data === undefined || data.organizationId !== organizationId) {
        throw new AgentTaskError('handoff_not_found');
      }
      const write = change(toAgentHandoff(snapshot.id, data));
      if (write.handoff.id !== id || write.handoff.organizationId !== organizationId) {
        throw new Error('handoff identity');
      }
      t.set(doc, toAgentHandoffDocument(write.handoff));
      this.events(t, organizationId, write);
      return write.handoff;
    });
  }

  private events(t: Transaction, organizationId: OrganizationId, write: AgentHandoffWrite) {
    for (const event of write.events) {
      if (event.organizationId !== organizationId) throw new Error('audit_event_organization');
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
