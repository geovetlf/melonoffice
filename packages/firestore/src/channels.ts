import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type {
  ChannelConnection,
  ChannelConnectionId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import {
  checkNextConnection,
  checkStoredConnection,
  IntegrationError,
  isConnectionId,
  type ChannelConnectionRepository,
  type ConnectionWrite,
} from '@melonoffice/integrations';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `channelConnections/{connectionId}`: an organization's connection to an outside service
 * (ADR-0033, ADR-0044): provider, lifecycle status, capabilities and account. Only
 * non-sensitive configuration and secret references (resource names derived from the id); a
 * secret value is never written here.
 */
export const CHANNEL_CONNECTIONS = 'channelConnections';

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;

export function toConnectionDocument(c: ChannelConnection): Record<string, unknown> {
  return {
    organizationId: c.organizationId,
    provider: c.provider,
    category: c.category,
    channel: c.channel,
    status: c.status,
    statusReason: c.statusReason ?? null,
    displayName: c.displayName,
    account: {
      phoneNumberId: c.account.phoneNumberId,
      businessAccountId: c.account.businessAccountId ?? null,
      displayPhoneNumber: c.account.displayPhoneNumber ?? null,
    },
    capabilities: {
      inboundText: c.capabilities.inboundText,
      inboundMedia: c.capabilities.inboundMedia,
      outboundText: c.capabilities.outboundText,
      outboundMedia: c.capabilities.outboundMedia,
      outboundTemplates: c.capabilities.outboundTemplates,
      deliveryStatus: c.capabilities.deliveryStatus,
      maxOutboundTextLength: c.capabilities.maxOutboundTextLength,
      serviceWindowMs: c.capabilities.serviceWindowMs ?? null,
    },
    secrets: { ...c.secrets },
    createdAt: ts(c.createdAt),
    createdBy: c.createdBy,
    updatedAt: ts(c.updatedAt),
    updatedBy: c.updatedBy,
    lastValidatedAt: c.lastValidatedAt === undefined ? null : ts(c.lastValidatedAt),
    revision: c.revision,
  };
}

function toConnection(id: string, d: Record<string, unknown>): ChannelConnection {
  const account = d.account as Record<string, string | null>;
  const capabilities = (d.capabilities ?? {}) as Record<string, unknown>;
  const connection = {
    id,
    organizationId: d.organizationId,
    provider: d.provider,
    category: d.category,
    channel: d.channel,
    status: d.status,
    ...(d.statusReason == null ? {} : { statusReason: d.statusReason }),
    displayName: d.displayName,
    account: {
      phoneNumberId: account.phoneNumberId,
      ...(account.businessAccountId == null
        ? {}
        : { businessAccountId: account.businessAccountId }),
      ...(account.displayPhoneNumber == null
        ? {}
        : { displayPhoneNumber: account.displayPhoneNumber }),
    },
    capabilities: {
      inboundText: capabilities.inboundText,
      inboundMedia: capabilities.inboundMedia,
      outboundText: capabilities.outboundText,
      outboundMedia: capabilities.outboundMedia,
      outboundTemplates: capabilities.outboundTemplates,
      deliveryStatus: capabilities.deliveryStatus,
      maxOutboundTextLength: capabilities.maxOutboundTextLength,
      ...(capabilities.serviceWindowMs == null
        ? {}
        : { serviceWindowMs: capabilities.serviceWindowMs }),
    },
    secrets: { ...(d.secrets as Record<string, string>) },
    createdAt: iso(d.createdAt as FirestoreTimestamp),
    createdBy: d.createdBy,
    updatedAt: iso(d.updatedAt as FirestoreTimestamp),
    updatedBy: d.updatedBy,
    ...(d.lastValidatedAt == null
      ? {}
      : { lastValidatedAt: iso(d.lastValidatedAt as FirestoreTimestamp) }),
    revision: d.revision,
  } as unknown as ChannelConnection;
  try {
    return Object.freeze(checkStoredConnection(connection));
  } catch {
    throw new Error('invalid channel connection record');
  }
}

export class FirestoreChannelConnectionRepository implements ChannelConnectionRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, id: ChannelConnectionId) {
    if (!isOrganizationId(organizationId) || !isConnectionId(id)) return undefined;
    const snapshot = await this.db.collection(CHANNEL_CONNECTIONS).doc(id).get();
    const data = snapshot.data();
    if (data?.organizationId !== organizationId) return undefined;
    return toConnection(snapshot.id, data);
  }

  async findForDelivery(id: ChannelConnectionId) {
    if (!isConnectionId(id)) return undefined;
    const snapshot = await this.db.collection(CHANNEL_CONNECTIONS).doc(id).get();
    const data = snapshot.data();
    return data === undefined ? undefined : toConnection(snapshot.id, data);
  }

  async list(organizationId: OrganizationId) {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(CHANNEL_CONNECTIONS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toConnection(doc.id, doc.data()))
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async create({ connection, events }: ConnectionWrite) {
    checkStoredConnection(connection);
    await this.db.runTransaction(async (t) => {
      t.create(
        this.db.collection(CHANNEL_CONNECTIONS).doc(connection.id),
        toConnectionDocument(connection),
      );
      this.#append(t, events);
    });
  }

  async update(
    organizationId: OrganizationId,
    id: ChannelConnectionId,
    change: (current: ChannelConnection) => ConnectionWrite,
  ) {
    if (!isOrganizationId(organizationId) || !isConnectionId(id)) {
      throw new IntegrationError('connection_not_found');
    }
    const doc = this.db.collection(CHANNEL_CONNECTIONS).doc(id);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data();
      if (data?.organizationId !== organizationId) {
        throw new IntegrationError('connection_not_found');
      }
      const current = toConnection(snapshot.id, data);
      const { connection, events } = change(current);
      checkNextConnection(current, connection);
      t.set(doc, toConnectionDocument(connection));
      this.#append(t, events);
      return connection;
    });
  }

  #append(t: Transaction, events: readonly AuditEvent[]): void {
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
