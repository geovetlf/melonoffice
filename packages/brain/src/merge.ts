import type {
  IsoTimestamp,
  KnowledgeClaim,
  KnowledgeConflict,
  KnowledgeItem,
  KnowledgeOperation,
  KnowledgeProvenance,
  KnowledgeRecorder,
  KnowledgeSourceType,
  KnowledgeVerification,
  KnowledgeVersion,
  OrganizationId,
} from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';
import { classify } from './catalogue.js';
import { knowledgeItemId, omit, sameValue, type KnowledgeInput } from './knowledge.js';

/**
 * How a new fact meets what Company Brain already holds (ADR-0051). Pure and deterministic: no
 * model is asked, and no storage is read here.
 *
 * - Nothing there yet: the fact becomes an item.
 * - The same value: nothing changes, unless a person now states it (it becomes confirmed).
 * - A different value:
 *   - from a person acting directly: it replaces the value (the old one stays as a version);
 *   - from the same source that gave the current value, still unconfirmed: its newer reading;
 *   - replacing a mere proposal with a fact at least as strong: it replaces it;
 *   - otherwise (a confirmed value, or two sources that disagree): a conflict for a person to
 *     decide. Nothing is chosen silently.
 */

/** A source's verification: only a person acting directly confirms. */
export function verificationFor(
  sourceType: KnowledgeSourceType,
  confirmedByPerson: boolean,
): KnowledgeVerification {
  switch (sourceType) {
    case 'user':
      return confirmedByPerson ? 'confirmed' : 'proposed';
    case 'gia':
    case 'agent':
    case 'workflow':
      return 'proposed';
    case 'document':
      return 'unverified';
    case 'analytics':
    case 'system':
      return 'calculated';
    case 'crm':
    case 'integration':
    case 'import':
      return 'imported';
  }
}

const STRENGTH: Readonly<Record<KnowledgeVerification, number>> = {
  proposed: 1,
  unverified: 2,
  imported: 3,
  calculated: 3,
  confirmed: 4,
};

const sameSource = (a: KnowledgeProvenance, b: KnowledgeProvenance): boolean =>
  a.sourceType === b.sourceType && (a.sourceId ?? '') === (b.sourceId ?? '');

export type MergeOutcome =
  'created' | 'updated' | 'confirmed' | 'unchanged' | 'conflict' | 'conflict_updated';

export interface MergeResult {
  readonly outcome: MergeOutcome;
  readonly itemId: string;
  readonly item?: KnowledgeItem;
  readonly version?: KnowledgeVersion;
  readonly conflicts: readonly KnowledgeConflict[];
}

export interface Incoming {
  readonly organizationId: OrganizationId;
  readonly input: KnowledgeInput;
  readonly provenance: KnowledgeProvenance;
  readonly verification: KnowledgeVerification;
  /** A person acting directly, who may manage knowledge. */
  readonly byPerson: boolean;
  readonly at: IsoTimestamp;
}

export function versionOf(
  item: KnowledgeItem,
  operation: KnowledgeOperation,
  changedBy: KnowledgeRecorder,
  reason?: string,
): KnowledgeVersion {
  return Object.freeze({
    organizationId: item.organizationId,
    itemId: item.id,
    revision: item.revision,
    operation,
    value: item.value,
    verification: item.verification,
    status: item.status,
    provenance: item.provenance,
    effectiveFrom: item.effectiveFrom,
    ...(item.effectiveUntil === undefined ? {} : { effectiveUntil: item.effectiveUntil }),
    changedAt: item.updatedAt,
    changedBy,
    ...(reason === undefined ? {} : { reason }),
  });
}

