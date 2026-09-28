import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import { isTemplateId } from '@melonoffice/conversations';
import type {
  ChannelConnectionId,
  ChannelTemplate,
  ChannelTemplateId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import {
  checkNextTemplate,
  checkStoredTemplate,
  IntegrationError,
  isConnectionId,
  type ChannelTemplateRepository,
  type TemplateWrite,
} from '@melonoffice/integrations';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `channelTemplates/{templateId}` (ADR-0046): an organization's provider-approved template on one
 * connection, by name and language, with what the provider said it needs. The id is derived from
 * the organization, the connection, the name and the language, so registering it twice finds it.
 * No template text, value or link is stored here.
 */
export const CHANNEL_TEMPLATES = 'channelTemplates';

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;

export function toTemplateDocument(t: ChannelTemplate): Record<string, unknown> {
  return {
    organizationId: t.organizationId,
    connectionId: t.connectionId,
    channel: t.channel,
    name: t.name,
    language: t.language,
    status: t.status,
    statusReason: t.statusReason ?? null,
    category: t.category ?? null,
    spec: t.spec === undefined ? null : (JSON.parse(JSON.stringify(t.spec)) as unknown),
    createdAt: ts(t.createdAt),
    createdBy: t.createdBy,
    updatedAt: ts(t.updatedAt),
    updatedBy: t.updatedBy,
    lastValidatedAt: t.lastValidatedAt === undefined ? null : ts(t.lastValidatedAt),
    revision: t.revision,
  };
}

function toTemplate(id: string, d: Record<string, unknown>): ChannelTemplate {
  const template = {
    id,
    organizationId: d.organizationId,
    connectionId: d.connectionId,
    channel: d.channel,
    name: d.name,
    language: d.language,
    status: d.status,
    ...(d.statusReason == null ? {} : { statusReason: d.statusReason }),
    ...(d.category == null ? {} : { category: d.category }),
    ...(d.spec == null ? {} : { spec: d.spec }),
    createdAt: iso(d.createdAt as FirestoreTimestamp),
    createdBy: d.createdBy,
    updatedAt: iso(d.updatedAt as FirestoreTimestamp),
    updatedBy: d.updatedBy,
    ...(d.lastValidatedAt == null
      ? {}
      : { lastValidatedAt: iso(d.lastValidatedAt as FirestoreTimestamp) }),
    revision: d.revision,
  } as unknown as ChannelTemplate;
  try {
    return Object.freeze(checkStoredTemplate(template));
  } catch {
    throw new Error('invalid channel template record');
  }
}

export class FirestoreChannelTemplateRepository implements ChannelTemplateRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, id: ChannelTemplateId) {
    if (!isOrganizationId(organizationId) || !isTemplateId(id)) return undefined;
    const snapshot = await this.db.collection(CHANNEL_TEMPLATES).doc(id).get();
    const data = snapshot.data();
    if (data?.organizationId !== organizationId) return undefined;
    return toTemplate(snapshot.id, data);
  }

  async list(organizationId: OrganizationId, connectionId: ChannelConnectionId) {
    if (!isOrganizationId(organizationId) || !isConnectionId(connectionId)) return [];
    const snapshot = await this.db
      .collection(CHANNEL_TEMPLATES)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toTemplate(doc.id, doc.data()))
      .filter((t) => t.connectionId === connectionId)
      .sort((a, b) => (a.name + a.language < b.name + b.language ? -1 : 1));
  }

  async create({ template, events }: TemplateWrite) {
    checkStoredTemplate(template);
    const doc = this.db.collection(CHANNEL_TEMPLATES).doc(template.id);
    return this.db.runTransaction(async (t) => {
      if ((await t.get(doc)).exists) return false;
      t.create(doc, toTemplateDocument(template));
      this.#append(t, events);
      return true;
    });
  }

  async update(
    organizationId: OrganizationId,
    id: ChannelTemplateId,
    change: (current: ChannelTemplate) => TemplateWrite,
  ) {
    if (!isOrganizationId(organizationId) || !isTemplateId(id)) {
      throw new IntegrationError('template_not_found');
    }
    const doc = this.db.collection(CHANNEL_TEMPLATES).doc(id);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data();
      if (data?.organizationId !== organizationId) throw new IntegrationError('template_not_found');
      const current = toTemplate(snapshot.id, data);
      const { template, events } = change(current);
      checkNextTemplate(current, template);
      t.set(doc, toTemplateDocument(template));
      this.#append(t, events);
      return template;
    });
  }

  #append(t: Transaction, events: readonly AuditEvent[]): void {
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
