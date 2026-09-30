import {
  actorOf,
  buildAuditEvent,
  type AuditEventInput,
  type AuditService,
} from '@melonoffice/audit';
import {
  accountBrandOf,
  brandConfigIdOf,
  canChangeDomainStatus,
  effectiveBrandOf,
  isBrandingError,
  isDomainBindingStatus,
  isHostname,
  parseBrandConfig,
  parseDomainTarget,
  parseHostname,
  resolveDomain,
  type BrandRepository,
  type BrandResolutionDependencies,
} from '@melonoffice/branding';
import type {
  BrandConfig,
  BrandConfigRecord,
  BrandOwner,
  DomainBinding,
  IsoTimestamp,
  UserId,
} from '@melonoffice/domain';
import type { AuthorizationService, CommercialAuthorization } from '@melonoffice/rbac';
import {
  customerAccessOf,
  TenancyError,
  type CommercialRepository,
  type TenancyStore,
} from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { recordOutcome, requestFields } from './audit.js';
import type { AuthEnv } from './auth.js';
import { withPermission } from './authorization.js';
import { createCommercialGuard } from './commercial.js';
import { platformAdminOf } from './platform-admin.js';

/**
 * Brands and domains (ADR-0087):
 *
 * - `GET /v1/public/brand?host=`: what a page on that host looks like, before anyone signs in.
 * - `/v1/organizations/:organizationId/brand`: the organization's brand; its owner changes its own
 *   level.
 * - `/v1/commercial/accounts/:accountId/brand`: a partner's or agency's own level.
 * - `/v1/commercial/accounts/:accountId/customers/:organizationId/brand`: the white-label level a
 *   partner sets for one white-label customer, only while that customer grants `branding`.
 * - `/v1/platform/domain-bindings`: the platform administrator registers domains and moves them
 *   through their statuses. DNS and certificates come later.
 *
 * Each level is written only by its owner, with the version it read, and audited in the same step.
 */

export interface BrandingDependencies {
  readonly brands: BrandRepository;
  readonly commercial: CommercialRepository;
  readonly organizations: TenancyStore;
  readonly admins: ReadonlySet<string>;
  readonly authorization: AuthorizationService;
  readonly commercialAuthorization: CommercialAuthorization;
  readonly audit: AuditService;
  readonly businessFacts?: NonNullable<BrandResolutionDependencies['businessFacts']>;
  readonly now?: () => Date;
}

const STATUS: Partial<Record<string, ContentfulStatusCode>> = {
  invalid_brand_config: 400,
  invalid_hostname: 400,
  invalid_domain_target: 400,
  invalid_domain_transition: 409,
  brand_conflict: 409,
  domain_conflict: 409,
};

const body = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const value: unknown = await c.req.json().catch(() => undefined);
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
};

/** What anyone may see before signing in: how the page looks, and nothing about the customer. */
const publicView = (b: BrandConfig) => ({
  brandName: b.brandName ?? null,
  productName: b.productName ?? null,
  assistantName: b.assistantName ?? null,
  logoUrl: b.logoUrl ?? null,
  faviconUrl: b.faviconUrl ?? null,
  primaryColor: b.primaryColor ?? null,
  secondaryColor: b.secondaryColor ?? null,
  login: b.login ?? null,
  supportContact: b.supportContact ?? null,
  links: b.links ?? null,
  defaultLanguage: b.defaultLanguage ?? null,
});

const domainView = (d: DomainBinding) => ({
  hostname: d.hostname,
  target: d.target,
  status: d.status,
  updatedAt: d.updatedAt,
});

/** Branding's codes answer as themselves; anything else is not ours. */
const guardedBranding = async (
  c: Context<AuthEnv>,
  work: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await work();
  } catch (error) {
    if (isBrandingError(error)) {
      return c.json(
        { error: error.code, ...(error.field === undefined ? {} : { field: error.field }) },
        STATUS[error.code] ?? 400,
      );
    }
    throw error;
  }
};

/**
 * The one route without a signed-in person: registered before authentication. The host is only a
 * selector; the answer is the platform's brand for any host without an active binding, and never
 * carries an id, a company fact or anything the brand's owner did not choose to show.
 */
export function registerPublicBrandRoute(
  app: Hono<AuthEnv>,
  deps: Pick<BrandingDependencies, 'brands' | 'commercial' | 'organizations' | 'businessFacts'>,
) {
  app.get('/v1/public/brand', async (c) => {
    const resolved = await resolveDomain(c.req.query('host'), deps);
    c.header('cache-control', 'public, max-age=300');
    return c.json({ context: resolved.context.type, brand: publicView(resolved.brand) });
  });
}

