import { FieldPath, type Firestore, type Transaction } from '@google-cloud/firestore';
import {
  checkWrite,
  type KnowledgeFilter,
  type KnowledgeRepository,
  type KnowledgeWrite,
} from '@melonoffice/brain';
import type {
  KnowledgeConflict,
  KnowledgeDocument,
  KnowledgeItem,
  KnowledgeVersion,
  OrganizationId,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * Company Brain in Firestore (ADR-0051). Four collections, every document carrying its
 * `organizationId`, read only with that organization named:
 *
 * - `knowledgeItems/{itemId}`: the current state of each fact;
 * - `knowledgeVersions/{itemId}_{revision}`: every revision, written once with `create`;
 * - `knowledgeConflicts/{conflictId}`: disagreements and how they were decided;
 * - `knowledgeDocuments/{documentId}`: documents as received.
 *
 * Item reads ask only for the organization's items (at most a window, or a page at a time for a
 * complete read), and filter by domain and status in memory: a small business holds few facts, and
 * no composite index is needed.
 */
export const KNOWLEDGE_ITEMS = 'knowledgeItems';
export const KNOWLEDGE_VERSIONS = 'knowledgeVersions';
export const KNOWLEDGE_CONFLICTS = 'knowledgeConflicts';
export const KNOWLEDGE_DOCUMENTS = 'knowledgeDocuments';

const DOC_ID = /^[\w-]{1,300}$/;

function owned<T extends { readonly organizationId: string }>(
  data: unknown,
  organizationId: OrganizationId,
): T | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  return (data as T).organizationId === organizationId ? Object.freeze(data as T) : undefined;
}

export class FirestoreKnowledgeRepository implements KnowledgeRepository {
  constructor(private readonly db: Firestore) {}

  async findItem(organizationId: OrganizationId, id: string) {
    if (!isOrganizationId(organizationId) || !DOC_ID.test(id)) return undefined;
    const snapshot = await this.db.collection(KNOWLEDGE_ITEMS).doc(id).get();
    return owned<KnowledgeItem>(snapshot.data(), organizationId);
  }

  async listItems(organizationId: OrganizationId, filter: KnowledgeFilter, limit: number) {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(KNOWLEDGE_ITEMS)
      .where('organizationId', '==', organizationId)
      .limit(limit)
      .get();
    return snapshot.docs
      .map((d) => owned<KnowledgeItem>(d.data(), organizationId))
      .filter(
        (item): item is KnowledgeItem =>
          item !== undefined &&
          (filter.domains === undefined || filter.domains.includes(item.domain)) &&
          (filter.statuses === undefined || filter.statuses.includes(item.status)),
      );
  }

  /**
   * One page in document-id order (ADR-0187): one equality and the document id as the order, which the
   * automatic single-field index serves, so no composite index is needed. The cursor and the page's
   * fullness come from the stored documents, so an item this read drops cannot end the walk early.
   */
  async pageItems(
    organizationId: OrganizationId,
    page: { readonly after?: string; readonly limit: number },
  ) {
    if (!isOrganizationId(organizationId) || !Number.isSafeInteger(page.limit) || page.limit < 1) {
      return { items: [] };
    }
    let query = this.db
      .collection(KNOWLEDGE_ITEMS)
      .where('organizationId', '==', organizationId)
      .orderBy(FieldPath.documentId());
    if (page.after !== undefined) query = query.startAfter(page.after);
    const snapshot = await query.limit(page.limit).get();
    const last = snapshot.docs[snapshot.docs.length - 1];
    return {
      items: snapshot.docs
        .map((d) => owned<KnowledgeItem>(d.data(), organizationId))
        .filter((item): item is KnowledgeItem => item !== undefined),
      ...(last !== undefined && snapshot.size === page.limit ? { next: last.id } : {}),
    };
  }

  /**
   * How many items the organization holds: an aggregation over the same single equality the pages read by
   * (ADR-0187). It returns a number, not documents, and Firestore bills it per index entry it reads.
   */
  async countItems(organizationId: OrganizationId) {
    if (!isOrganizationId(organizationId)) return 0;
    const snapshot = await this.db
      .collection(KNOWLEDGE_ITEMS)
      .where('organizationId', '==', organizationId)
      .count()
      .get();
    return snapshot.data().count;
  }

