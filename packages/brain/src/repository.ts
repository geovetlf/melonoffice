import type { AuditEvent } from '@melonoffice/audit';
import type {
  KnowledgeConflict,
  KnowledgeDocument,
  KnowledgeDomain,
  KnowledgeItem,
  KnowledgeStatus,
  KnowledgeVersion,
  OrganizationId,
} from '@melonoffice/domain';

/**
 * What one change to Company Brain writes, together or not at all: items, their versions, any
 * conflict and the audit events that record it (ADR-0051).
 */
export interface KnowledgeWrite {
  readonly items: readonly KnowledgeItem[];
  readonly versions: readonly KnowledgeVersion[];
  readonly conflicts: readonly KnowledgeConflict[];
  readonly events: readonly AuditEvent[];
  readonly documents?: readonly KnowledgeDocument[];
}

export interface KnowledgeFilter {
  readonly domains?: readonly KnowledgeDomain[];
  readonly statuses?: readonly KnowledgeStatus[];
}

/** One page of an organization's items, and where the next page starts. */
export interface KnowledgePage {
  readonly items: readonly KnowledgeItem[];
  /** Where the next page starts, after this id. Absent on the walk's last page. */
  readonly next?: string;
}

/**
 * Where Company Brain lives: `knowledgeItems`, `knowledgeVersions`, `knowledgeConflicts` and
 * `knowledgeDocuments` in Firestore, memory in tests. Every read and write names the
 * organization, and a record of another organization is never returned.
 */
export interface KnowledgeRepository {
  findItem(organizationId: OrganizationId, id: string): Promise<KnowledgeItem | undefined>;
  /** At most `limit` items, in no particular order. */
  listItems(
    organizationId: OrganizationId,
    filter: KnowledgeFilter,
    limit: number,
  ): Promise<readonly KnowledgeItem[]>;
  /**
   * One page of the organization's items in document-id order, after `page.after` (exclusive). `next`
   * is set only on a full page, so a short page ends the walk.
   */
  pageItems(
    organizationId: OrganizationId,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<KnowledgePage>;
  /** How many items the organization holds, counted with the filter the pages read by. */
  countItems(organizationId: OrganizationId): Promise<number>;
  listVersions(
    organizationId: OrganizationId,
    itemId: string,
  ): Promise<readonly KnowledgeVersion[]>;
  findConflict(organizationId: OrganizationId, id: string): Promise<KnowledgeConflict | undefined>;
  listConflicts(
    organizationId: OrganizationId,
    status: KnowledgeConflict['status'],
  ): Promise<readonly KnowledgeConflict[]>;
  /**
   * Reads the named items and conflicts, and stores what `change` returns in one transaction.
   * `change` may run again if they changed meanwhile; `undefined` stores nothing.
   */
  write<T>(
    organizationId: OrganizationId,
    read: { readonly itemIds: readonly string[]; readonly conflictIds?: readonly string[] },
    change: (current: {
      readonly items: ReadonlyMap<string, KnowledgeItem>;
      readonly conflicts: ReadonlyMap<string, KnowledgeConflict>;
    }) => { readonly write?: KnowledgeWrite; readonly result: T },
  ): Promise<T>;
  findDocument(organizationId: OrganizationId, id: string): Promise<KnowledgeDocument | undefined>;
  /**
   * Runs `read` against one view of the items as they stood when it began, so every page it reads is
   * from the same moment (ADR-0132). A storage that cannot give one runs `read` on the live items.
   */
  snapshot?<T>(read: (view: KnowledgeReader) => Promise<T>): Promise<T>;
}

/** The read methods of a repository: all a snapshot gives, so a read cannot write. */
export type KnowledgeReader = Omit<KnowledgeRepository, 'write' | 'snapshot'>;

/** Checks a write belongs to its organization and bumps revisions by exactly one. */
export function checkWrite(
  organizationId: OrganizationId,
  current: ReadonlyMap<string, KnowledgeItem>,
  write: KnowledgeWrite,
): void {
  for (const item of write.items) {
    if (item.organizationId !== organizationId) throw new Error('knowledge organization');
    if (item.revision !== (current.get(item.id)?.revision ?? 0) + 1) {
      throw new Error('knowledge_concurrency_conflict');
    }
  }
  for (const record of [...write.versions, ...write.conflicts, ...(write.documents ?? [])]) {
    if (record.organizationId !== organizationId) throw new Error('knowledge organization');
  }
  for (const event of write.events) {
    if (event.organizationId !== organizationId) throw new Error('audit_event_organization');
  }
}

/** For tests and local runs only. */
export class InMemoryKnowledgeRepository implements KnowledgeRepository {
  readonly #items = new Map<string, KnowledgeItem>();
  readonly #versions: KnowledgeVersion[] = [];
  readonly #conflicts = new Map<string, KnowledgeConflict>();
  readonly #documents = new Map<string, KnowledgeDocument>();

