import type { Firestore } from '@google-cloud/firestore';
import type { IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import {
  ForecastError,
  isForecastId,
  type Forecast,
  type ForecastId,
  type ForecastRepository,
  type ForecastWrite,
} from '@melonoffice/forecasting';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `forecasts/{id}` (ADR-0059): one per cache key, so the id is the request. The organization is a
 * field every read checks: another organization's id is never read nor overwritten. Written only
 * by the API and the worker, with its audit events, in one transaction.
 *
 * Firestore has no arrays of arrays, so the quantiles are kept as one flat list, nine per period.
 * The queries are equality only (`organizationId`, `status`): no composite index.
 */
export const FORECASTS = 'forecasts';

type Doc = Record<string, unknown>;

const QUANTILES = 9;

export function toForecastDocument(f: Forecast): Doc {
  const { result, department, failure, creditReference, completedAt, ...rest } = f;
  return {
    ...rest,
    department: department ?? null,
    failure: failure ?? null,
    creditReference: creditReference ?? null,
    completedAt: completedAt ?? null,
    result:
      result === undefined
        ? null
        : {
            ...result,
            quantiles: result.quantiles.flat(),
          },
  };
}

const orAbsent = <K extends string, V>(key: K, value: V | null | undefined) =>
  value === null || value === undefined ? {} : ({ [key]: value } as Record<K, V>);

export function toForecast(id: string, d: Doc): Forecast {
  const { department, failure, creditReference, completedAt, result: stored, ...rest } = d;
  const result = stored as (Doc & { quantiles: number[] }) | null;
  const quantiles: number[][] = [];
  if (result !== null) {
    for (let i = 0; i < result.quantiles.length; i += QUANTILES) {
      quantiles.push(result.quantiles.slice(i, i + QUANTILES));
    }
  }
  return {
    ...(rest as unknown as Forecast),
    id: id as ForecastId,
    ...orAbsent('department', department as string | null),
    ...orAbsent('failure', failure as string | null),
    ...orAbsent('creditReference', creditReference as string | null),
    ...orAbsent('completedAt', completedAt as IsoTimestamp | null),
    ...(result === null
      ? {}
      : {
          result: { ...(result as unknown as Forecast['result']), quantiles } as Forecast['result'],
        }),
  } as Forecast;
}

export class FirestoreForecastRepository implements ForecastRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId, id: ForecastId): Promise<Forecast | undefined> {
    if (!isOrganizationId(organizationId) || !isForecastId(id)) return undefined;
    const snapshot = await this.db.collection(FORECASTS).doc(id).get();
    const data = snapshot.data();
    return data?.organizationId === organizationId ? toForecast(snapshot.id, data) : undefined;
  }

  async write(
    organizationId: OrganizationId,
    id: ForecastId,
    change: (current: Forecast | undefined) => ForecastWrite | undefined,
  ): Promise<Forecast | undefined> {
    if (!isOrganizationId(organizationId) || !isForecastId(id)) {
      throw new ForecastError('forecast_not_found');
    }
    const doc = this.db.collection(FORECASTS).doc(id);
    // Firestore runs the function again when the forecast changed before the commit, so `change`
    // always decides on the state it replaces.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data();
      if (data !== undefined && data.organizationId !== organizationId) {
        throw new ForecastError('forecast_not_found');
      }
      const current = data === undefined ? undefined : toForecast(snapshot.id, data);
      const next = change(current);
      if (next === undefined) return current;
      if (
        next.forecast.id !== id ||
        next.forecast.organizationId !== organizationId ||
        next.forecast.revision !== (current?.revision ?? 0) + 1
      ) {
        throw new ForecastError('forecast_concurrency_conflict');
      }
      t.set(doc, toForecastDocument(next.forecast));
      for (const event of next.events) {
        if (event.organizationId !== organizationId) throw new Error('audit_event_organization');
        t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
      }
      return next.forecast;
    });
  }

  async countActive(organizationId: OrganizationId, since: Date): Promise<number> {
    if (!isOrganizationId(organizationId)) return 0;
    const snapshot = await this.db
      .collection(FORECASTS)
      .where('organizationId', '==', organizationId)
      .where('status', 'in', ['queued', 'running'])
      .get();
    return snapshot.docs.filter((doc) => Date.parse(String(doc.data().updatedAt)) > since.getTime())
      .length;
  }
}
