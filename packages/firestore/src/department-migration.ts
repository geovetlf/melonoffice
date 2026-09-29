import type { Firestore } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import { checkStoredDepartment } from '@melonoffice/departments';
import type { Department, OrganizationId, Specialist } from '@melonoffice/domain';
import { checkSpecialistWrite, type SpecialistWrite } from '@melonoffice/specialists';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';
import {
  DEPARTMENTS,
  toDepartment,
  toDepartmentDocument,
  type DepartmentDocument,
} from './departments.js';
import {
  SPECIALIST_VERSIONS,
  SPECIALISTS,
  specialistVersionId,
  toSpecialist,
  toSpecialistDocument,
  toSpecialistVersionDocument,
  type SpecialistDocument,
} from './specialists.js';

interface State {
  readonly departments: readonly Department[];
  readonly specialists: readonly Specialist[];
}

interface Write {
  readonly departments: readonly Department[];
  readonly specialists: readonly Required<Omit<SpecialistWrite, 'events'>>[];
  readonly events: readonly AuditEvent[];
}

/**
 * The department catalogue migration's storage (ADR-0047): one organization's departments,
 * specialists, new specialist versions and audit events, written together in one transaction or
 * not at all. Only the organization's own records are read or written.
 */
export class FirestoreDepartmentMigrationStore {
  constructor(private readonly db: Firestore) {}

  // A single-field `in` query: Firestore's automatic index, no composite index.
  async organizationsWith(typeIds: readonly string[]): Promise<readonly OrganizationId[]> {
    if (typeIds.length === 0) return [];
    const snapshot = await this.db
      .collection(DEPARTMENTS)
      .where('typeId', 'in', [...typeIds])
      .get();
    const ids = snapshot.docs
      .map((doc) => (doc.data() as DepartmentDocument).organizationId)
      .filter(isOrganizationId);
    return [...new Set(ids)].sort();
  }

  async read(organizationId: OrganizationId): Promise<State> {
    const [departments, specialists] = await Promise.all([
      this.db.collection(DEPARTMENTS).where('organizationId', '==', organizationId).get(),
      this.db.collection(SPECIALISTS).where('organizationId', '==', organizationId).get(),
    ]);
    return {
      departments: departments.docs.map((d) => toDepartment(d.id, d.data() as DepartmentDocument)),
      specialists: specialists.docs.map((d) => toSpecialist(d.id, d.data() as SpecialistDocument)),
    };
  }

  async apply(organizationId: OrganizationId, plan: (state: State) => Write): Promise<Write> {
    if (!isOrganizationId(organizationId)) throw new Error('invalid organization');
    const departmentsRef = this.db.collection(DEPARTMENTS);
    const specialistsRef = this.db.collection(SPECIALISTS);
    // Firestore runs the function again when anything it read changed before the commit, so the
    // plan always decides on the records it overwrites.
    return this.db.runTransaction(async (t) => {
      const [departments, specialists] = await Promise.all([
        t.get(departmentsRef.where('organizationId', '==', organizationId)),
        t.get(specialistsRef.where('organizationId', '==', organizationId)),
      ]);
      const state: State = {
        departments: departments.docs.map((d) =>
          toDepartment(d.id, d.data() as DepartmentDocument),
        ),
        specialists: specialists.docs.map((d) =>
          toSpecialist(d.id, d.data() as SpecialistDocument),
        ),
      };
      const write = plan(state);
      const currentDepartments = new Map(state.departments.map((d) => [d.id, d]));
      const currentSpecialists = new Map(state.specialists.map((s) => [s.identity.id, s]));
      for (const department of write.departments) {
        const current = currentDepartments.get(department.id);
        // Only a department the transaction read, of this organization, one revision later.
        if (
          current === undefined ||
          department.organizationId !== organizationId ||
          department.revision !== current.revision + 1
        ) {
          throw new Error('department_concurrency_conflict');
        }
        checkStoredDepartment(department);
        t.set(departmentsRef.doc(department.id), toDepartmentDocument(department));
      }
      for (const move of write.specialists) {
        const current = currentSpecialists.get(move.specialist.identity.id);
        if (current === undefined || move.specialist.organizationId !== organizationId) {
          throw new Error('specialist_not_found');
        }
        checkSpecialistWrite(current, move);
        t.set(
          specialistsRef.doc(move.specialist.identity.id),
          toSpecialistDocument(move.specialist),
        );
        // A version is created once, never overwritten.
        t.create(
          this.db
            .collection(SPECIALIST_VERSIONS)
            .doc(specialistVersionId(move.version.specialistId, move.version.version)),
          toSpecialistVersionDocument(move.version),
        );
      }
      for (const event of write.events) {
        if (event.organizationId !== organizationId) throw new Error('audit_event_organization');
        t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
      }
      return write;
    });
  }
}