  async listVersions(organizationId: OrganizationId, itemId: string) {
    if (!isOrganizationId(organizationId) || !DOC_ID.test(itemId)) return [];
    const snapshot = await this.db
      .collection(KNOWLEDGE_VERSIONS)
      .where('organizationId', '==', organizationId)
      .where('itemId', '==', itemId)
      .get();
    return snapshot.docs
      .map((d) => owned<KnowledgeVersion>(d.data(), organizationId))
      .filter((v): v is KnowledgeVersion => v !== undefined)
      .sort((a, b) => a.revision - b.revision);
  }

  async findConflict(organizationId: OrganizationId, id: string) {
    if (!isOrganizationId(organizationId) || !DOC_ID.test(id)) return undefined;
    const snapshot = await this.db.collection(KNOWLEDGE_CONFLICTS).doc(id).get();
    return owned<KnowledgeConflict>(snapshot.data(), organizationId);
  }

  async listConflicts(organizationId: OrganizationId, status: KnowledgeConflict['status']) {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(KNOWLEDGE_CONFLICTS)
      .where('organizationId', '==', organizationId)
      .where('status', '==', status)
      .get();
    return snapshot.docs
      .map((d) => owned<KnowledgeConflict>(d.data(), organizationId))
      .filter((c): c is KnowledgeConflict => c !== undefined);
  }

  async findDocument(organizationId: OrganizationId, id: string) {
    if (!isOrganizationId(organizationId) || !DOC_ID.test(id)) return undefined;
    const snapshot = await this.db.collection(KNOWLEDGE_DOCUMENTS).doc(id).get();
    return owned<KnowledgeDocument>(snapshot.data(), organizationId);
  }

  write<T>(
    organizationId: OrganizationId,
    read: { readonly itemIds: readonly string[]; readonly conflictIds?: readonly string[] },
    change: Parameters<KnowledgeRepository['write']>[2],
  ): Promise<T> {
    if (!isOrganizationId(organizationId)) throw new Error('invalid organization');
    const itemRefs = read.itemIds.map((id) => this.db.collection(KNOWLEDGE_ITEMS).doc(id));
    const conflictRefs = (read.conflictIds ?? []).map((id) =>
      this.db.collection(KNOWLEDGE_CONFLICTS).doc(id),
    );
    // Firestore runs this again when a read document changed before the commit, so `change`
    // always decides on what it replaces.
    return this.db.runTransaction(async (t) => {
      const snapshots = await Promise.all([...itemRefs, ...conflictRefs].map((r) => t.get(r)));
      const items = new Map<string, KnowledgeItem>();
      const conflicts = new Map<string, KnowledgeConflict>();
      snapshots.forEach((snapshot, i) => {
        if (i < itemRefs.length) {
          const item = owned<KnowledgeItem>(snapshot.data(), organizationId);
          if (item !== undefined) items.set(snapshot.id, item);
        } else {
          const conflict = owned<KnowledgeConflict>(snapshot.data(), organizationId);
          if (conflict !== undefined) conflicts.set(snapshot.id, conflict);
        }
      });
      const { write, result } = change({ items, conflicts });
      if (write !== undefined) this.#apply(t, organizationId, items, write);
      return result as T;
    });
  }

  #apply(
    t: Transaction,
    organizationId: OrganizationId,
    current: ReadonlyMap<string, KnowledgeItem>,
    write: KnowledgeWrite,
  ): void {
    checkWrite(organizationId, current, write);
    for (const item of write.items) t.set(this.db.collection(KNOWLEDGE_ITEMS).doc(item.id), item);
    for (const version of write.versions) {
      t.create(
        this.db.collection(KNOWLEDGE_VERSIONS).doc(`${version.itemId}_${version.revision}`),
        version,
      );
    }
    for (const conflict of write.conflicts) {
      t.set(this.db.collection(KNOWLEDGE_CONFLICTS).doc(conflict.id), conflict);
    }
    for (const document of write.documents ?? []) {
      t.set(this.db.collection(KNOWLEDGE_DOCUMENTS).doc(document.id), document);
    }
    for (const event of write.events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