export function registerBrandingRoutes(app: Hono<AuthEnv>, deps: BrandingDependencies) {
  const { brands, commercial, organizations, admins, audit, commercialAuthorization } = deps;
  const now = deps.now ?? (() => new Date());
  const { inAccount } = createCommercialGuard(deps);
  const event = (input: AuditEventInput, at: Date) => buildAuditEvent(input, at);

  /**
   * Saves one owner's level: checks the fields for that level, the version read, and records
   * `brand_config.updated` in the same step.
   */
  const save = async (
    c: Context<AuthEnv>,
    owner: BrandOwner,
    audited: Pick<AuditEventInput, 'actor' | 'organizationId' | 'commercialAccountId'>,
    userId: UserId,
  ) =>
    guardedBranding(c, async () => {
      const input = await body(c);
      const config = parseBrandConfig(input.config, owner.level);
      const current = await brands.findBrand(owner);
      if ((current?.updatedAt ?? null) !== (input.expectedUpdatedAt ?? null)) {
        return c.json({ error: 'brand_conflict' }, 409);
      }
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const record: BrandConfigRecord = {
        id: brandConfigIdOf(owner),
        owner,
        config,
        createdAt: current?.createdAt ?? iso,
        updatedAt: iso,
        updatedBy: userId,
      };
      await brands.saveBrand(record, current, [
        event(
          {
            action: 'brand_config.updated',
            result: 'success',
            ...audited,
            target: { type: 'brand_config', id: record.id },
            reference: owner.level,
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ config: record.config, updatedAt: record.updatedAt });
    });

  // ---------------------------------------------------------------- the organization's owner

  const tenancyDeps = { store: organizations, authorization: deps.authorization, audit };
  const orgBrand = '/v1/organizations/:organizationId/brand';

  // What the organization's people see, and its own level, which its owner changes.
  app.get(
    orgBrand,
    withPermission('organization.read', tenancyDeps, async (c, tenant) => {
      const effective = await effectiveBrandOf(tenant.organizationId, deps);
      const own = await brands.findBrand({
        level: 'organization',
        organizationId: tenant.organizationId,
      });
      return c.json({
        brand: effective.brand,
        levels: effective.levels,
        own: own?.config ?? null,
        updatedAt: own?.updatedAt ?? null,
      });
    }),
  );

  app.put(
    orgBrand,
    withPermission('brand.manage', tenancyDeps, async (c, tenant) => {
      if (tenant.actor !== 'user') return c.json({ error: 'requires_user' }, 403);
      return save(
        c,
        { level: 'organization', organizationId: tenant.organizationId },
        { actor: actorOf(tenant), organizationId: tenant.organizationId },
        tenant.userId,
      );
    }),
  );

  // ---------------------------------------------------------------- partner and agency

  const accountBrand = '/v1/commercial/accounts/:accountId/brand';

  app.get(
    accountBrand,
    inAccount('commercial.read', async (c, context) => {
      const effective = await accountBrandOf(context.commercialAccountId, deps);
      const own = await brands.findBrand({
        level: 'commercial_account',
        commercialAccountId: context.commercialAccountId,
      });
      return c.json({
        brand: effective.brand,
        own: own?.config ?? null,
        updatedAt: own?.updatedAt ?? null,
      });
    }),
  );

  app.put(
    accountBrand,
    inAccount('commercial.manage_brand', async (c, context) =>
      save(
        c,
        { level: 'commercial_account', commercialAccountId: context.commercialAccountId },
        { actor: actorOf(c.get('auth')), commercialAccountId: context.commercialAccountId },
        context.userId,
      ),
    ),
  );

  /**
   * A white-label customer of this very account, whose relationship is active and grants
   * `branding`. Every refusal is `customer_forbidden`, audited, whatever the reason.
   */
  const whiteLabel = (
    handler: (
      c: Context<AuthEnv>,
      owner: Extract<BrandOwner, { level: 'white_label' }>,
      userId: UserId,
    ) => Promise<Response>,
  ) =>
    inAccount('commercial.read', async (c, context) => {
      const access = await customerAccessOf(
        context,
        c.req.param('organizationId') ?? '',
        commercial,
        organizations,
      );
      const decision = commercialAuthorization.authorize(context, 'customer.manage_brand', access);
      if (!decision.allowed || access.mode !== 'white_label') {
        await recordOutcome(c, audit, {
          action: 'commercial.access',
          result: 'denied',
          actor: actorOf(c.get('auth')),
          commercialAccountId: context.commercialAccountId,
          organizationId: access.organizationId,
          permission: 'customer.manage_brand',
          reason: decision.allowed ? 'not_white_label' : decision.reason,
          ...requestFields(c),
        });
        throw new TenancyError('customer_forbidden');
      }
      return handler(
        c,
        {
          level: 'white_label',
          commercialAccountId: context.commercialAccountId,
          organizationId: access.organizationId,
        },
        context.userId,
      );
    });

  const customerBrand = '/v1/commercial/accounts/:accountId/customers/:organizationId/brand';

  app.get(
    customerBrand,
    whiteLabel(async (c, owner) => {
      const own = await brands.findBrand(owner);
      return c.json({ own: own?.config ?? null, updatedAt: own?.updatedAt ?? null });
    }),
  );

  app.put(
    customerBrand,
    whiteLabel(async (c, owner, userId) =>
      save(
        c,
        owner,
        {
          actor: actorOf(c.get('auth')),
          commercialAccountId: owner.commercialAccountId,
          organizationId: owner.organizationId,
        },
        userId,
      ),
    ),
  );

  // ---------------------------------------------------------------- platform administrator

  app.get('/v1/platform/domain-bindings', async (c) => {
    const admin = await platformAdminOf(c, admins);
    if (admin instanceof Response) return admin;
    return c.json({ domains: (await brands.listDomains()).map(domainView) });
  });

  // Registers a domain for an existing, active account or organization. It starts pending.
  app.post('/v1/platform/domain-bindings', async (c) => {
    const auth = c.get('auth');
    const admin = await platformAdminOf(c, admins, { audit, action: 'domain_binding.created' });
    if (admin instanceof Response) return admin;
    return guardedBranding(c, async () => {
      const input = await body(c);
      const hostname = parseHostname(input.hostname);
      const target = parseDomainTarget(input.target);
      const exists =
        target.type === 'organization'
          ? (await organizations.findOrganization(target.organizationId))?.status === 'active'
          : (await commercial.findAccount(target.commercialAccountId))?.status === 'active';
      if (!exists) return c.json({ error: 'invalid_domain_target' }, 400);
      if ((await brands.findDomain(hostname)) !== undefined) {
        return c.json({ error: 'domain_exists' }, 409);
      }
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const binding: DomainBinding = {
        hostname,
        target,
        status: 'pending_verification',
        createdAt: iso,
        updatedAt: iso,
        createdBy: auth.userId,
      };
      await brands.saveDomain(binding, undefined, [
        event(
          {
            action: 'domain_binding.created',
            result: 'success',
            actor: actorOf(auth),
            actorRole: admin.role,
            ...(target.type === 'organization'
              ? { organizationId: target.organizationId }
              : { commercialAccountId: target.commercialAccountId }),
            target: { type: 'domain_binding', id: hostname },
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ domain: domainView(binding) }, 201);
    });
  });

  // Moves a domain along its statuses. Verification is the administrator's for now: no DNS check.
  app.post('/v1/platform/domain-bindings/:hostname/status', async (c) => {
    const auth = c.get('auth');
    const admin = await platformAdminOf(c, admins, {
      audit,
      action: 'domain_binding.status_changed',
    });
    if (admin instanceof Response) return admin;
    return guardedBranding(c, async () => {
      const hostname = c.req.param('hostname') ?? '';
      const current = isHostname(hostname) ? await brands.findDomain(hostname) : undefined;
      if (current === undefined) return c.json({ error: 'domain_not_found' }, 404);
      const input = await body(c);
      if (!isDomainBindingStatus(input.status)) return c.json({ error: 'invalid_status' }, 400);
      if (input.expectedUpdatedAt !== current.updatedAt) {
        return c.json({ error: 'domain_conflict' }, 409);
      }
      if (!canChangeDomainStatus(current.status, input.status)) {
        return c.json({ error: 'invalid_domain_transition' }, 409);
      }
      const at = now();
      const next: DomainBinding = {
        ...current,
        status: input.status,
        updatedAt: at.toISOString() as IsoTimestamp,
      };
      await brands.saveDomain(next, current, [
        event(
          {
            action: 'domain_binding.status_changed',
            result: 'success',
            actor: actorOf(auth),
            actorRole: admin.role,
            target: { type: 'domain_binding', id: hostname },
            transition: { from: current.status, to: next.status },
            ...requestFields(c),
          },
          at,
        ),
      ]);
      return c.json({ domain: domainView(next) });
    });
  });
}