  constructor(private readonly audit: { append(events: readonly AuditEvent[]): Promise<void> }) {}

  async findItem(organizationId: OrganizationId, id: string) {
    const item = this.#items.get(id);
    return item?.organizationId === organizationId ? item : undefined;
  }

  async listItems(organizationId: OrganizationId, filter: KnowledgeFilter, limit: number) {
    return [...this.#items.values()]
      .filter(
        (item) =>
          item.organizationId === organizationId &&
          (filter.domains === undefined || filter.domains.includes(item.domain)) &&
          (filter.statuses === undefined || filter.statuses.includes(item.status)),
      )
      .slice(0, limit);
  }

  async pageItems(
    organizationId: OrganizationId,
    page: { readonly after?: string; readonly limit: number },
  ) {
    const items = [...this.#items.values()]
      .filter(
        (item) =>
          item.organizationId === organizationId &&
          (page.after === undefined || item.id > page.after),
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, page.limit);
    const last = items.at(-1);
    return {
      items,
      ...(last !== undefined && items.length === page.limit ? { next: last.id } : {}),
    };
  }

  async countItems(organizationId: OrganizationId) {
    return [...this.#items.values()].filter((item) => item.organizationId === organizationId)
      .length;
  }

  async listVersions(organizationId: OrganizationId, itemId: string) {
    return this.#versions
      .filter((v) => v.organizationId === organizationId && v.itemId === itemId)
      .sort((a, b) => a.revision - b.revision);
  }

  async findConflict(organizationId: OrganizationId, id: string) {
    const conflict = this.#conflicts.get(id);
    return conflict?.organizationId === organizationId ? conflict : undefined;
  }

  async listConflicts(organizationId: OrganizationId, status: KnowledgeConflict['status']) {
    return [...this.#conflicts.values()].filter(
      (c) => c.organizationId === organizationId && c.status === status,
    );
  }

  async write<T>(
    organizationId: OrganizationId,
    read: { readonly itemIds: readonly string[]; readonly conflictIds?: readonly string[] },
    change: Parameters<KnowledgeRepository['write']>[2],
  ): Promise<T> {
    const items = new Map<string, KnowledgeItem>();
    for (const id of read.itemIds) {
      const item = await this.findItem(organizationId, id);
      if (item !== undefined) items.set(id, item);
    }
    const conflicts = new Map<string, KnowledgeConflict>();
    for (const id of read.conflictIds ?? []) {
      const conflict = await this.findConflict(organizationId, id);
      if (conflict !== undefined) conflicts.set(id, conflict);
    }
    const { write, result } = change({ items, conflicts });
    if (write !== undefined) {
      checkWrite(organizationId, items, write);
      await this.audit.append(write.events);
      for (const item of write.items) this.#items.set(item.id, item);
      this.#versions.push(...write.versions);
      for (const conflict of write.conflicts) this.#conflicts.set(conflict.id, conflict);
      for (const document of write.documents ?? []) this.#documents.set(document.id, document);
    }
    return result as T;
  }

  async findDocument(organizationId: OrganizationId, id: string) {
    const document = this.#documents.get(id);
    return document?.organizationId === organizationId ? document : undefined;
  }

  /**
   * The live items: nothing here writes while a read runs, unless a test makes it. A test that needs a write
   * during a read gives its own repository, with a copy as its snapshot.
   */
  async snapshot<T>(read: (view: KnowledgeReader) => Promise<T>): Promise<T> {
    return read(this);
  }
}
