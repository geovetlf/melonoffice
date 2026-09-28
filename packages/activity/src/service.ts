import type { AuditReader } from '@melonoffice/audit';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { ACTIVITY_ACTIONS, toActivityItem, type ActivityItem } from './catalogue.js';
import { ActivityError } from './errors.js';
import { isActivityPeriod, isTimeZone, periodRange, type ActivityPeriod } from './period.js';

/** How many items one read returns, newest first. */
export const ACTIVITY_PAGE_SIZE = 100;

export interface ActivityPage {
  readonly period: ActivityPeriod;
  readonly timeZone: string;
  readonly from: string;
  readonly to: string;
  readonly items: readonly ActivityItem[];
  /** More happened in the period than one page shows. */
  readonly hasMore: boolean;
}

export interface ActivityService {
  /**
   * `activity.read`. GIA may read it for the person it helps: reading changes nothing. An empty
   * page means nothing happened yet; it is never filled in.
   */
  list(
    tenant: TenantContext,
    input: { readonly period: unknown; readonly timeZone: unknown },
  ): Promise<ActivityPage>;
}

export function createActivityService(options: {
  readonly reader: AuditReader;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
}): ActivityService {
  const { reader, organizations, authorization, now = () => new Date() } = options;
  return Object.freeze({
    async list(tenant: TenantContext, input: { period: unknown; timeZone: unknown }) {
      if (!isResolvedTenant(tenant)) throw new ActivityError('unresolved_tenant');
      if (!authorization.authorize(tenant, 'activity.read').allowed) {
        throw new ActivityError('permission_denied');
      }
      if (!isActivityPeriod(input.period)) throw new ActivityError('invalid_period');
      if (!isTimeZone(input.timeZone)) throw new ActivityError('invalid_time_zone');
      const organization = await organizations.findOrganization(tenant.organizationId);
      if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
        throw new ActivityError('organization_inactive');
      }
      const { from, to } = periodRange(input.period, input.timeZone, now());
      const events = await reader.query({
        organizationId: tenant.organizationId,
        actions: ACTIVITY_ACTIONS,
        from,
        to,
        limit: ACTIVITY_PAGE_SIZE + 1,
      });
      // Only this organization's events, whatever the store returned.
      const own = events.filter((event) => event.organizationId === tenant.organizationId);
      return Object.freeze({
        period: input.period,
        timeZone: input.timeZone,
        from: from.toISOString(),
        to: to.toISOString(),
        items: Object.freeze(
          own.slice(0, ACTIVITY_PAGE_SIZE).map((event) => toActivityItem(event, tenant.userId)),
        ),
        hasMore: own.length > ACTIVITY_PAGE_SIZE,
      });
    },
  });
}
