import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { FieldPath, Timestamp } from '@google-cloud/firestore';
import type {
  IsoTimestamp,
  OrganizationId,
  Specialist,
  SpecialistConfiguration,
  SpecialistId,
  SpecialistVersion,
} from '@melonoffice/domain';
import {
  checkSpecialistWrite,
  checkStoredSpecialist,
  checkStoredVersion,
  isSpecialistId,
  isVersionNumber,
  SpecialistError,
  type SpecialistPageRequest,
  type SpecialistRepository,
  type SpecialistWrite,
} from '@melonoffice/specialists';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `specialists/{specialistId}` holds each specialist with its current configuration, and
 * `specialistVersions/{specialistId}_{version}` every version, written once with `create` and
 * never changed (ADR-0025). The organization is a field every read checks. Written only by the
 * API, never by clients.
 */
export const SPECIALISTS = 'specialists';
export const SPECIALIST_VERSIONS = 'specialistVersions';

interface ConfigurationDocument {
  readonly departmentId: string;
  readonly mainRoleId: string;
  readonly roleVersion: number;
  readonly purpose: string | null;
  readonly description: string | null;
  readonly capabilities: readonly string[];
  readonly skills: readonly { id: string; version: number }[];
  readonly tools: readonly { id: string; version: number }[];
  readonly permissions: readonly string[];
  readonly policies: Readonly<Record<string, { id: string; version: number }>>;
  /** Absent on specialists that are not conversation agents (CV-6B, ADR-0043). */
  readonly conversation?: {
    readonly instructions: string;
    readonly channels: readonly string[];
    readonly autonomy: string;
    readonly maxRepliesPerConversation: number;
  };
}

export interface SpecialistDocument {
  readonly organizationId: string;
  readonly displayName: string;
  readonly avatar: string | null;
  readonly status: string;
  readonly version: number;
  readonly configuration: ConfigurationDocument;
  readonly revision: number;
  readonly createdAt: FirestoreTimestamp;
  readonly createdBy: string;
  readonly updatedAt: FirestoreTimestamp;
  /** Absent until a person changes the status after AE-4 (ADR-0115). */
  readonly lastStatusChange?: {
    readonly from: string;
    readonly to: string;
    readonly at: FirestoreTimestamp;
    readonly by: string;
    readonly reason: string | null;
  };
}

export interface SpecialistVersionDocument {
  readonly specialistId: string;
  readonly organizationId: string;
  readonly version: number;
  readonly configuration: ConfigurationDocument;
  readonly createdAt: FirestoreTimestamp;
  readonly createdBy: string;
}

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;
export const specialistVersionId = (id: string, version: number): string => `${id}_${version}`;
const versionId = specialistVersionId;

function toConfigurationDocument(c: SpecialistConfiguration): ConfigurationDocument {
  return {
    departmentId: c.departmentId,
    mainRoleId: c.mainRoleId,
    roleVersion: c.roleVersion,
    purpose: c.purpose ?? null,
    description: c.description ?? null,
    capabilities: [...c.capabilities],
    skills: c.skills.map(({ id, version }) => ({ id, version })),
    tools: c.tools.map(({ id, version }) => ({ id, version })),
    permissions: [...c.permissions],
    policies: Object.fromEntries(
      Object.entries(c.policies).map(([kind, { id, version }]) => [kind, { id, version }]),
    ),
    ...(c.conversation === undefined
      ? {}
      : {
          conversation: {
            instructions: c.conversation.instructions,
            channels: [...c.conversation.channels],
            autonomy: c.conversation.autonomy,
            maxRepliesPerConversation: c.conversation.maxRepliesPerConversation,
          },
        }),
  };
}

function toConfiguration(d: ConfigurationDocument): SpecialistConfiguration {
  const { purpose, description, ...rest } = d;
  return {
    ...rest,
    ...(purpose === null ? {} : { purpose }),
    ...(description === null ? {} : { description }),
  } as unknown as SpecialistConfiguration;
}

export function toSpecialistDocument(s: Specialist): SpecialistDocument {
  return {
    organizationId: s.organizationId,
    displayName: s.identity.displayName,
    avatar: s.identity.avatar ?? null,
    status: s.status,
    version: s.version,
    configuration: toConfigurationDocument(s.configuration),
    revision: s.revision,
    createdAt: ts(s.identity.createdAt),
    createdBy: s.identity.createdBy,
    updatedAt: ts(s.updatedAt),
    ...(s.lastStatusChange === undefined
      ? {}
      : {
          lastStatusChange: {
            from: s.lastStatusChange.from,
            to: s.lastStatusChange.to,
            at: ts(s.lastStatusChange.at),
            by: s.lastStatusChange.by,
            reason: s.lastStatusChange.reason ?? null,
          },
        }),
  };
}

export function toSpecialistVersionDocument(v: SpecialistVersion): SpecialistVersionDocument {
  return {
    specialistId: v.specialistId,
    organizationId: v.organizationId,
    version: v.version,
    configuration: toConfigurationDocument(v.configuration),
    createdAt: ts(v.createdAt),
    createdBy: v.createdBy,
  };
}

