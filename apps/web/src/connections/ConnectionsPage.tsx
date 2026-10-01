import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, Button, PageHeader, StateMessage, type BadgeTone } from '@melonoffice/ui';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ConnectionsError,
  type ConnectionSetup,
  type ConnectionStatus,
  type ConnectionView,
  type ConnectionsClient,
  type ProviderView,
} from './connectionsClient.js';
import { TemplatesPanel } from './TemplatesPanel.js';

/**
 * Settings → Connections (ADR-0044): the organization's connections to outside services, made
 * through the Integration Engine's routes. Providers come from the server's registry; the screen
 * only knows how to ask for each one's account fields. It offers only the actions the person's
 * permissions allow (the API still decides), and it never asks for, shows or keeps a secret: it
 * shows the names of the secrets to create in the environment's Secret Manager, and the webhook
 * address to give the provider.
 */

/** The non-secret account fields each known provider needs, as the server checks them. */
const ACCOUNT_FIELDS: Readonly<
  Record<string, readonly { readonly name: string; readonly required: boolean }[]>
> = {
  meta_whatsapp_cloud: [
    { name: 'phoneNumberId', required: true },
    { name: 'displayPhoneNumber', required: false },
  ],
};

/** What each permission lets a person do here; `channel.read` is needed to see the screen. */
export interface ConnectionPermissions {
  readonly create: boolean;
  readonly update: boolean;
  readonly disconnect: boolean;
  readonly delete: boolean;
}

export const permissionsOf = (can: (permission: string) => boolean): ConnectionPermissions => ({
  create: can('channel.create'),
  update: can('channel.update'),
  disconnect: can('channel.disconnect'),
  delete: can('channel.delete'),
});

const TONE: Record<ConnectionStatus, BadgeTone> = {
  created: 'warning',
  connecting: 'warning',
  connected: 'success',
  paused: 'warning',
  error: 'danger',
  disconnected: 'neutral',
  revoked: 'neutral',
};

/** Enough of a phone number to recognise it, not to read it out: `+51 9••••45`. */
export function maskPhone(value: string | null): string | null {
  if (value === null || value.length < 6) return value;
  return `${value.slice(0, 4)}••••${value.slice(-2)}`;
}

type Busy = { readonly id: string; readonly action: string } | undefined;

