import type {
  ModelPolicyCatalogue,
  ProviderHealthTracker,
  ProviderRegistry,
} from '@melonoffice/ai-gateway';
import type { AIUsageLedger } from '@melonoffice/ai-usage';
import { isAIUsageError } from '@melonoffice/ai-usage';
import { actorOf, type AuditService } from '@melonoffice/audit';
import type { AIUsageBucket, DeploymentEnvironment, OrganizationId } from '@melonoffice/domain';
import type { TenancyStore } from '@melonoffice/tenancy';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { platformAdminOf } from './platform-admin.js';
import { recordRequired, requestFields } from './audit.js';

/**
 * The platform AI view (ADR-0082): which AI providers and models MelonMotor has, what they cost,
 * their terms, how calls are routed and fall back, how each provider is doing, and every
 * organization's AI usage with MelonOffice's internal cost. It belongs to the MelonOffice platform
 * administrator only: a company, its owner included, never sees providers, models or internal
 * cost (they see credits, `/v1/organizations/:id/ai-usage`).
 *
 * Who is a platform administrator is configuration (`PLATFORM_ADMIN_USER_IDS`, exact user ids),
 * never a role a company can grant. Empty: nobody. Every read is audited; a refusal too. It reads
 * the same registry, policies, health tracker and usage ledger the one AI Gateway uses: nothing
 * here is a second gateway, router or ledger, and nothing here changes anything.
 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How many organizations get their name looked up; the rest are listed by id. */
const NAMED_ORGANIZATIONS = 100;

export interface PlatformDependencies {
  /** The platform administrators' user ids. */
  readonly admins: ReadonlySet<string>;
  readonly audit: AuditService;
  readonly environment?: DeploymentEnvironment | undefined;
  readonly registry?: ProviderRegistry | undefined;
  readonly policies?: ModelPolicyCatalogue | undefined;
  /** The gateway's own tracker, as this server instance has seen each provider. */
  readonly health?: ProviderHealthTracker | undefined;
  readonly ledger?: AIUsageLedger | undefined;
  readonly organizations?: TenancyStore | undefined;
  readonly now?: () => Date;
}

export function registerPlatformRoutes(app: Hono<AuthEnv>, dependencies: PlatformDependencies) {
  const { admins, audit } = dependencies;
  const isAdmin = (c: Context<AuthEnv>) => {
    const auth = c.get('auth');
    // GIA acting for a person never reaches the platform view, even for an administrator.
    return auth.actor === 'user' && admins.has(auth.userId);
  };

  /** Runs the handler for a verified administrator, audited; anyone else gets 403 and a denied event. */
  const adminOnly =
    (view: string, handler: (c: Context<AuthEnv>) => Promise<Response>) =>
    async (c: Context<AuthEnv>) => {
      const auth = c.get('auth');
      const admin = await platformAdminOf(c, admins, {
        audit,
        action: 'platform.ai_read',
        reference: view,
      });
      if (admin instanceof Response) return admin;
      const unaudited = await recordRequired(c, audit, {
        action: 'platform.ai_read',
        result: 'success',
        actor: actorOf(auth),
        actorRole: admin.role,
        reference: view,
        ...requestFields(c),
      });
      if (unaudited) return unaudited;
      return handler(c);
    };

  // Whether the person may open the platform view: the web shows the entry only then.
  // `emailVerified` lets the screen say why an administrator is refused until they verify it.
  app.get('/v1/platform/access', (c) =>
    c.json({ platformAdmin: isAdmin(c), emailVerified: c.get('auth').emailVerified }),
  );

  app.get(
    '/v1/platform/ai',
    adminOnly('ai', async (c) => {
      const { registry, policies, health, environment } = dependencies;
      const providers = registry?.providers() ?? [];
      return c.json({
        environment: environment ?? null,
        providers: providers.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          // As this server instance has seen it since it started; no probe is made.
          health: health?.status(p.id) ?? 'available',
          capabilities: p.capabilities,
          modalities: p.modalities,
          regions: p.regions ?? [],
          environments: p.environments,
          maxSensitivity: p.maxSensitivity,
          // Where the key lives (a Secret Manager reference) is not shown either: never a secret.
        })),
        models: (registry?.models() ?? []).map(({ provider, model }) => ({
          providerId: provider.id,
          modelId: model.modelId,
          version: model.version,
          displayName: model.displayName ?? null,
          status: model.status,
          capabilities: model.capabilities,
          inputModalities: model.inputModalities,
          outputModalities: model.outputModalities,
          contextWindowTokens: model.contextWindowTokens,
          maxOutputTokens: model.maxOutputTokens,
          structuredOutput: model.structuredOutput,
          toolUse: model.toolUse,
          streaming: model.streaming,
          quality: model.quality,
          latency: model.latency,
          pricing: model.pricing,
          environments: model.environments,
          maxSensitivity: model.maxSensitivity,
          priority: model.priority ?? null,
          terms: model.terms ?? null,
        })),
        policies: (policies?.list() ?? []).map((p) => ({
          id: p.id,
          version: p.version,
          allowedProviders: p.allowedProviders ?? null,
          allowedModels: p.allowedModels ?? null,
          allowedCapabilities: p.allowedCapabilities ?? null,
          environments: p.environments,
          maxSensitivity: p.maxSensitivity,
          maxCostMicroUsd: p.maxCostMicroUsd ?? null,
          maxLatency: p.maxLatency ?? null,
          preferred: p.preferred ?? null,
          strategy: p.strategy ?? null,
          fallback: p.fallback,
          maxAttempts: p.maxAttempts,
          backoffMs: p.backoffMs,
        })),
      });
    }),
  );

  app.get(
    '/v1/platform/ai-usage',
    adminOnly('ai_usage', async (c) => {
      const { ledger, organizations } = dependencies;
      if (ledger === undefined) return c.json({ error: 'ai_usage_not_configured' }, 503);
      const today = (dependencies.now?.() ?? new Date()).toISOString().slice(0, 10);
      const from = c.req.query('from') ?? today;
      const to = c.req.query('to') ?? from;
      if (!DAY.test(from) || !DAY.test(to)) return c.json({ error: 'invalid_request' }, 400);
      try {
        const summary = await ledger.platformSummary(from, to);
        const totals = await ledger.organizationTotals(from, to);
        const ranked = (Object.entries(totals) as [OrganizationId, AIUsageBucket][]).sort(
          ([, a], [, b]) => b.costMicroUsd - a.costMicroUsd || b.operations - a.operations,
        );
        const byOrganization = await Promise.all(
          ranked.map(async ([id, bucket], index) => ({
            organizationId: id,
            name:
              index < NAMED_ORGANIZATIONS
                ? ((await organizations?.findOrganization(id))?.name ?? null)
                : null,
            ...bucket,
          })),
        );
        return c.json({ ...summary, byOrganization });
      } catch (error) {
        if (isAIUsageError(error)) return c.json({ error: 'invalid_request' }, 400);
        throw error;
      }
    }),
  );
}
