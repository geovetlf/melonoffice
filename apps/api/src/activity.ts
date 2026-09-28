import {
  isActivityError,
  type ActivityErrorCode,
  type ActivityService,
} from '@melonoffice/activity';
import type { BusinessProfileRepository } from '@melonoffice/business';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

const STATUS: Record<ActivityErrorCode, ContentfulStatusCode> = {
  invalid_period: 400,
  invalid_time_zone: 400,
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
    readonly businessProfiles?: Pick<BusinessProfileRepository, 'find'>;
  },
): void {
  const { activity, businessProfiles } = dependencies;
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
}