export function ConnectionsPage({
  client,
  permissions,
  apiUrl,
}: {
  readonly client: ConnectionsClient;
  readonly permissions: ConnectionPermissions;
  /** The API's address, to show the full webhook URL. */
  readonly apiUrl: string;
}) {
  const intl = useIntl();
  const [providers, setProviders] = useState<readonly ProviderView[] | undefined>();
  const [connections, setConnections] = useState<readonly ConnectionView[] | undefined>();
  const [error, setError] = useState<ConnectionsError | undefined>();
  const [creating, setCreating] = useState<string | undefined>();
  const [setup, setSetup] = useState<{ id: string; value: ConnectionSetup } | undefined>();
  const [busy, setBusy] = useState<Busy>();
  const [confirmDelete, setConfirmDelete] = useState<string | undefined>();
  const [renaming, setRenaming] = useState<string | undefined>();
  const [templatesFor, setTemplatesFor] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    Promise.all([client.providers(), client.list()]).then(
      ([p, c]) => {
        if (!live) return;
        setProviders(p);
        setConnections(c.filter((x) => x.status !== 'revoked'));
      },
      (e: unknown) =>
        live && setError(e instanceof ConnectionsError ? e : new ConnectionsError('generic')),
    );
    return () => {
      live = false;
    };
  }, [client]);

  const replace = (next: ConnectionView) =>
    setConnections((list) =>
      (list ?? []).map((c) => (c.id === next.id ? next : c)).filter((c) => c.status !== 'revoked'),
    );

  async function act(id: string, action: string, run: () => Promise<ConnectionView>) {
    setBusy({ id, action });
    setError(undefined);
    try {
      replace(await run());
    } catch (e) {
      setError(e instanceof ConnectionsError ? e : new ConnectionsError('generic'));
    } finally {
      setBusy(undefined);
    }
  }

  async function showSetup(id: string) {
    if (setup?.id === id) return setSetup(undefined);
    try {
      setSetup({ id, value: await client.setup(id) });
    } catch (e) {
      setError(e instanceof ConnectionsError ? e : new ConnectionsError('generic'));
    }
  }

  const known = (providers ?? []).filter((p) => ACCOUNT_FIELDS[p.provider] !== undefined);

  return (
    <section className="mo-page connections-page" aria-labelledby="connections-title">
      <PageHeader
        titleId="connections-title"
        title={<FormattedMessage id="connections.title" />}
        eyebrow={<FormattedMessage id="nav.settings" />}
        description={<FormattedMessage id="connections.intro" />}
        actions={
          permissions.create && known.length > 0 && creating === undefined ? (
            <Button onClick={() => setCreating(known[0]?.provider)}>
              <FormattedMessage id="connections.add" />
            </Button>
          ) : null
        }
      />

      {error === undefined ? null : (
        <StateMessage kind="error">
          <FormattedMessage
            id={
              intl.messages[`connections.error.${error.code}`] === undefined
                ? 'connections.error.generic'
                : `connections.error.${error.code}`
            }
          />
          {error.field === undefined ? null : ` (${error.field})`}
        </StateMessage>
      )}

      {creating === undefined ? null : (
        <CreateForm
          providers={known}
          provider={creating}
          onProvider={setCreating}
          onCancel={() => setCreating(undefined)}
          onCreate={async (input) => {
            setError(undefined);
            try {
              const created = await client.create(input);
              const { setup: value, ...view } = created;
              setConnections((list) => [...(list ?? []), view]);
              setSetup({ id: view.id, value });
              setCreating(undefined);
            } catch (e) {
              setError(e instanceof ConnectionsError ? e : new ConnectionsError('generic'));
            }
          }}
        />
      )}

      {connections === undefined || providers === undefined ? (
        error === undefined ? (
          <StateMessage kind="loading">
            <FormattedMessage id="connections.loading" />
          </StateMessage>
        ) : null
      ) : (
        <ul className="mo-list">
          {known.length === 0 && connections.length === 0 ? (
            <li>
              <StateMessage kind="empty">
                <FormattedMessage id="connections.noProviders" />
              </StateMessage>
            </li>
          ) : null}
          {connections.map((c) => (
            <li key={c.id} className="mo-list-item connections-page__item" data-status={c.status}>
              <div className="mo-list-item__main">
                <ProviderName provider={c.provider} />
                <p className="connections-page__name">{c.displayName}</p>
                <p className="mo-list-item__meta">
                  {maskPhone(c.account.displayPhoneNumber) ?? (
                    <FormattedMessage id="connections.noPhone" />
                  )}
                </p>
                <p className="mo-list-item__meta">
                  <Badge tone={TONE[c.status]}>
                    <FormattedMessage id={`connections.status.${c.status}`} />
                  </Badge>
                  {c.status === 'error' && c.statusReason !== null ? (
                    <span>
                      {' · '}
                      {intl.messages[`connections.reason.${c.statusReason}`] === undefined ? (
                        c.statusReason
                      ) : (
                        <FormattedMessage id={`connections.reason.${c.statusReason}`} />
                      )}
                    </span>
                  ) : null}
                </p>
              </div>
              {renaming === c.id ? (
                <RenameForm
                  current={c.displayName}
                  onCancel={() => setRenaming(undefined)}
                  onSave={async (name) => {
                    await act(c.id, 'rename', () => client.rename(c.id, name));
                    setRenaming(undefined);
                  }}
                />
              ) : null}
              <div className="mo-list-item__actions">
                <Button variant="secondary" size="sm" onClick={() => void showSetup(c.id)}>
                  <FormattedMessage id="connections.action.setup" />
                </Button>
                {c.channel === 'whatsapp' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-expanded={templatesFor === c.id}
                    onClick={() => setTemplatesFor(templatesFor === c.id ? undefined : c.id)}
                  >
                    <FormattedMessage id="connections.action.templates" />
                  </Button>
                ) : null}
                {permissions.update && c.status !== 'connected' && c.status !== 'connecting' ? (
                  <Button
                    size="sm"
                    disabled={busy !== undefined}
                    onClick={() => void act(c.id, 'connect', () => client.connect(c.id))}
                  >
                    <FormattedMessage id="connections.action.connect" />
                  </Button>
                ) : null}
                {permissions.update && c.status === 'connected' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== undefined}
                    onClick={() => void act(c.id, 'pause', () => client.pause(c.id))}
                  >
                    <FormattedMessage id="connections.action.pause" />
                  </Button>
                ) : null}
                {permissions.update && renaming !== c.id ? (
                  <Button size="sm" variant="secondary" onClick={() => setRenaming(c.id)}>
                    <FormattedMessage id="connections.action.rename" />
                  </Button>
                ) : null}
                {permissions.disconnect && c.status !== 'disconnected' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy !== undefined}
                    onClick={() => void act(c.id, 'disconnect', () => client.disconnect(c.id))}
                  >
                    <FormattedMessage id="connections.action.disconnect" />
                  </Button>
                ) : null}
                {permissions.delete && confirmDelete !== c.id ? (
                  <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(c.id)}>
                    <FormattedMessage id="connections.action.delete" />
                  </Button>
                ) : null}
              </div>
              {permissions.delete && confirmDelete === c.id ? (
                <div className="connections-page__wide connections-page__confirm" role="group">
                  <p>
                    <FormattedMessage id="connections.confirmDelete" />
                  </p>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy !== undefined}
                    onClick={async () => {
                      await act(c.id, 'delete', () => client.remove(c.id));
                      setConfirmDelete(undefined);
                    }}
                  >
                    <FormattedMessage id="connections.action.confirmDelete" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(undefined)}>
                    <FormattedMessage id="common.cancel" />
                  </Button>
                </div>
              ) : null}
              {setup?.id === c.id ? <SetupPanel setup={setup.value} apiUrl={apiUrl} /> : null}
              {templatesFor === c.id ? (
                <TemplatesPanel
                  client={client}
                  connectionId={c.id}
                  canUpdate={permissions.update}
                />
              ) : null}
            </li>
          ))}
          {/* Each registered provider without a connection yet, as a place to start one. */}
          {known
            .filter((p) => !connections.some((c) => c.provider === p.provider))
            .map((p) => (
              <li
                key={p.provider}
                className="mo-list-item connections-page__item"
                data-status="none"
              >
                <div className="mo-list-item__main">
                  <ProviderName provider={p.provider} />
                  <p className="mo-list-item__meta">
                    <Badge>
                      <FormattedMessage id="connections.status.none" />
                    </Badge>
                  </p>
                </div>
                {permissions.create && creating === undefined ? (
                  <div className="mo-list-item__actions">
                    <Button size="sm" onClick={() => setCreating(p.provider)}>
                      <FormattedMessage id="connections.action.configure" />
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}

function ProviderName({ provider }: { readonly provider: string }) {
  const intl = useIntl();
  const known = intl.messages[`connections.provider.${provider}.name`] !== undefined;
  return (
    <p className="mo-list-item__title connections-page__provider">
      <strong>
        {known ? <FormattedMessage id={`connections.provider.${provider}.name`} /> : provider}
      </strong>
      {known ? (
        <span className="mo-list-item__meta">
          <FormattedMessage id={`connections.provider.${provider}.source`} />
        </span>
      ) : null}
    </p>
  );
}

function CreateForm({
  providers,
  provider,
  onProvider,
  onCancel,
  onCreate,
}: {
  readonly providers: readonly ProviderView[];
  readonly provider: string;
  readonly onProvider: (provider: string) => void;
  readonly onCancel: () => void;
  readonly onCreate: (input: {
    provider: string;
    displayName: string;
    account: Record<string, string>;
  }) => Promise<void>;
}) {
  const intl = useIntl();
  const [sending, setSending] = useState(false);
  const fields = ACCOUNT_FIELDS[provider] ?? [];
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const account: Record<string, string> = {};
    for (const field of fields) {
      const value = String(data.get(field.name) ?? '').trim();
      if (value !== '') account[field.name] = value;
    }
    setSending(true);
    try {
      await onCreate({
        provider,
        displayName: String(data.get('displayName') ?? '').trim(),
        account,
      });
    } finally {
      setSending(false);
    }
  }
  return (
    <form
      className="mo-panel mo-form"
      onSubmit={(e) => void submit(e)}
      aria-label={intl.formatMessage({ id: 'connections.add' })}
    >
      {providers.length > 1 ? (
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="connections.field.provider" />
          </span>
          <select value={provider} onChange={(e) => onProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.provider} value={p.provider}>
                {intl.messages[`connections.provider.${p.provider}.name`] === undefined
                  ? p.provider
                  : intl.formatMessage({ id: `connections.provider.${p.provider}.name` })}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <ProviderName provider={provider} />
      )}
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="connections.field.displayName" />
        </span>
        <input name="displayName" required maxLength={80} autoComplete="off" />
      </label>
      {fields.map((field) => (
        <label key={field.name} className="mo-field">
          <span className="mo-label">
            <FormattedMessage id={`connections.field.${field.name}`} />
            {field.required ? null : (
              <span className="mo-hint">
                {' '}
                <FormattedMessage id="connections.optional" />
              </span>
            )}
          </span>
          <input name={field.name} required={field.required} autoComplete="off" />
        </label>
      ))}
      <p className="mo-hint">
        <FormattedMessage id="connections.noSecretsHere" />
      </p>
      <div className="mo-form__actions">
        <Button type="submit" disabled={sending}>
          <FormattedMessage id="connections.create" />
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          <FormattedMessage id="common.cancel" />
        </Button>
      </div>
    </form>
  );
}

function RenameForm({
  current,
  onCancel,
  onSave,
}: {
  readonly current: string;
  readonly onCancel: () => void;
  readonly onSave: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(current);
  return (
    <form
      className="mo-form connections-page__wide"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(name.trim());
      }}
    >
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="connections.field.displayName" />
        </span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          maxLength={80}
          autoComplete="off"
        />
      </label>
      <div className="mo-form__actions">
        <Button type="submit" size="sm">
          <FormattedMessage id="connections.save" />
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          <FormattedMessage id="common.cancel" />
        </Button>
      </div>
    </form>
  );
}

/** Where the credentials go and what to give the provider: names and addresses, never values. */
function SetupPanel({
  setup,
  apiUrl,
}: {
  readonly setup: ConnectionSetup;
  readonly apiUrl: string;
}) {
  return (
    <div className="connection-setup connections-page__wide">
      <h2 className="mo-subsection-title">
        <FormattedMessage id="connections.setup.title" />
      </h2>
      <ol>
        <li>
          <FormattedMessage id="connections.setup.secrets" />
          <ul className="connection-setup__names">
            {Object.entries(setup.secretIds).map(([kind, name]) => (
              <li key={kind}>
                <span className="connection-setup__kind">
                  <FormattedMessage id={`connections.secret.${kind}`} />
                </span>
                <code>{name}</code>
              </li>
            ))}
          </ul>
        </li>
        <li>
          <FormattedMessage id="connections.setup.webhook" />
          <code className="connection-setup__url">{`${apiUrl}${setup.webhookPath}`}</code>
        </li>
        <li>
          <FormattedMessage id="connections.setup.connect" />
        </li>
      </ol>
    </div>
  );
}
