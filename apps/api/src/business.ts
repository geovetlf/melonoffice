import {
  DEFAULT_BUSINESS_TYPE_CATALOGUE,
  isBusinessError,
  type BusinessErrorCode,
  type BusinessProfileRead,
  type BusinessProfileService,
} from '@melonoffice/business';
import { profileKnowledge, type CompanyBrainService } from '@melonoffice/brain';
import type { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

const STATUS: Record<BusinessErrorCode, ContentfulStatusCode> = {
  invalid_profile: 400,
  profile_not_found: 404,
  profile_concurrency_conflict: 409,
  permission_denied: 403,
  requires_user: 403,
  organization_inactive: 403,
  unresolved_tenant: 403,
};

/**
 * The business profile (ADR-0048). Anyone who can see the organization reads it; only a person
 * with `organization.update`, acting directly, fills it in or changes it. The kinds of business
 * are served as data, so the app lists them without knowing them.
 */
export function registerBusinessRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly profiles: BusinessProfileService;
    /** Company Brain (ADR-0051): a saved profile feeds it, as the owner's confirmed facts. */
    readonly brain?: Pick<CompanyBrainService, 'ingest'>;
  },
): void {
  const { profiles, brain } = dependencies;
  const path = '/v1/organizations/:organizationId/business-profile';

  const answer = async (
    c: Parameters<Parameters<typeof withPermission>[2]>[0],
    work: () => Promise<BusinessProfileRead>,
  ) => {
    try {
      return c.json(toBusinessProfileView(await work()));
    } catch (error) {
      if (!isBusinessError(error)) throw error;
      return c.json(
        {
          error: error.code,
          ...(error.code === 'invalid_profile' && error.field !== undefined
            ? { field: error.field }
            : {}),
        },
        STATUS[error.code],
      );
    }
  };

  app.get(
    '/v1/business-types',
    // Signed in only: the list is the same for everyone and says nothing about an organization.
    (c) =>
      c.json({
        businessTypes: DEFAULT_BUSINESS_TYPE_CATALOGUE.types.map((t) => ({
          id: t.id,
          nameKey: t.nameKey,
        })),
      }),
  );

  app.get(
    path,
    withPermission('organization.read', dependencies, (c, tenant) =>
      answer(c, () => profiles.get(tenant)),
    ),
  );

  app.put(
    path,
    withPermission('organization.update', dependencies, async (c, tenant) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, async () => {
        const read = await profiles.save(tenant, body);
        if (brain !== undefined && read.profile !== undefined) {
          // Best effort and safe to repeat: the profile is saved whatever happens here, and
          // Company Brain's sync route brings it in again.
          try {
            const { source, facts } = profileKnowledge(read.profile);
            await brain.ingest(tenant, source, facts);
          } catch {
            c.get('logger').warn('company brain profile feed failed');
          }
        }
        return read;
      });
    }),
  );
}

/** The public view: the profile's content and the suggested order. No storage detail. */
export function toBusinessProfileView(read: BusinessProfileRead) {
  const p = read.profile;
  return {
    profile:
      p === undefined
        ? null
        : {
            businessType: p.businessType,
            country: p.country,
            currency: p.currency,
            timeZone: p.timeZone,
            city: p.city,
            employees: p.employees ?? null,
            salesChannels: p.salesChannels ?? [],
            offering: p.offering ?? null,
            needs: p.needs ?? null,
            notes: p.notes ?? null,
            updatedAt: p.updatedAt,
          },
    departmentPriority: read.departmentPriority,
  };
}
