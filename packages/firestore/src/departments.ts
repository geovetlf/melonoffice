import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import {
  checkStoredDepartment,
  organizationOfDepartmentId,
  type DepartmentRepository,
} from '@melonoffice/departments';
import type { Department, DepartmentId, IsoTimestamp, OrganizationId } from '@melonoffice/domain';

/**
 * `departments/{departmentId}` (ADR-0025). A catalogue department's id is
 * `{organizationId}_{typeId}`, so an organization cannot hold two of one type; the organization
 * is also a field every read checks. Written only by the API, never by clients.
 */
export const DEPARTMENTS = 'departments';

export interface DepartmentDocument {
  readonly organizationId: string;
  readonly originKind: string;
  readonly typeId: string | null;
  readonly typeVersion: number | null;
  readonly name: string | null;
  readonly status: string;
  readonly purpose: string | null;
  readonly description: string | null;
  readonly revision: number;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;

export function toDepartmentDocument(d: Department): DepartmentDocument {
  return {
    organizationId: d.organizationId,
    originKind: d.origin.kind,
    typeId: d.origin.kind === 'catalog' ? d.origin.typeId : null,
    typeVersion: d.origin.kind === 'catalog' ? d.origin.typeVersion : null,
    name: d.origin.kind === 'custom' ? d.origin.name : null,
    status: d.status,
    purpose: d.purpose ?? null,
    description: d.description ?? null,
    revision: d.revision,
    createdAt: ts(d.createdAt),
    updatedAt: ts(d.updatedAt),
  };
}

// Stored values are checked, not trusted: a malformed record is refused, never repaired.
export function toDepartment(id: string, d: DepartmentDocument): Department {
  const department = {
    id,
    organizationId: d.organizationId,
    origin:
      d.originKind === 'catalog'
        ? { kind: 'catalog', typeId: d.typeId, typeVersion: d.typeVersion }
        : { kind: d.originKind, name: d.name },
    status: d.status,
    ...(d.purpose === null ? {} : { purpose: d.purpose }),
    ...(d.description === null ? {} : { description: d.description }),
    revision: d.revision,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  } as unknown as Department;
  try {
    return checkStoredDepartment(department);
  } catch {
    throw new Error('invalid department record');
  }
}

/** Departments in Firestore. They are created with their organization (tenancy-firestore). */
export class FirestoreDepartmentRepository implements DepartmentRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, id: DepartmentId): Promise<Department | undefined> {
    if (organizationOfDepartmentId(id) !== organizationId) return undefined;
    const snapshot = await this.db.collection(DEPARTMENTS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as DepartmentDocument;
    // Another organization's department is absent, exactly like a missing one.
    if (data.organizationId !== organizationId) return undefined;
    return toDepartment(snapshot.id, data);
  }

  // Uses Firestore's automatic single-field index on organizationId; no composite index.
  async list(organizationId: OrganizationId): Promise<readonly Department[]> {
    const snapshot = await this.db
      .collection(DEPARTMENTS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toDepartment(doc.id, doc.data() as DepartmentDocument))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }
}
