import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type { OrganizationId } from '@melonoffice/domain';
import { ForecastError } from './errors.js';
import type { Forecast, ForecastId } from './model.js';

/** A forecast's next state and the audit events that record the change: written together. */
export interface ForecastWrite {
  readonly forecast: Forecast;
  readonly events: readonly AuditEvent[];
}

/**
 * Where forecasts are kept (`forecasts/{id}`, ADR-0059). Every read and write names the
 * organization, and a forecast of another organization is never read nor overwritten: it is
 * `undefined`, like one that does not exist.
 */
export interface ForecastRepository {
  find(organizationId: OrganizationId, id: ForecastId): Promise<Forecast | undefined>;
  /**
   * Reads the forecast and writes what `change` returns, with its events, in one transaction.
   * `change` returning `undefined` writes nothing. Returns the stored state.
   */
  write(
    organizationId: OrganizationId,
    id: ForecastId,
    change: (current: Forecast | undefined) => ForecastWrite | undefined,
  ): Promise<Forecast | undefined>;
  /** The organization's forecasts queued or running whose last change is after `since`. */
  countActive(organizationId: OrganizationId, since: Date): Promise<number>;
}

/** For tests and local runs. Writes its events to the given audit store in the same step. */
export class InMemoryForecastRepository implements ForecastRepository {
  readonly #forecasts = new Map<string, Forecast>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(organizationId: OrganizationId, id: ForecastId) {
    const found = this.#forecasts.get(id);
    return found?.organizationId === organizationId ? found : undefined;
  }

  async write(
    organizationId: OrganizationId,
    id: ForecastId,
    change: (current: Forecast | undefined) => ForecastWrite | undefined,
  ) {
    const stored = this.#forecasts.get(id);
    if (stored !== undefined && stored.organizationId !== organizationId) {
      throw new ForecastError('forecast_not_found');
    }
    const next = change(stored);
    if (next === undefined) return stored;
    if (next.forecast.id !== id || next.forecast.organizationId !== organizationId) {
      throw new Error('a forecast write must keep its id and organization');
    }
    this.audit?.appendNow(next.events);
    this.#forecasts.set(id, next.forecast);
    return next.forecast;
  }

  async countActive(organizationId: OrganizationId, since: Date) {
    let count = 0;
    for (const f of this.#forecasts.values()) {
      if (
        f.organizationId === organizationId &&
        (f.status === 'queued' || f.status === 'running') &&
        Date.parse(f.updatedAt) > since.getTime()
      ) {
        count += 1;
      }
    }
    return count;
  }
}
