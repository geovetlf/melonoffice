import type { InvoicingSyncJob } from '@melonoffice/domain';
import { isDecimal, sumAmounts } from './model.js';

/**
 * Figures and cost estimates for the Billing Integration Gateway (ADR-0193). Every figure is a
 * count of what syncs recorded, so it can be checked against the syncs themselves. A cost is only
 * estimated from unit costs someone supplied with their source; nothing here knows a price, and
 * a missing unit cost makes the estimate `unknown`, never zero.
 */

export interface InvoicingUsage {
  readonly organizationId: string;
  readonly provider: string;
  readonly connectionId: string;
  readonly syncs: number;
  readonly byTrigger: Readonly<Record<InvoicingSyncJob['trigger'], number>>;
  readonly byStatus: Readonly<Record<InvoicingSyncJob['status'], number>>;
  readonly pagesRead: number;
  readonly providerCalls: number;
  /** Records the provider returned. */
  readonly recordsSeen: number;
  /** Created + updated + unchanged + rejected: every record a sync handled. */
  readonly documentsProcessed: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly rejected: number;
  readonly bytesRead: number;
  /** Syncs per day over the period, from the first to the last sync started in it. */
  readonly syncsPerDay?: number;
  /** The median time between two syncs started in the period, in minutes. */
  readonly medianMinutesBetweenSyncs?: number;
}

const zero = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** Usage per organization, provider and connection, from the syncs started in a period. */
export function usageOf(
  jobs: readonly InvoicingSyncJob[],
  period: { readonly from: string; readonly to: string },
): readonly InvoicingUsage[] {
  const groups = new Map<string, InvoicingSyncJob[]>();
  for (const job of jobs) {
    if (job.createdAt < period.from || job.createdAt >= period.to) continue;
    const key = `${job.organizationId}\u0000${job.provider}\u0000${job.connectionId}`;
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as InvoicingSyncJob;
    const byTrigger = zero(['manual', 'webhook', 'schedule', 'file_import'] as const);
    const byStatus = zero(['queued', 'running', 'completed', 'incomplete', 'failed'] as const);
    const sum = {
      pagesRead: 0,
      providerCalls: 0,
      recordsSeen: 0,
      created: 0,
      updated: 0,
      unchanged: 0,
      rejected: 0,
      bytesRead: 0,
    };
    for (const job of group) {
      byTrigger[job.trigger] += 1;
      byStatus[job.status] += 1;
      for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += job.counts[k];
    }
    const starts = group.map((j) => Date.parse(j.createdAt)).sort((a, b) => a - b);
    const gaps = starts
      .slice(1)
      .map((t, i) => t - (starts[i] as number))
      .sort((a, b) => a - b);
    const span = (starts.at(-1) as number) - (starts[0] as number);
    const median =
      gaps.length === 0
        ? undefined
        : gaps.length % 2 === 1
          ? (gaps[(gaps.length - 1) / 2] as number)
          : ((gaps[gaps.length / 2 - 1] as number) + (gaps[gaps.length / 2] as number)) / 2;
    return Object.freeze({
      organizationId: first.organizationId,
      provider: first.provider,
      connectionId: first.connectionId,
      syncs: group.length,
      byTrigger,
      byStatus,
      ...sum,
      documentsProcessed: sum.created + sum.updated + sum.unchanged + sum.rejected,
      ...(span > 0 ? { syncsPerDay: (group.length - 1) / (span / 86_400_000) } : {}),
      ...(median === undefined ? {} : { medianMinutesBetweenSyncs: median / 60_000 }),
    });
  });
}

/** What one unit costs, and where that figure comes from (a provider's price page, an invoice). */
export interface UnitCost {
  /** Decimal string, e.g. `"0.002"`. */
  readonly amount: string;
  readonly currency: string;
  /** Required: an estimate without a source is not verifiable. */
  readonly source: string;
}

export type CostDriver = 'providerCall' | 'documentProcessed' | 'megabyteRead' | 'sync';

export type CostEstimate =
  | {
      readonly status: 'estimated';
      readonly total: { readonly value: string; readonly currency: string };
      /** Each line: quantity × unit cost, with its source, so anyone can redo the sum. */
      readonly lines: readonly {
        readonly driver: CostDriver;
        readonly quantity: string;
        readonly unit: UnitCost;
        readonly subtotal: string;
      }[];
    }
  | { readonly status: 'unknown'; readonly missing: readonly CostDriver[] };

const SCALE = 10n ** 10n;
const toUnits = (value: string): bigint => {
  const negative = value.startsWith('-');
  const [w, f = ''] = (negative ? value.slice(1) : value).split('.');
  const u = BigInt(w as string) * SCALE + BigInt(f.padEnd(10, '0').slice(0, 10));
  return negative ? -u : u;
};
const fromUnits = (u: bigint): string => {
  const neg = u < 0n;
  const a = neg ? -u : u;
  const f = (a % SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return `${neg && a !== 0n ? '-' : ''}${a / SCALE}${f.length > 0 ? `.${f}` : ''}`;
};
/** `quantity × unit`, exact, kept to 10 decimals (truncated). */
const times = (quantity: string, unit: string): string =>
  fromUnits((toUnits(quantity) * toUnits(unit)) / SCALE);

/**
 * Estimates the cost of a usage from the drivers the caller priced. Every driver the caller lists
 * in `drivers` must have a unit cost with a source; otherwise the answer is `unknown` with what is
 * missing. All unit costs must share one currency.
 */
export function estimateCost(
  usage: InvoicingUsage,
  drivers: readonly CostDriver[],
  unitCosts: Partial<Record<CostDriver, UnitCost>>,
): CostEstimate {
  const missing = drivers.filter((d) => {
    const u = unitCosts[d];
    return (
      u === undefined ||
      !isDecimal(u.amount) ||
      u.amount.startsWith('-') ||
      !/^[A-Z]{3}$/.test(u.currency) ||
      u.source.trim().length === 0
    );
  });
  if (missing.length > 0 || drivers.length === 0) {
    return { status: 'unknown', missing: drivers.length === 0 ? ['sync'] : missing };
  }
  const currency = (unitCosts[drivers[0] as CostDriver] as UnitCost).currency;
  if (drivers.some((d) => (unitCosts[d] as UnitCost).currency !== currency)) {
    return { status: 'unknown', missing: drivers };
  }
  const quantityOf: Record<CostDriver, string> = {
    providerCall: String(usage.providerCalls),
    documentProcessed: String(usage.documentsProcessed),
    megabyteRead: fromUnits((BigInt(usage.bytesRead) * SCALE) / 1_000_000n),
    sync: String(usage.syncs),
  };
  const lines = drivers.map((driver) => {
    const unit = unitCosts[driver] as UnitCost;
    return {
      driver,
      quantity: quantityOf[driver],
      unit,
      subtotal: times(quantityOf[driver], unit.amount),
    };
  });
  return {
    status: 'estimated',
    total: sumAmounts(
      lines.map((l) => ({ value: l.subtotal, currency })),
      currency,
    ),
    lines,
  };
}
