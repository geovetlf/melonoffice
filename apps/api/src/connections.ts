import type { ChannelConnection, ChannelTemplate } from '@melonoffice/domain';
import {
  isIntegrationError,
  type ChannelAdapter,
  type ChannelConnectionService,
  type ChannelTemplateService,
  type IntegrationRegistry,
} from '@melonoffice/integrations';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Connections to outside services (ADR-0033, lifecycle and routes in ADR-0044): what a future
 * Settings → Integrations screen uses. Each change has its own permission and is made by a person
 * acting directly; the service checks both again. Secrets never pass through here: a person puts
 * them in Secret Manager under the names the connection gives (`setup`), and connecting checks
 * them with the provider. Another organization's connection answers exactly like a missing one.
 */
export function registerConnectionRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly connections: ChannelConnectionService;
    readonly registry: IntegrationRegistry;
    /** Templates (ADR-0046). Absent: their routes answer 503. */
    readonly templates?: ChannelTemplateService;
  },
): void {
  const { connections, registry, templates } = dependencies;
  const base = '/v1/organizations/:organizationId';
  const list = `${base}/channel-connections`;
  const one = `${list}/:connectionId`;
  const idOf = (c: Context<AuthEnv>) => c.req.param('connectionId') ?? '';

  app.get(
    `${base}/integrations/providers`,
    withPermission('channel.read', dependencies, async (c) =>
      c.json({ providers: registry.list().map(toProviderView) }),
    ),
  );

  app.get(
    list,
    withPermission('channel.read', dependencies, (c, tenant) =>
      answer(c, async () => ({
        connections: (await connections.list(tenant)).map(toConnectionView),
      })),
    ),
  );

  app.post(
    list,
    withPermission('channel.create', dependencies, async (c, tenant) => {
      const body = await jsonOf(c);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(
        c,
        async () => {
          const created = await connections.create(tenant, {
            provider: body.provider,
            displayName: body.displayName,
            account: body.account,
          });
          return { ...toConnectionView(created), setup: setupOf(created) };
        },
        201,
      );
    }),
  );

  app.get(
    one,
    withPermission('channel.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const connection = await connections.get(tenant, idOf(c));
        return { ...toConnectionView(connection), setup: setupOf(connection) };
      }),
    ),
  );

  /**
   * `{ displayName }` renames it; `{ businessAccountId }` records the provider business account it
   * was made without (ADR-0046), once. One change per call.
   */
  app.patch(
    one,
    withPermission('channel.update', dependencies, async (c, tenant) => {
      const body = await jsonOf(c);
      const keys = body === undefined ? [] : Object.keys(body);
      if (
        body === undefined ||
        keys.length !== 1 ||
        !['displayName', 'businessAccountId'].includes(keys[0] as string)
      ) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, async () =>
        toConnectionView(
          'businessAccountId' in body
            ? await connections.setBusinessAccount(tenant, idOf(c), body.businessAccountId)
            : await connections.rename(tenant, idOf(c), body.displayName),
        ),
      );
    }),
  );

  for (const [action, permission, run] of [
    ['connect', 'channel.update', connections.connect],
    ['pause', 'channel.update', connections.pause],
    ['disconnect', 'channel.disconnect', connections.disconnect],
  ] as const) {
    app.post(
      `${one}/${action}`,
      withPermission(permission, dependencies, (c, tenant) =>
        answer(c, async () => toConnectionView(await run(tenant, idOf(c)))),
      ),
    );
  }

  app.delete(
    one,
    withPermission('channel.delete', dependencies, (c, tenant) =>
      answer(c, async () => toConnectionView(await connections.revoke(tenant, idOf(c)))),
    ),
  );

  // Templates (ADR-0046): registered by name and language, checked with the provider. Their
  // content lives with the provider; nothing here edits or invents one.
  const templateList = `${one}/templates`;
  const templateOne = `${templateList}/:templateId`;
  const templateIdOf = (c: Context<AuthEnv>) => c.req.param('templateId') ?? '';
  const withTemplates = async (
    c: Context<AuthEnv>,
    work: (service: ChannelTemplateService) => Promise<Response>,
  ): Promise<Response> =>
    templates === undefined ? c.json({ error: 'templates_not_configured' }, 503) : work(templates);

  app.get(
    templateList,
    withPermission('channel.read', dependencies, (c, tenant) =>
      withTemplates(c, (service) =>
        answer(c, async () => ({
          templates: (await service.list(tenant, idOf(c))).map(toTemplateView),
        })),
      ),
    ),
  );

  app.post(
    templateList,
    withPermission('channel.update', dependencies, async (c, tenant) => {
      const body = await jsonOf(c);
      if (body === undefined || Object.keys(body).some((k) => k !== 'name' && k !== 'language')) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return withTemplates(c, (service) =>
        answer(
          c,
          async () =>
            toTemplateView(
              await service.register(tenant, idOf(c), { name: body.name, language: body.language }),
            ),
          201,
        ),
      );
    }),
  );

  app.get(
    templateOne,
    withPermission('channel.read', dependencies, (c, tenant) =>
      withTemplates(c, (service) =>
        answer(c, async () => toTemplateView(await service.get(tenant, idOf(c), templateIdOf(c)))),
      ),
    ),
  );

  for (const action of ['check', 'disable'] as const) {
    app.post(
      `${templateOne}/${action}`,
      withPermission('channel.update', dependencies, (c, tenant) =>
        withTemplates(c, (service) =>
          answer(c, async () =>
            toTemplateView(await service[action](tenant, idOf(c), templateIdOf(c))),
          ),
        ),
      ),
    );
  }
}

