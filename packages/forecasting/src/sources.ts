import type {
  Contact,
  ContactSourceKind,
  Conversation,
  Opportunity,
  OrganizationId,
} from '@melonoffice/domain';
import type { ForecastMetric } from './catalogue.js';
import { localDateOf, periodOf, type ForecastFrequency } from './periods.js';
import type { SeriesPoint } from './series.js';

/**
 * The records metrics are built from, read through the repositories that already hold them (C1,
 * C2, ADR-0033). Only these reads: a source never writes and never reads another collection.
 */
export interface ForecastRecordsPort {
  listOpportunities(organizationId: OrganizationId): Promise<readonly Opportunity[]>;
  listContacts(organizationId: OrganizationId): Promise<readonly Contact[]>;
  listConversations(organizationId: OrganizationId): Promise<readonly Conversation[]>;
}

/** What a source is asked: whose records, which slice, in which time zone, up to which period. */
export interface SeriesRequest {
  readonly organizationId: OrganizationId;
  readonly entity: string;
  readonly frequency: ForecastFrequency;
  readonly timeZone: string;
  /** The last period to include (the last complete one). Later records are left out. */
  readonly end: string;
}

/**
 * A metric's source: the authorized data access layer (ADR-0059). It aggregates one
 * organization's own records into periods of the business's time zone. The engine checks the
 * person's permission for the metric before asking; the model only ever gets what this returns.
 */
export interface SeriesSource {
  read(request: SeriesRequest): Promise<readonly SeriesPoint[]>;
}

const CONTACT_SOURCES: readonly ContactSourceKind[] = ['channel', 'manual', 'import', 'campaign'];
const CURRENCY = /^[A-Z]{3}$/;
const CHANNEL = /^[a-z][a-z_]{0,31}$/;

/** Whether an entity is valid for a metric: its currency, a source kind, a channel or `all`. */
export function isEntityOf(metric: ForecastMetric, entity: unknown): entity is string {
  if (typeof entity !== 'string') return false;
  switch (metric.entity) {
    case 'currency':
      return CURRENCY.test(entity);
    case 'source_kind':
      return entity === 'all' || (CONTACT_SOURCES as readonly string[]).includes(entity);
    case 'channel':
      return entity === 'all' || CHANNEL.test(entity);
    case 'all':
      return entity === 'all';
  }
}

/** Minor units of a currency (ISO 4217, as the runtime knows it): 2 for PEN, 0 for JPY. */
function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** Adds records into periods: one point per period that has at least one record. */
function aggregate(
  request: SeriesRequest,
  records: Iterable<{ readonly at: string; readonly amount: number }>,
): readonly SeriesPoint[] {
  const sums = new Map<string, number>();
  for (const record of records) {
    const instant = new Date(record.at);
    if (Number.isNaN(instant.getTime())) continue;
    const period = periodOf(localDateOf(instant, request.timeZone), request.frequency);
    if (period > request.end) continue;
    sums.set(period, (sums.get(period) ?? 0) + record.amount);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([timestamp, value]) => Object.freeze({ timestamp, value }));
}

/** The sources of the metrics in the catalogue, over the existing records. */
export function createRecordSources(
  records: ForecastRecordsPort,
): Readonly<Record<string, SeriesSource>> {
  return Object.freeze({
    'sales.won_value': {
      async read(request: SeriesRequest) {
        const digits = minorDigits(request.entity);
        const list = await records.listOpportunities(request.organizationId);
        return aggregate(
          request,
          list.flatMap((o) =>
            o.organizationId === request.organizationId &&
            o.status === 'won' &&
            o.closedAt !== undefined &&
            o.value?.currency === request.entity
              ? [{ at: o.closedAt, amount: o.value.amountMinor / 10 ** digits }]
              : [],
          ),
        );
      },
    },
    'sales.won_count': {
      async read(request: SeriesRequest) {
        const list = await records.listOpportunities(request.organizationId);
        return aggregate(
          request,
          list.flatMap((o) =>
            o.organizationId === request.organizationId &&
            o.status === 'won' &&
            o.closedAt !== undefined
              ? [{ at: o.closedAt, amount: 1 }]
              : [],
          ),
        );
      },
    },
    'opportunities.new': {
      async read(request: SeriesRequest) {
        const list = await records.listOpportunities(request.organizationId);
        return aggregate(
          request,
          list.flatMap((o) =>
            o.organizationId === request.organizationId ? [{ at: o.createdAt, amount: 1 }] : [],
          ),
        );
      },
    },
    'leads.new': {
      async read(request: SeriesRequest) {
        const list = await records.listContacts(request.organizationId);
        return aggregate(
          request,
          list.flatMap((c) =>
            c.organizationId === request.organizationId &&
            c.commercial !== undefined &&
            (request.entity === 'all' || c.commercial.source.kind === request.entity)
              ? [{ at: c.createdAt, amount: 1 }]
              : [],
          ),
        );
      },
    },
    'conversations.new': {
      async read(request: SeriesRequest) {
        const list = await records.listConversations(request.organizationId);
        return aggregate(
          request,
          list.flatMap((c) =>
            c.organizationId === request.organizationId &&
            (request.entity === 'all' || c.channel === request.entity)
              ? [{ at: c.createdAt, amount: 1 }]
              : [],
          ),
        );
      },
    },
  });
}