export function merge(current: KnowledgeItem | undefined, incoming: Incoming): MergeResult {
  const { organizationId, input, provenance, verification, byPerson, at } = incoming;
  const id = knowledgeItemId(organizationId, input.domain, input.key, input.subject);
  const recorder = provenance.recordedBy;
  const { sensitivity, critical } = classify(input.domain, input.key);

  if (current === undefined) {
    const item: KnowledgeItem = Object.freeze({
      id,
      organizationId,
      domain: input.domain,
      key: input.key,
      ...(input.subject === undefined ? {} : { subject: input.subject }),
      ...(input.label === undefined ? {} : { label: input.label }),
      value: input.value,
      verification,
      status: 'active',
      sensitivity,
      critical,
      provenance,
      relations: input.relations ?? [],
      effectiveFrom: (input.effectiveFrom ?? at) as IsoTimestamp,
      revision: 1,
      createdAt: at,
      updatedAt: at,
    });
    return {
      outcome: 'created',
      itemId: id,
      item,
      version: versionOf(item, 'created', recorder),
      conflicts: [],
    };
  }

  const next = (
    changes: Partial<KnowledgeItem>,
    operation: KnowledgeOperation,
  ): { item: KnowledgeItem; version: KnowledgeVersion } => {
    const base = omit(current, 'effectiveUntil');
    const item = Object.freeze({
      ...base,
      ...changes,
      status: 'active' as const,
      revision: current.revision + 1,
      updatedAt: at,
    });
    return { item, version: versionOf(item, operation, recorder) };
  };

  const inForce = current.status === 'active';

  if (sameValue(current.value, input.value)) {
    if (!inForce) {
      const { item, version } = next(
        { provenance, verification, effectiveFrom: (input.effectiveFrom ?? at) as IsoTimestamp },
        'updated',
      );
      return { outcome: 'updated', itemId: id, item, version, conflicts: [] };
    }
    if (byPerson && current.verification !== 'confirmed') {
      const { item, version } = next({ verification: 'confirmed', provenance }, 'confirmed');
      return { outcome: 'confirmed', itemId: id, item, version, conflicts: [] };
    }
    return { outcome: 'unchanged', itemId: id, conflicts: [] };
  }

  const candidate: KnowledgeClaim = Object.freeze({ value: input.value, verification, provenance });
  const replace = (): MergeResult => {
    const { item: replaced, version } = next(
      {
        value: input.value,
        verification,
        provenance,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.relations === undefined ? {} : { relations: input.relations }),
        effectiveFrom: (input.effectiveFrom ?? at) as IsoTimestamp,
      },
      'updated',
    );
    return { outcome: 'updated', itemId: id, item: replaced, version, conflicts: [] };
  };

  if (!inForce) return replace();
  if (byPerson) return replace();
  if (current.verification !== 'confirmed' && sameSource(current.provenance, provenance)) {
    return replace();
  }
  if (current.verification === 'proposed' && STRENGTH[verification] >= STRENGTH.proposed) {
    return replace();
  }

  // A disagreement no one has decided yet. One open conflict per item: a later disagreement
  // replaces its candidate (the service passes the open conflict in as `open`).
  const conflict: KnowledgeConflict = Object.freeze({
    id: randomUUID(),
    organizationId,
    itemId: id,
    domain: current.domain,
    key: current.key,
    ...(current.subject === undefined ? {} : { subject: current.subject }),
    ...(current.label === undefined ? {} : { label: current.label }),
    revision: current.revision,
    current: Object.freeze({
      value: current.value,
      verification: current.verification,
      provenance: current.provenance,
    }),
    candidate,
    status: 'open',
    createdAt: at,
  });
  return { outcome: 'conflict', itemId: id, conflicts: [conflict] };
}

/** A disagreement on an item that already has an open conflict: its candidate is the latest. */
export function updateOpenConflict(
  open: KnowledgeConflict,
  current: KnowledgeItem,
  incoming: Incoming,
): KnowledgeConflict {
  return Object.freeze({
    ...open,
    revision: current.revision,
    current: Object.freeze({
      value: current.value,
      verification: current.verification,
      provenance: current.provenance,
    }),
    candidate: Object.freeze({
      value: incoming.input.value,
      verification: incoming.verification,
      provenance: incoming.provenance,
    }),
  });
}
