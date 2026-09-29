/**
 * Settings → Connections' view of the API (ADR-0044). It calls only the Integration Engine's
 * routes of one organization, through the caller's authenticated request function: which
 * organization, which providers exist and whether a change is allowed are the server's decisions.
 * No secret passes through here: the server answers with the names of the secrets to create, never
 * their values, and this client never sends one.
 */

/** The connection states of the Integration Engine's lifecycle, exactly. */
export type ConnectionStatus =
  'created' | 'connecting' | 'connected' | 'paused' | 'error' | 'disconnected' | 'revoked';

export interface ProviderView {
  readonly provider: string;
  readonly category: string;
  readonly channel: string;
}

export interface ConnectionView {
  readonly id: string;
  readonly provider: string;
  readonly category: string;
  readonly channel: string;
  readonly status: ConnectionStatus;
  readonly statusReason: string | null;
  readonly displayName: string;
  readonly account: {
    readonly phoneNumberId: string;
    readonly displayPhoneNumber: string | null;
  };
  readonly lastValidatedAt: string | null;
  readonly updatedAt: string;
}

/** What is left to do outside MelonOffice: secret names and the webhook path, never values. */
export interface ConnectionSetup {
  readonly secretIds: Readonly<Record<string, string>>;
  readonly webhookPath: string;
}

export interface NewConnection {
  readonly provider: string;
  readonly displayName: string;
  readonly account: Readonly<Record<string, string>>;
}

/** Why the API refused something: a stable code, and the refused field when it names one. */
export class ConnectionsError extends Error {
  override readonly name = 'ConnectionsError';
  constructor(
    readonly code: string,
    readonly field?: string,
  ) {
    super(code);
  }
}

/** A message template on a connection (ADR-0046), as the provider confirmed it. */
export type TemplateStatus = 'pending' | 'active' | 'invalid' | 'disabled';

export interface TemplateView {
  readonly id: string;
  readonly name: string;
  readonly language: string;
  readonly status: TemplateStatus;
  readonly statusReason: string | null;
  readonly category: string | null;
  readonly spec: {
    readonly header:
      | { readonly format: 'none' }
      | { readonly format: 'text'; readonly parameters: number }
      | { readonly format: 'image' | 'document' | 'video' };
    readonly bodyParameters: number;
    readonly urlButtons: readonly { readonly index: number }[];
  } | null;
  readonly lastValidatedAt: string | null;
}

export interface ConnectionsClient {
  providers(): Promise<readonly ProviderView[]>;
  list(): Promise<readonly ConnectionView[]>;
  setup(id: string): Promise<ConnectionSetup>;
  create(input: NewConnection): Promise<ConnectionView & { readonly setup: ConnectionSetup }>;
  rename(id: string, displayName: string): Promise<ConnectionView>;
  connect(id: string): Promise<ConnectionView>;
  pause(id: string): Promise<ConnectionView>;
  disconnect(id: string): Promise<ConnectionView>;
  remove(id: string): Promise<ConnectionView>;
  templates(id: string): Promise<readonly TemplateView[]>;
  /** Registers a template made and approved in the provider's tools, then checks it there. */
  registerTemplate(
    id: string,
    template: { readonly name: string; readonly language: string },
  ): Promise<TemplateView>;
  checkTemplate(id: string, templateId: string): Promise<TemplateView>;
  disableTemplate(id: string, templateId: string): Promise<TemplateView>;
}

type Request = (path: string, init?: RequestInit) => Promise<Response>;

export function createConnectionsClient(
  request: Request,
  organizationId: string,
): ConnectionsClient {
  const org = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  const base = `${org}/channel-connections`;
  const one = (id: string) => `${base}/${encodeURIComponent(id)}`;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await request(path, init);
    const body = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      field?: unknown;
    };
    if (!response.ok) {
      throw new ConnectionsError(
        typeof body.error === 'string' ? body.error : 'generic',
        typeof body.field === 'string' ? body.field : undefined,
      );
    }
    return body as T;
  }
  const send = <T>(method: string, path: string, body?: unknown) =>
    call<T>(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });

  return {
    providers: async () =>
      (await call<{ providers: ProviderView[] }>(`${org}/integrations/providers`)).providers,
    list: async () => (await call<{ connections: ConnectionView[] }>(base)).connections,
    setup: async (id) => (await call<{ setup: ConnectionSetup }>(one(id))).setup,
    create: (input) => send('POST', base, input),
    rename: (id, displayName) => send('PATCH', one(id), { displayName }),
    connect: (id) => send('POST', `${one(id)}/connect`),
    pause: (id) => send('POST', `${one(id)}/pause`),
    disconnect: (id) => send('POST', `${one(id)}/disconnect`),
    remove: (id) => send('DELETE', one(id)),
    templates: async (id) =>
      (await call<{ templates: TemplateView[] }>(`${one(id)}/templates`)).templates,
    registerTemplate: (id, template) => send('POST', `${one(id)}/templates`, template),
    checkTemplate: (id, templateId) =>
      send('POST', `${one(id)}/templates/${encodeURIComponent(templateId)}/check`),
    disableTemplate: (id, templateId) =>
      send('POST', `${one(id)}/templates/${encodeURIComponent(templateId)}/disable`),
  };
}
