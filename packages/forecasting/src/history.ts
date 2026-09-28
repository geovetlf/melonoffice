import type { OrganizationId } from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import {
  FORECAST_LIMITS,
  FORECAST_METRICS,
  findForecastMetric,
  type ForecastLimits,
  type ForecastMetric,
} from './catalogue.js';
import type { ForecastContextPort } from './engine.js';
import { ForecastError } from './errors.js';
import {
  addPeriods,
  isForecastFrequency,
  isTimeZone,
  lastCompletePeriod,
  localDateOf,
  periodOf,
  type ForecastFrequency,
} from './periods.js';
import { prepareSeries, type InsufficientCount, type SeriesProblem } from './series.js';
import { isEntityOf, type SeriesSource } from './sources.js';

/**
 * What happened, per period, for a metric of the catalogue (ADR-0060): the same metrics, the same
 * sources and the same permissions as the Forecasting Engine, read without the model. Reports,
 * department screens and GIA read recorded figures here and projections from the engine, so a
 * figure that happened and an estimate never come from the same place.
 *
 * Nothing here runs a model, charges credits or writes anything. Every figure is added up from
 * the organization's own records in the business's time zone; a period with no record is zero
 * only because the metric declares it (`absentPeriod: zero`), never by guessing.
 */

/** How many periods a read covers when none is asked, and the most it may. */
export const METRIC_HISTORY_PERIODS = Object.freeze({
  default: Object.freeze({ day: 30, week: 12, month: 12 }),
  max: Object.freeze({ day: 366, week: 104, month: 36 }),
} satisfies Record<'default' | 'max', Record<ForecastFrequency, number>>);

export interface MetricHistoryInput {
  readonly metric: unknown;
  readonly frequency?: unknown;
  readonly periods?: unknown;
  readonly entity?: unknown;
}

export interface MetricHistoryPoint {
  readonly period: string;
  readonly value: number;
}

/**
 * Whether the recorded history is enough for a projection, counted exactly as the engine counts
 * it before running the model. `ready: false` with a `problem` other than `insufficient_data`
 * means the history exists but cannot be read as a series.
 */
export type MetricReadiness =
  | { readonly ready: true; readonly have: number; readonly need: number }
  | {
      readonly ready: false;
      readonly problem: SeriesProblem;
      readonly have: number | null;
      readonly need: number | null;
      readonly shortOf: InsufficientCount | null;
    };

export interface MetricHistory {
  readonly metric: string;
  readonly unit: ForecastMetric['unit'];
  /** The currency of a money metric, or the source kind or channel (`all` when none). */
  readonly entity: string;
  readonly frequency: ForecastFrequency;
  readonly timeZone: string;
  /** The complete periods read, oldest first: the first and the last. */
  readonly from: string;
  readonly to: string;
  readonly points: readonly MetricHistoryPoint[];
  /** The total and the average per period of `points`. */
  readonly total: number;
  readonly average: number;
  /**
   * The total of the same number of complete periods just before `from`; null when nothing was
   * recorded before `from`, so a first month is never compared with an invented zero.
   */
  readonly previousTotal: number | null;
  /** The period under way, so far. It is never part of `points`, the totals or the comparison. */
  readonly current: MetricHistoryPoint;
  /** The first period with a record, or null when there is none at all. */
  readonly firstRecord: string | null;
  readonly readiness: MetricReadiness;
}

/** A metric as a report offers it: whether this person may read it. */
export interface MetricView {
  readonly id: string;
  readonly unit: ForecastMetric['unit'];
  readonly entity: ForecastMetric['entity'];
  readonly frequencies: readonly ForecastFrequency[];
  readonly departments: readonly string[];
  readonly readable: boolean;
}

export interface MetricHistoryService {
  /** The catalogue's metrics, each with whether this person may read its records. */
  metrics(tenant: TenantContext): readonly MetricView[];
  /** The recorded history of one metric: `report.read` and the permission of its records. */
  history(tenant: TenantContext, input: MetricHistoryInput): Promise<MetricHistory>;
}

