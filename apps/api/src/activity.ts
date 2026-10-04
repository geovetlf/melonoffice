import {
  isActivityError,
  type ActivityErrorCode,
  type ActivityService,
  type AuditTrailService,
} from '@melonoffice/activity';
import type { BusinessProfileRepository } from '@melonoffice/business';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

const STATUS: Record<ActivityErrorCode, ContentfulStatusCode> = {
  invalid_period: 400,
  invalid_time_zone: 400,
  invalid_filter: 400,
  invalid_cursor: 400,
  invalid_target: 400,
  permission_denied: 403,
  organization_inactive: 403,
  unresolved_tenant: 403,
};

/** Where MelonOffice starts (ADR-0048): the time zone used until the business says its own. */
export const DEFAULT_ACTIVITY_TIME_ZONE = 'America/Lima';

/**
 * The office's activity (ADR-0049): `GET .../activity?period=today|week|month`, read from the
 * audit trail, in the business's time zone. The zone comes from the business profile, never from
 * the client, so everyone in the organization sees the same "today".
 */
export function registerActivityRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly activity: ActivityService;
    /** The audit trail viewer (ADR-0147). Absent: its route answers 503. */
    readonly trail?: AuditTrailService;
    readonly businessProfiles?: Pick<BusinessProfileRepository, 'find'>;
  },
): void {
  const { activity, trail, businessProfiles } = dependencies;
  app.get(
    '/v1/organizations/:organizationId/activity',
    withPermission('activity.read', dependencies, async (c, tenant) => {
      const profile = await businessProfiles?.find(tenant.organizationId);
      const timeZone = profile?.timeZone ?? DEFAULT_ACTIVITY_TIME_ZONE;
      try {
        const page = await activity.list(tenant, {
          period: c.req.query('period') ?? 'today',
          timeZone,
        });
        return c.json({ ...page, timeZoneSource: profile === undefined ? 'default' : 'business' });
      } catch (error) {
        if (!isActivityError(error)) throw error;
        return c.json({ error: error.code }, STATUS[error.code]);
      }
    }),
  );

  /**
   * The audit trail (ADR-0147): `GET .../audit-trail?category=&from=&to=&cursor=&target=`, read
   * only, newest first, a page at a time. Every query value is checked on the server; the
   * organization is the caller's, never a parameter, and the days are the business's own.
   */
  app.get(
    '/v1/organizations/:organizationId/audit-trail',
    withPermission('activity.read', dependencies, async (c, tenant) => {
      if (trail === undefined) return c.json({ error: 'activity_not_configured' }, 503);
      const profile = await businessProfiles?.find(tenant.organizationId);
      const optional = (name: string) => {
        const value = c.req.query(name);
        return value === undefined || value === '' ? {} : { [name]: value };
      };
      try {
        const page = await trail.page(tenant, {
          ...optional('from'),
          ...optional('to'),
          ...optional('cursor'),
          ...optional('target'),
          ...(c.req.query('category') === undefined || c.req.query('category') === ''
            ? {}
            : { filter: c.req.query('category') }),
          timeZone: profile?.timeZone ?? DEFAULT_ACTIVITY_TIME_ZONE,
        });
        return c.json(page);
      } catch (error) {
        if (!isActivityError(error)) throw error;
        return c.json({ error: error.code }, STATUS[error.code]);
      }
    }),
  );
}