// Stored values are checked, not trusted: a malformed record is refused, never repaired.
export function toSpecialist(id: string, d: SpecialistDocument): Specialist {
  const specialist = {
    identity: {
      id,
      displayName: d.displayName,
      ...(d.avatar === null ? {} : { avatar: d.avatar }),
      createdAt: iso(d.createdAt),
      createdBy: d.createdBy,
    },
    organizationId: d.organizationId,
    status: d.status,
    version: d.version,
    configuration: toConfiguration(d.configuration),
    revision: d.revision,
    updatedAt: iso(d.updatedAt),
    ...(d.lastStatusChange === undefined
      ? {}
      : {
          lastStatusChange: {
            from: d.lastStatusChange.from,
            to: d.lastStatusChange.to,
            at: iso(d.lastStatusChange.at),
            by: d.lastStatusChange.by,
            ...(d.lastStatusChange.reason === null ? {} : { reason: d.lastStatusChange.reason }),
          },
        }),
  } as unknown as Specialist;
  try {
    return checkStoredSpecialist(specialist);
  } catch {
    throw new Error('invalid specialist record');
  }
}

function toVersion(d: SpecialistVersionDocument): SpecialistVersion {
  const version = {
    specialistId: d.specialistId,
    organizationId: d.organizationId,
    version: d.version,
    configuration: toConfiguration(d.configuration),
    createdAt: iso(d.createdAt),
    createdBy: d.createdBy,
  } as unknown as SpecialistVersion;
  try {
    return checkStoredVersion(version);
  } catch {
    throw new Error('invalid specialist version record');
  }
}

/** Specialists and their versions in Firestore. Each write is one transaction. */
export class FirestoreSpecialistRepository implements SpecialistRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, id: SpecialistId): Promise<Specialist | undefined> {
    if (!isOrganizationId(organizationId) || !isSpecialistId(id)) return undefined;
    const snapshot = await this.db.collection(SPECIALISTS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as SpecialistDocument;
    // Another organization's specialist is absent, exactly like a missing one.
    if (data.organizationId !== organizationId) return undefined;
    return toSpecialist(snapshot.id, data);
  }

  // Uses Firestore's automatic single-field index on organizationId; no composite index.
  async list(organizationId: OrganizationId): Promise<readonly Specialist[]> {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(SPECIALISTS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toSpecialist(doc.id, doc.data() as SpecialistDocument))
      .sort((a, b) => (a.identity.id < b.identity.id ? -1 : 1));
  }

  /**
   * One page in document-id order (AE-4, ADR-0115). Equality filters only, ordered by document
   * id, so Firestore serves it from its automatic single-field indexes: no composite index.
   */
  async page(organizationId: OrganizationId, request: SpecialistPageRequest) {
    if (!isOrganizationId(organizationId)) return { items: Object.freeze([]), hasMore: false };
    let query = this.db.collection(SPECIALISTS).where('organizationId', '==', organizationId);
    if (request.status !== undefined) query = query.where('status', '==', request.status);
    if (request.departmentId !== undefined) {
      query = query.where('configuration.departmentId', '==', request.departmentId);
    }
    query = query.orderBy(FieldPath.documentId());
    if (request.after !== undefined) query = query.startAfter(request.after);
    const snapshot = await query.limit(request.limit + 1).get();
    const items = snapshot.docs
      .slice(0, request.limit)
      .map((doc) => toSpecialist(doc.id, doc.data() as SpecialistDocument));
    return { items: Object.freeze(items), hasMore: snapshot.size > request.limit };
  }

  async findVersion(
    organizationId: OrganizationId,
    id: SpecialistId,
    version: number,
  ): Promise<SpecialistVersion | undefined> {
    if (!isOrganizationId(organizationId) || !isSpecialistId(id) || !isVersionNumber(version)) {
      return undefined;
    }
    const snapshot = await this.db
      .collection(SPECIALIST_VERSIONS)
      .doc(versionId(id, version))
      .get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as SpecialistVersionDocument;
    if (data.organizationId !== organizationId || data.specialistId !== id) return undefined;
    return toVersion(data);
  }

  async create(write: SpecialistWrite): Promise<void> {
    checkSpecialistWrite(undefined, write);
    await this.db.runTransaction(async (t) => {
      t.create(
        this.db.collection(SPECIALISTS).doc(write.specialist.identity.id),
        toSpecialistDocument(write.specialist),
      );
      this.#createVersion(t, write);
    });
  }

  async update(
    organizationId: OrganizationId,
    id: SpecialistId,
    change: (current: Specialist) => SpecialistWrite,
  ): Promise<Specialist> {
    if (!isOrganizationId(organizationId) || !isSpecialistId(id)) {
      throw new SpecialistError('specialist_not_found');
    }
    const doc = this.db.collection(SPECIALISTS).doc(id);
    // Firestore re-runs the function when the document changed after it was read, so `change`
    // always decides on the state it overwrites. A version is created, never overwritten.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as SpecialistDocument | undefined;
      if (data?.organizationId !== organizationId) {
        throw new SpecialistError('specialist_not_found');
      }
      const current = toSpecialist(snapshot.id, data);
      const write = change(current);
      checkSpecialistWrite(current, write);
      t.set(doc, toSpecialistDocument(write.specialist));
      this.#createVersion(t, write);
      return write.specialist;
    });
  }

  #createVersion(t: Transaction, { version, events = [] }: SpecialistWrite): void {
    // The change's audit events are part of the same transaction (ADR-0062).
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
    if (version === undefined) return;
    t.create(
      this.db.collection(SPECIALIST_VERSIONS).doc(versionId(version.specialistId, version.version)),
      toSpecialistVersionDocument(version),
    );
  }
}