const STATUS = {
  unresolved_tenant: 403,
  organization_inactive: 403,
  permission_denied: 403,
  requires_user: 403,
  invalid_connection: 400,
  connection_not_found: 404,
  connection_revoked: 409,
  invalid_transition: 409,
  limit_reached: 409,
  category_not_allowed: 403,
  entitlements_unavailable: 403,
  secret_unavailable: 503,
  invalid_template: 400,
  template_not_found: 404,
} as const;

async function jsonOf(c: Context<AuthEnv>): Promise<Record<string, unknown> | undefined> {
  try {
    const body = (await c.req.json()) as unknown;
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function answer(
  c: Context<AuthEnv>,
  work: () => Promise<unknown>,
  status: 200 | 201 = 200,
): Promise<Response> {
  try {
    return c.json(await work(), status);
  } catch (error) {
    if (isIntegrationError(error) && Object.hasOwn(STATUS, error.code)) {
      const code = error.code as keyof typeof STATUS;
      // Which field, for a refused configuration; never a value.
      return c.json(
        {
          error: code,
          ...((code === 'invalid_connection' || code === 'invalid_template') && error.detail
            ? { field: error.detail }
            : {}),
        },
        STATUS[code],
      );
    }
    throw error;
  }
}

/** A provider a connection can be made with: what it is and what it can do. */
function toProviderView(adapter: ChannelAdapter) {
  return {
    provider: adapter.provider,
    category: adapter.category,
    channel: adapter.channel,
    capabilities: adapter.capabilities,
  };
}

/** A connection without its secret references: they name where credentials live. */
export function toConnectionView(c: ChannelConnection) {
  return {
    id: c.id,
    provider: c.provider,
    category: c.category,
    channel: c.channel,
    status: c.status,
    statusReason: c.statusReason ?? null,
    displayName: c.displayName,
    account: {
      phoneNumberId: c.account.phoneNumberId,
      businessAccountId: c.account.businessAccountId ?? null,
      displayPhoneNumber: c.account.displayPhoneNumber ?? null,
    },
    capabilities: c.capabilities,
    lastValidatedAt: c.lastValidatedAt ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * What a person needs to finish setting a connection up, outside MelonOffice: the names of the
 * three secrets to create in the project's Secret Manager (never their values), and the webhook
 * path to give the provider. The project itself is not shown.
 */
function setupOf(c: ChannelConnection) {
  return {
    secretIds: Object.fromEntries(
      Object.entries(c.secrets).map(([kind, ref]) => [kind, ref.split('/')[3] ?? '']),
    ),
    webhookPath: `/webhooks/${c.channel}/${c.id}`,
  };
}

/** A template as a person sees it: what it is, whether it can be sent, and what it needs. */
export function toTemplateView(t: ChannelTemplate) {
  return {
    id: t.id,
    connectionId: t.connectionId,
    channel: t.channel,
    name: t.name,
    language: t.language,
    status: t.status,
    statusReason: t.statusReason ?? null,
    category: t.category ?? null,
    spec: t.spec ?? null,
    lastValidatedAt: t.lastValidatedAt ?? null,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}
