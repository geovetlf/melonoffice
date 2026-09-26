import type { Hono } from 'hono';

export interface HealthInfo {
  readonly service: string;
  readonly version: string;
}

/** Liveness endpoint used by Cloud Run and uptime checks. It has no dependencies yet. */
export function registerHealth<E extends object>(app: Hono<E>, info: HealthInfo): void {
  app.get('/health', (c) => c.json({ status: 'ok', service: info.service, version: info.version }));
}
