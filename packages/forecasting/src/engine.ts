import { actorOf, buildAuditEvent, type AuditEvent, type AuditService } from '@melonoffice/audit';
import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import { withCorrelation, type Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import {
  isResolvedTenant,
  resolveRuntimeTenant,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import { forecastCreditReferenceOf, forecastIdOf, seriesDigestOf } from './cache.js';
import {
  FORECAST_LIMITS,
  FORECAST_METRICS,
  findForecastMetric,
  type ForecastLimits,
  type ForecastMetric,
} from './catalogue.js';
import { ForecastError } from './errors.js';
import { createFallbackProvider } from './fallback.js';
import type {
  Forecast,
  ForecastCovariate,
  ForecastId,
  ForecastModelRef,
  ForecastResult,
  ForecastTask,
} from './model.js';
import {
  addPeriods,
  isForecastFrequency,
  isTimeZone,
  lastCompletePeriod,
  type ForecastFrequency,
} from './periods.js';
import { ForecastProviderError, type ForecastModelProvider } from './provider.js';
import type { ForecastRepository } from './repository.js';
import {
  prepareSeries,
  type DataQuality,
  type InsufficientCount,
  type SeriesProblem,
} from './series.js';
import { isEntityOf, type SeriesSource } from './sources.js';

/**
 * What the engine takes from Company Brain and the business profile (ADR-0048, ADR-0051, ADR-0056):
 * context, never data to forecast. The time zone the periods are read in and the currency money
 * is counted in. The series themselves come from the sources.
 */
export interface ForecastContextPort {
  of(organizationId: OrganizationId): Promise<
    | {
        readonly timeZone: string;
        readonly currency?: string;
      }
    | undefined
  >;
}

/** The existing credits engine (ADR-0023), by `CreditService`'s own signatures. */
export interface ForecastCreditsPort {
  balanceOf(
    tenant: TenantContext,
  ): Promise<
    | { readonly status: 'present'; readonly balance: number }
    | { readonly status: 'unavailable'; readonly reason: string }
  >;
  consume(
    tenant: TenantContext,
    request: { readonly amount: number; readonly referenceId: string; readonly reason: string },
  ): Promise<{ readonly balance: number; readonly replayed: boolean }>;
}

/** Queues a run on the existing job queue (ADR-0032), for the worker. */
export interface ForecastScheduler {
  enqueue(task: ForecastTask): Promise<void>;
}

export interface ForecastRequestInput {
  readonly metric: unknown;
  readonly entity?: unknown;
  readonly frequency?: unknown;
  readonly horizon: unknown;
  /** The department asking (a catalogue type id), when one is. */
  readonly department?: unknown;
  readonly covariates?: unknown;
  /** Wait for the run, up to the limit, instead of answering `queued` at once. */
  readonly wait?: boolean;
}

/**
 * The answer to a request. A request whose data cannot be forecast never runs the model and
 * costs nothing; it says why and, for too little history, how much there is and how much is
 * needed. Everything else is a stored forecast, found (`hit`) or queued now (`miss`).
 */
export type ForecastOutcome =
  | {
      readonly status: 'insufficient_data' | 'invalid_data';
      readonly metric: string;
      readonly entity: string;
      readonly frequency: ForecastFrequency;
      readonly horizon: number;
      readonly problem: SeriesProblem;
      readonly have?: number;
      readonly need?: number;
      readonly shortOf?: InsufficientCount;
      readonly dataQuality?: DataQuality;
    }
  | {
      readonly status: Forecast['status'];
      readonly forecast: Forecast;
      readonly cache: 'hit' | 'miss';
    };

export type ForecastRunResult =
  'completed' | 'fallback' | 'failed' | 'stale' | 'not_found' | 'already_done';

/** A metric as offered to a person: whether they may read it, and its bounds. */
export interface ForecastMetricView {
  readonly id: string;
  readonly unit: ForecastMetric['unit'];
  readonly entity: ForecastMetric['entity'];
  readonly frequencies: readonly ForecastFrequency[];
  readonly maxHorizon: Readonly<Record<ForecastFrequency, number>>;
  readonly departments: readonly string[];
  readonly readable: boolean;
}

export interface ForecastEngine {
  metrics(tenant: TenantContext): readonly ForecastMetricView[];
  request(tenant: TenantContext, input: ForecastRequestInput): Promise<ForecastOutcome>;
  get(tenant: TenantContext, id: unknown): Promise<Forecast>;
  /** The worker's side: runs a queued forecast. Throws when the queue should deliver it again. */
  run(task: ForecastTask, options: { readonly final: boolean }): Promise<ForecastRunResult>;
  /** The queue gave up: keeps the forecast as failed, never silently queued. */
  fail(task: ForecastTask, reason: string): Promise<boolean>;
}

export interface ForecastEngineOptions {
  readonly repository: ForecastRepository;
  readonly sources: Readonly<Record<string, SeriesSource>>;
  /** The model. Absent (the runtime is not deployed here): runs are refused, never pretended. */
  readonly provider?: ForecastModelProvider;
  /**
   * Whether the deterministic fallback may answer when the model fails on its last attempt.
   * Its result always says `kind: 'fallback'`, costs nothing and warns.
   */
  readonly fallback?: 'on_failure' | 'off';
  readonly scheduler?: ForecastScheduler;
  readonly credits: ForecastCreditsPort;
  /**
   * Whole credits one model run costs. Not set: runs are refused (`forecast_price_not_set`).
   * Cache hits, refused requests and the fallback cost nothing.
   */
  readonly creditsPerRun?: number;
  readonly context: ForecastContextPort;
  readonly tenancy: TenancyStore;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly audit: AuditService;
  readonly logger?: Logger;
  readonly limits?: ForecastLimits;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

const MAX_WARNINGS = 10;
const POLL_MS = 500;
const DEPARTMENT = /^[a-z][a-z0-9_]{0,63}$/;
const COVARIATE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks the covariates' shape. A well-formed list is still refused: the runtime has none. */
function checkCovariates(raw: unknown, limits: ForecastLimits): readonly ForecastCovariate[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > limits.maxCovariates) {
    throw new ForecastError('invalid_request', 'covariates');
  }
  for (const c of raw as unknown[]) {
    if (
      !isRecord(c) ||
      typeof c.name !== 'string' ||
      !COVARIATE_NAME.test(c.name) ||
      (c.kind !== 'numeric' && c.kind !== 'categorical') ||
      !Array.isArray(c.values) ||
      c.values.length > limits.maxContext + 128 ||
      !(c.values as unknown[]).every((v) =>
        c.kind === 'numeric'
          ? typeof v === 'number' && Number.isFinite(v)
          : typeof v === 'string' && v.length <= 64,
      )
    ) {
      throw new ForecastError('invalid_request', 'covariates');
    }
  }
  if (raw.length > 0) throw new ForecastError('covariates_not_supported');
  return [];
}

/** Warnings a person should see with the numbers. Codes; the screens and GIA word them. */
function warningsOf(quality: DataQuality, limits: ForecastLimits, frequency: ForecastFrequency) {
  const warnings: string[] = [];
  if (quality.points < 2 * limits.minHistory[frequency]) warnings.push('short_history');
  if (quality.outliers.length > 0) warnings.push('outliers_kept');
  if (quality.absentPeriods > 0) warnings.push('absent_periods_as_zero');
  if (quality.nullValues > 0) warnings.push('null_values_interpolated');
  if (quality.transformations.includes('truncated_to_context')) warnings.push('history_truncated');
  if (quality.nonZero < quality.points / 2) warnings.push('mostly_zero');
  return warnings;
}

export function createForecastEngine(options: ForecastEngineOptions): ForecastEngine {
  const {
    repository,
    sources,
    provider,
    scheduler,
    credits,
    creditsPerRun,
    context,
    tenancy,
    authorization,
    audit,
    fallback = 'on_failure',
    limits = FORECAST_LIMITS,
    now = () => new Date(),
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;
  const logger = options.logger ?? silent;
  if (creditsPerRun !== undefined && (!Number.isSafeInteger(creditsPerRun) || creditsPerRun < 0)) {
    throw new Error('creditsPerRun must be a whole number of credits');
  }
  const can = (tenant: TenantContext, permission: string) =>
    authorization.authorize(tenant, permission).allowed;
  const iso = (date: Date) => date.toISOString() as IsoTimestamp;
  const event = (input: Parameters<typeof buildAuditEvent>[0]): AuditEvent =>
    buildAuditEvent(input, now());

  async function denied(
    tenant: TenantContext,
    code: ForecastError['code'],
    fields: { readonly permission?: string; readonly target?: ForecastId } = {},
  ): Promise<never> {
    if (isResolvedTenant(tenant)) {
      await audit.record({
        action: 'forecast.requested',
        result: 'denied',
        actor: actorOf(tenant),
        organizationId: tenant.organizationId,
        target: { type: 'forecast', id: fields.target ?? 'request' },
        reason: code,
        ...(fields.permission === undefined ? {} : { permission: fields.permission }),
        source: 'api',
      });
    }
    throw new ForecastError(code);
  }

  async function activeOrganization(organizationId: OrganizationId): Promise<boolean> {
    const organization = await tenancy.findOrganization(organizationId);
    return organization?.id === organizationId && organization.status === 'active';
  }

  /** Waits for a queued forecast to finish, up to the limit. */
  async function waitFor(organizationId: OrganizationId, forecast: Forecast): Promise<Forecast> {
    const until = Date.now() + limits.waitMs;
    let current = forecast;
    while ((current.status === 'queued' || current.status === 'running') && Date.now() < until) {
      await sleep(POLL_MS);
      current = (await repository.find(organizationId, forecast.id)) ?? current;
    }
    return current;
  }

  function checkRequest(tenant: TenantContext, input: ForecastRequestInput) {
    const metric = findForecastMetric(input.metric);
    if (metric === undefined) throw new ForecastError('metric_not_found');
    let department: string | undefined;
    if (input.department !== undefined) {
      if (typeof input.department !== 'string' || !DEPARTMENT.test(input.department)) {
        throw new ForecastError('invalid_request', 'department');
      }
      if (!metric.departments.includes(input.department)) {
        throw new ForecastError('metric_not_for_department');
      }
      department = input.department;
    }
    const frequency = input.frequency ?? 'day';
    if (!isForecastFrequency(frequency)) throw new ForecastError('invalid_request', 'frequency');
    if (!metric.frequencies.includes(frequency)) {
      throw new ForecastError('frequency_not_supported');
    }
    const horizon = input.horizon;
    if (typeof horizon !== 'number' || !Number.isSafeInteger(horizon)) {
      throw new ForecastError('invalid_request', 'horizon');
    }
    if (horizon < 1 || horizon > limits.maxHorizon[frequency]) {
      throw new ForecastError('horizon_out_of_range');
    }
    const covariates = checkCovariates(input.covariates, limits);
    if (input.entity !== undefined && typeof input.entity !== 'string') {
      throw new ForecastError('invalid_request', 'entity');
    }
    return { metric, department, frequency, horizon, covariates, tenant };
  }

  function newForecast(fields: {
    tenant: TenantContext;
    id: ForecastId;
    metric: ForecastMetric;
    entity: string;
    frequency: ForecastFrequency;
    horizon: number;
    timeZone: string;
    department: string | undefined;
    series: { start: string; end: string; values: readonly number[] };
    digest: string;
    covariates: readonly ForecastCovariate[];
    quality: DataQuality;
    previous?: Forecast;
  }): Forecast {
    const at = iso(now());
    const { previous } = fields;
    return Object.freeze({
      id: fields.id,
      organizationId: fields.tenant.organizationId,
      metric: fields.metric.id,
      entity: fields.entity,
      frequency: fields.frequency,
      horizon: fields.horizon,
      unit: fields.metric.unit,
      timeZone: fields.timeZone,
      requestedBy: fields.tenant.userId,
      ...(fields.department === undefined ? {} : { department: fields.department }),
      input: Object.freeze({
        start: fields.series.start,
        end: fields.series.end,
        values: fields.series.values,
        digest: fields.digest,
      }),
      covariates: fields.covariates,
      dataQuality: fields.quality,
      warnings: Object.freeze(
        warningsOf(fields.quality, limits, fields.frequency).slice(0, MAX_WARNINGS),
      ),
      status: 'queued',
      run: (previous?.run ?? 0) + 1,
      attempts: 0,
      creditsCharged: previous?.creditsCharged ?? 0,
      ...(previous?.creditReference === undefined
        ? {}
        : { creditReference: previous.creditReference }),
      revision: (previous?.revision ?? 0) + 1,
      createdAt: previous?.createdAt ?? at,
      updatedAt: at,
      queuedAt: at,
      expiresAt: iso(new Date(now().getTime() + limits.cacheTtlMs)),
    });
  }

  /** Whether a stored forecast still answers the same request. */
  function answers(forecast: Forecast): boolean {
    const at = now().getTime();
    if (forecast.status === 'completed') return Date.parse(forecast.expiresAt) > at;
    if (forecast.status === 'queued' || forecast.status === 'running') {
      return Date.parse(forecast.updatedAt) > at - limits.staleRunMs;
    }
    return false;
  }

  return Object.freeze({
    metrics(tenant: TenantContext) {
      return FORECAST_METRICS.map((m) =>
        Object.freeze({
          id: m.id,
          unit: m.unit,
          entity: m.entity,
          frequencies: m.frequencies,
          maxHorizon: limits.maxHorizon,
          departments: m.departments,
          readable:
            isResolvedTenant(tenant) && can(tenant, 'forecast.read') && can(tenant, m.permission),
        }),
      );
    },

    async request(tenant: TenantContext, input: ForecastRequestInput): Promise<ForecastOutcome> {
      if (!isResolvedTenant(tenant)) throw new ForecastError('unresolved_tenant');
      // A person, directly or through GIA (who keeps the person's permissions). Never the runtime.
      if (tenant.actor === 'runtime') return denied(tenant, 'permission_denied');
      if (!can(tenant, 'forecast.run')) {
        return denied(tenant, 'permission_denied', { permission: 'forecast.run' });
      }
      const checked = checkRequest(tenant, input);
      const { metric, frequency, horizon, covariates, department } = checked;
      // The data itself: whoever may not read the records may not have them forecast.
      if (!can(tenant, metric.permission)) {
        return denied(tenant, 'permission_denied', { permission: metric.permission });
      }
      const organizationId = tenant.organizationId;
      if (!(await activeOrganization(organizationId))) {
        throw new ForecastError('organization_inactive');
      }
      if (provider === undefined || scheduler === undefined) {
        throw new ForecastError('forecast_model_unavailable');
      }
      if (creditsPerRun === undefined) throw new ForecastError('forecast_price_not_set');
      const business = await context.of(organizationId);
      if (business === undefined || !isTimeZone(business.timeZone)) {
        throw new ForecastError('invalid_request', 'business_context');
      }
      const entity =
        (input.entity as string | undefined) ??
        (metric.entity === 'currency' ? business.currency : 'all');
      if (!isEntityOf(metric, entity)) throw new ForecastError('invalid_request', 'entity');

      const log = withCorrelation(logger, { organizationId });
      const started = performance.now();
      const end = lastCompletePeriod(now(), business.timeZone, frequency);
      const source = sources[metric.id];
      if (source === undefined) throw new ForecastError('metric_not_found');
      const points = await source.read({
        organizationId,
        entity,
        frequency,
        timeZone: business.timeZone,
        end,
      });
      const prepared = prepareSeries(points, { metric, frequency, end, limits });
      const preparationMs = Math.round(performance.now() - started);
      const base = { metric: metric.id, entity, frequency, horizon };
      if (!prepared.ok) {
        await audit.record({
          action: 'forecast.requested',
          result: 'success',
          actor: actorOf(tenant),
          organizationId,
          target: { type: 'forecast', id: 'request' },
          reason: prepared.problem,
          source: 'api',
        });
        log.info('forecast.not_forecastable', {
          ...base,
          department: department ?? null,
          problem: prepared.problem,
          points: prepared.quality?.points ?? 0,
          preparationMs,
        });
        return Object.freeze({
          status: prepared.problem === 'insufficient_data' ? 'insufficient_data' : 'invalid_data',
          ...base,
          problem: prepared.problem,
          ...(prepared.have === undefined ? {} : { have: prepared.have }),
          ...(prepared.need === undefined ? {} : { need: prepared.need }),
          ...(prepared.shortOf === undefined ? {} : { shortOf: prepared.shortOf }),
          ...(prepared.quality === undefined ? {} : { dataQuality: prepared.quality }),
        });
      }

      const id = forecastIdOf({
        organizationId,
        metric: metric.id,
        entity,
        horizon,
        series: prepared.series,
        covariates,
        model: provider.model,
      });
      const existing = await repository.find(organizationId, id);
      if (existing !== undefined && answers(existing)) {
        await audit.record({
          action: 'forecast.requested',
          result: 'success',
          actor: actorOf(tenant),
          organizationId,
          target: { type: 'forecast', id },
          reason: 'cache_hit',
          source: 'api',
        });
        log.info('forecast.cache_hit', { ...base, status: existing.status, preparationMs });
        const found = input.wait === true ? await waitFor(organizationId, existing) : existing;
        return Object.freeze({ status: found.status, forecast: found, cache: 'hit' });
      }

      // A miss: a run is needed. Its cost is checked now and charged once when it completes.
      const since = new Date(now().getTime() - limits.staleRunMs);
      if (
        (await repository.countActive(organizationId, since)) >= limits.maxActivePerOrganization
      ) {
        return denied(tenant, 'forecast_limit_reached', { target: id });
      }
      if (creditsPerRun > 0) {
        const balance = await credits.balanceOf(tenant);
        if (balance.status !== 'present' || balance.balance < creditsPerRun) {
          return denied(tenant, 'forecast_credits_insufficient', { target: id });
        }
      }
      const digest = seriesDigestOf(prepared.series);
      let queuedHere = false;
      const stored = await repository.write(organizationId, id, (current) => {
        // Another request queued or finished it meanwhile: that one answers.
        queuedHere = false;
        if (current !== undefined && answers(current)) return undefined;
        queuedHere = true;
        const forecast = newForecast({
          tenant,
          id,
          metric,
          entity,
          frequency,
          horizon,
          timeZone: business.timeZone,
          department,
          series: prepared.series,
          digest,
          covariates,
          quality: prepared.quality,
          ...(current === undefined ? {} : { previous: current }),
        });
        return {
          forecast,
          events: [
            event({
              action: 'forecast.requested',
              result: 'success',
              actor: actorOf(tenant),
              organizationId,
              target: { type: 'forecast', id },
              reason: 'cache_miss',
              source: 'api',
            }),
          ],
        };
      });
      if (stored === undefined) throw new ForecastError('forecast_concurrency_conflict');
      if (!queuedHere) {
        // Not ours: someone else's run answers.
        const found = input.wait === true ? await waitFor(organizationId, stored) : stored;
        return Object.freeze({ status: found.status, forecast: found, cache: 'hit' });
      }
      try {
        await scheduler.enqueue({ organizationId, forecastId: id, run: stored.run });
      } catch {
        await failWith(stored, 'not_scheduled');
        log.warn('forecast.not_scheduled', base);
        throw new ForecastError('forecast_not_scheduled');
      }
      log.info('forecast.cache_miss', {
        ...base,
        department: department ?? null,
        points: prepared.quality.points,
        preparationMs,
        run: stored.run,
      });
      const found = input.wait === true ? await waitFor(organizationId, stored) : stored;
      return Object.freeze({ status: found.status, forecast: found, cache: 'miss' });
    },

    async get(tenant: TenantContext, id: unknown) {
      if (!isResolvedTenant(tenant)) throw new ForecastError('unresolved_tenant');
      if (!can(tenant, 'forecast.read')) throw new ForecastError('permission_denied');
      if (typeof id !== 'string' || !/^fc_[0-9a-f]{40}$/.test(id)) {
        throw new ForecastError('forecast_not_found');
      }
      const found = await repository.find(tenant.organizationId, id as ForecastId);
      if (found === undefined) throw new ForecastError('forecast_not_found');
      const metric = findForecastMetric(found.metric);
      // Reading a forecast is reading its data: the metric's own permission too.
      if (metric === undefined || !can(tenant, metric.permission)) {
        throw new ForecastError('permission_denied');
      }
      return found;
    },

    async run(task: ForecastTask, { final }: { readonly final: boolean }) {
      const found = await repository.find(task.organizationId, task.forecastId);
      if (found === undefined) return 'not_found';
      if (found.run !== task.run) return 'stale';
      if (found.status === 'completed' || found.status === 'failed') return 'already_done';
      const log = withCorrelation(logger, { organizationId: task.organizationId });
      if (!(await activeOrganization(task.organizationId))) {
        throw new ForecastError('organization_inactive');
      }
      if (provider === undefined) throw new ForecastError('forecast_model_unavailable');

      const running = await repository.write(task.organizationId, task.forecastId, (current) =>
        current === undefined ||
        current.run !== task.run ||
        (current.status !== 'queued' && current.status !== 'running')
          ? undefined
          : {
              forecast: Object.freeze({
                ...current,
                status: 'running' as const,
                attempts: current.attempts + 1,
                revision: current.revision + 1,
                updatedAt: iso(now()),
              }),
              events: [],
            },
      );
      if (running?.status !== 'running' || running.run !== task.run) return 'already_done';

      const input = {
        values: running.input.values,
        horizon: running.horizon,
        frequency: running.frequency,
      };
      const base = {
        metric: running.metric,
        frequency: running.frequency,
        horizon: running.horizon,
        department: running.department ?? null,
        points: running.input.values.length,
        attempt: running.attempts,
      };
      const started = performance.now();
      let output;
      let model: ForecastModelRef = provider.model;
      try {
        output = await provider.forecast(input, AbortSignal.timeout(limits.providerTimeoutMs));
      } catch (error) {
        const code = error instanceof ForecastProviderError ? error.code : 'provider_unavailable';
        log.warn('forecast.model_failed', {
          ...base,
          model: model.id,
          modelVersion: model.version,
          code,
          durationMs: Math.round(performance.now() - started),
        });
        if (!final) throw new ForecastError('forecast_model_unavailable');
        if (fallback === 'off') {
          await failWith(running, code);
          return 'failed';
        }
        // The last attempt failed: the labelled, deterministic fallback answers, at no cost.
        const metric = findForecastMetric(running.metric);
        model = createFallbackProvider({ nonNegative: metric?.nonNegative ?? true }).model;
        output = await createFallbackProvider({
          nonNegative: metric?.nonNegative ?? true,
        }).forecast(input, AbortSignal.timeout(limits.providerTimeoutMs));
      }
      const durationMs = Math.round(performance.now() - started);

      // Charged once, when the model ran and answered; the reference makes a retry a replay.
      let charged = 0;
      let creditReference: string | undefined;
      if (model.kind === 'model' && (creditsPerRun ?? 0) > 0) {
        creditReference = forecastCreditReferenceOf(running.id);
        try {
          const runtime = await resolveRuntimeTenant(
            running.requestedBy,
            running.organizationId,
            tenancy,
          );
          await credits.consume(runtime, {
            amount: creditsPerRun as number,
            referenceId: creditReference,
            reason: 'forecast_run',
          });
          charged = creditsPerRun as number;
        } catch (error) {
          if (isRecord(error) && error.code === 'credits_insufficient') {
            await failWith(running, 'credits_insufficient');
            return 'failed';
          }
          throw error;
        }
      }
      const result: ForecastResult = Object.freeze({
        model,
        predictions: Object.freeze(
          output.point.map((value, i) =>
            Object.freeze({
              period: addPeriods(running.input.end, i + 1, running.frequency),
              value,
              low: (output.quantiles[i] as readonly number[])[0] as number,
              high: (output.quantiles[i] as readonly number[])[8] as number,
            }),
          ),
        ),
        quantiles: Object.freeze(output.quantiles.map((q) => Object.freeze([...q]))),
        generatedAt: iso(now()),
        usage: Object.freeze({
          durationMs,
          ...(output.usage?.inferenceMs === undefined
            ? {}
            : { inferenceMs: output.usage.inferenceMs }),
          ...(output.usage?.memoryMb === undefined ? {} : { memoryMb: output.usage.memoryMb }),
        }),
      });
      const completed = await repository.write(running.organizationId, running.id, (current) => {
        if (current === undefined || current.run !== task.run || current.status !== 'running') {
          return undefined;
        }
        const at = now();
        return {
          forecast: Object.freeze({
            ...current,
            status: 'completed' as const,
            result,
            warnings:
              model.kind === 'fallback'
                ? Object.freeze([...current.warnings, 'model_failed_fallback_used'])
                : current.warnings,
            creditsCharged: current.creditsCharged + charged,
            ...(creditReference === undefined ? {} : { creditReference }),
            revision: current.revision + 1,
            updatedAt: iso(at),
            completedAt: iso(at),
            expiresAt: iso(new Date(at.getTime() + limits.cacheTtlMs)),
          }),
          events: [
            event({
              action: 'forecast.completed',
              result: 'success',
              actor: actorOf({ actor: 'runtime', userId: current.requestedBy }),
              organizationId: current.organizationId,
              target: { type: 'forecast', id: current.id },
              model: { provider: model.provider, id: model.id },
              reason: model.kind === 'fallback' ? 'fallback' : 'model',
              ...(creditReference === undefined ? {} : { reference: creditReference }),
              source: 'api',
            }),
          ],
        };
      });
      log.info('forecast.completed', {
        ...base,
        model: model.id,
        modelVersion: model.version,
        fallback: model.kind === 'fallback',
        durationMs,
        inferenceMs: output.usage?.inferenceMs ?? null,
        memoryMb: output.usage?.memoryMb ?? null,
        credits: charged,
        stored: completed?.status === 'completed',
      });
      return model.kind === 'fallback' ? 'fallback' : 'completed';
    },

    async fail(task: ForecastTask, reason: string) {
      const found = await repository.find(task.organizationId, task.forecastId);
      if (found === undefined || found.run !== task.run) return false;
      if (found.status !== 'queued' && found.status !== 'running') return false;
      return failWith(found, reason);
    },
  });

  async function failWith(forecast: Forecast, reason: string): Promise<boolean> {
    const stored = await repository.write(forecast.organizationId, forecast.id, (current) => {
      if (
        current === undefined ||
        current.run !== forecast.run ||
        (current.status !== 'queued' && current.status !== 'running')
      ) {
        return undefined;
      }
      return {
        forecast: Object.freeze({
          ...current,
          status: 'failed' as const,
          failure: reason,
          revision: current.revision + 1,
          updatedAt: iso(now()),
        }),
        events: [
          event({
            action: 'forecast.failed',
            result: 'failure',
            actor: actorOf({ actor: 'runtime', userId: current.requestedBy as UserId }),
            organizationId: current.organizationId,
            target: { type: 'forecast', id: current.id },
            model: {
              provider: provider?.model.provider ?? 'none',
              id: provider?.model.id ?? 'none',
            },
            reason,
            source: 'api',
          }),
        ],
      };
    });
    return stored?.status === 'failed';
  }
}

const silent: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
};