export function createMetricHistory(options: {
  readonly sources: Readonly<Record<string, SeriesSource>>;
  readonly context: ForecastContextPort;
  readonly tenancy: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly limits?: Pick<ForecastLimits, 'maxContext' | 'minHistory' | 'minNonZero'>;
  readonly now?: () => Date;
}): MetricHistoryService {
  const { sources, context, tenancy, authorization, limits = FORECAST_LIMITS } = options;
  const now = options.now ?? (() => new Date());
  const can = (tenant: TenantContext, permission: string) =>
    authorization.authorize(tenant, permission).allowed;

  async function activeOrganization(organizationId: OrganizationId): Promise<boolean> {
    const organization = await tenancy.findOrganization(organizationId);
    return organization?.id === organizationId && organization.status === 'active';
  }

  return Object.freeze({
    metrics(tenant: TenantContext) {
      return FORECAST_METRICS.map((m) =>
        Object.freeze({
          id: m.id,
          unit: m.unit,
          entity: m.entity,
          frequencies: m.frequencies,
          departments: m.departments,
          readable:
            isResolvedTenant(tenant) &&
            tenant.actor !== 'runtime' &&
            can(tenant, 'report.read') &&
            can(tenant, m.permission),
        }),
      );
    },

    async history(tenant: TenantContext, input: MetricHistoryInput) {
      if (!isResolvedTenant(tenant)) throw new ForecastError('unresolved_tenant');
      // A person, directly or through GIA (who keeps the person's permissions). Never the runtime.
      if (tenant.actor === 'runtime') throw new ForecastError('permission_denied');
      if (!can(tenant, 'report.read')) throw new ForecastError('permission_denied');
      const metric = findForecastMetric(input.metric);
      if (metric === undefined) throw new ForecastError('metric_not_found');
      // The records themselves: whoever may not read them may not have them added up.
      if (!can(tenant, metric.permission)) throw new ForecastError('permission_denied');
      const frequency = input.frequency ?? 'day';
      if (!isForecastFrequency(frequency)) throw new ForecastError('invalid_request', 'frequency');
      if (!metric.frequencies.includes(frequency)) {
        throw new ForecastError('frequency_not_supported');
      }
      const periods = input.periods ?? METRIC_HISTORY_PERIODS.default[frequency];
      if (
        typeof periods !== 'number' ||
        !Number.isSafeInteger(periods) ||
        periods < 1 ||
        periods > METRIC_HISTORY_PERIODS.max[frequency]
      ) {
        throw new ForecastError('invalid_request', 'periods');
      }
      const organizationId = tenant.organizationId;
      if (!(await activeOrganization(organizationId))) {
        throw new ForecastError('organization_inactive');
      }
      const business = await context.of(organizationId);
      if (business === undefined || !isTimeZone(business.timeZone)) {
        throw new ForecastError('invalid_request', 'business_context');
      }
      const entity =
        (input.entity as string | undefined) ??
        (metric.entity === 'currency' ? business.currency : 'all');
      if (!isEntityOf(metric, entity)) throw new ForecastError('invalid_request', 'entity');
      const source = sources[metric.id];
      if (source === undefined) throw new ForecastError('metric_not_found');

      const at = now();
      const current = periodOf(localDateOf(at, business.timeZone), frequency);
      const to = lastCompletePeriod(at, business.timeZone, frequency);
      const from = addPeriods(to, 1 - periods, frequency);
      const before = addPeriods(from, -periods, frequency);
      // One read up to the period under way; the source adds records into periods.
      const recorded = await source.read({
        organizationId,
        entity,
        frequency,
        timeZone: business.timeZone,
        end: current,
      });
      const byPeriod = new Map(recorded.map((p) => [p.timestamp, p.value]));
      const valueOf = (period: string) => byPeriod.get(period) ?? 0;
      const window = (start: string, count: number) =>
        Array.from({ length: count }, (_, i) => addPeriods(start, i, frequency));

      const points = window(from, periods).map((period) =>
        Object.freeze({ period, value: valueOf(period) }),
      );
      const total = points.reduce((sum, p) => sum + p.value, 0);
      const firstRecord = recorded.map((p) => p.timestamp).sort()[0] ?? null;
      const previousTotal =
        firstRecord === null || firstRecord >= from
          ? null
          : window(before, periods).reduce((sum, period) => sum + valueOf(period), 0);

      // The engine's own preparation, over the complete periods it would send to the model.
      const complete = recorded.filter((p) => p.timestamp <= to);
      const prepared = prepareSeries(complete, { metric, frequency, end: to, limits });
      const readiness: MetricReadiness = prepared.ok
        ? Object.freeze({
            ready: true,
            have: prepared.series.values.length,
            need: limits.minHistory[frequency],
          })
        : Object.freeze({
            ready: false,
            problem: prepared.problem,
            have: prepared.have ?? null,
            need: prepared.need ?? null,
            shortOf: prepared.shortOf ?? null,
          });

      return Object.freeze({
        metric: metric.id,
        unit: metric.unit,
        entity,
        frequency,
        timeZone: business.timeZone,
        from,
        to,
        points: Object.freeze(points),
        total,
        average: total / periods,
        previousTotal,
        current: Object.freeze({ period: current, value: valueOf(current) }),
        firstRecord,
        readiness,
      });
    },
  });
}
