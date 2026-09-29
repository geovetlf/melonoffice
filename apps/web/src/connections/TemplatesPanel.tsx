import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useState, type FormEvent } from 'react';
import {
  ConnectionsError,
  type ConnectionsClient,
  type TemplateView,
} from './connectionsClient.js';

/**
 * A connection's message templates (ADR-0046). Templates are written and approved in the
 * provider's own tools; here a person registers one by its name and language, and MelonOffice
 * checks with the provider whether it is approved and what values it needs. Only an active
 * template is ever sent. Nothing here edits a template's content.
 */

/** The provider's template name and language, as the server accepts them. */
const NAME = /^[a-z0-9_]{1,512}$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Z][a-z]{3})?(_[A-Z]{2})?$/;

export function TemplatesPanel({
  client,
  connectionId,
  canUpdate,
}: {
  readonly client: ConnectionsClient;
  readonly connectionId: string;
  readonly canUpdate: boolean;
}) {
  const intl = useIntl();
  const [templates, setTemplates] = useState<readonly TemplateView[] | 'error' | undefined>();
  const [notConfigured, setNotConfigured] = useState(false);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState('es');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    client.templates(connectionId).then(
      (list) => live && setTemplates(list),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ConnectionsError && e.code === 'templates_not_configured') {
          setNotConfigured(true);
        }
        setTemplates('error');
      },
    );
    return () => {
      live = false;
    };
  }, [client, connectionId]);

  const errorOf = (e: unknown): string => {
    const code = e instanceof ConnectionsError ? e.code : 'generic';
    const id = `connections.templates.error.${code}`;
    return Object.hasOwn(intl.messages, id) ? id : 'connections.templates.error.generic';
  };

  const upsert = (next: TemplateView) =>
    setTemplates((list) =>
      Array.isArray(list)
        ? list.some((t) => t.id === next.id)
          ? list.map((t) => (t.id === next.id ? next : t))
          : [...list, next]
        : [next],
    );

  async function run(key: string, work: () => Promise<TemplateView>) {
    setBusy(key);
    setError(undefined);
    try {
      upsert(await work());
      return true;
    } catch (e) {
      setError(errorOf(e));
      return false;
    } finally {
      setBusy(undefined);
    }
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    const clean = name.trim();
    if (!NAME.test(clean) || !LANGUAGE.test(language.trim())) {
      setError('connections.templates.error.invalid_template');
      return;
    }
    const done = await run('register', () =>
      client.registerTemplate(connectionId, { name: clean, language: language.trim() }),
    );
    if (done) setName('');
  }

  const titleId = `templates-${connectionId}`;
  return (
    <section className="connection-card__templates" aria-labelledby={titleId}>
      <h3 id={titleId}>
        <FormattedMessage id="connections.templates.title" />
      </h3>
      <p className="customers__meta">
        <FormattedMessage id="connections.templates.intro" />
      </p>
      {templates === undefined ? (
        <p className="notice" role="status">
          <FormattedMessage id="connections.loading" />
        </p>
      ) : templates === 'error' ? (
        <p className="notice" role="alert">
          <FormattedMessage
            id={
              notConfigured
                ? 'connections.templates.notConfigured'
                : 'connections.templates.error.generic'
            }
          />
        </p>
      ) : (
        <>
          {templates.length === 0 ? (
            <p className="notice">
              <FormattedMessage id="connections.templates.none" />
            </p>
          ) : (
            <ul className="documents__list">
              {templates.map((t) => (
                <li key={t.id} className="approval-card">
                  <div className="documents__main">
                    <strong>
                      {t.name} · {t.language}
                    </strong>
                    <span className="documents__meta">
                      <FormattedMessage id={`connections.templates.status.${t.status}`} />
                      {t.category === null ? null : ` · ${t.category}`}
                      {t.statusReason === null
                        ? null
                        : ` · ${
                            Object.hasOwn(
                              intl.messages,
                              `connections.templates.reason.${t.statusReason}`,
                            )
                              ? intl.formatMessage({
                                  id: `connections.templates.reason.${t.statusReason}`,
                                })
                              : t.statusReason
                          }`}
                    </span>
                    {t.spec === null ? null : (
                      <span className="documents__meta">
                        <FormattedMessage
                          id="connections.templates.needs"
                          values={{
                            body: t.spec.bodyParameters,
                            header:
                              t.spec.header.format === 'none'
                                ? 0
                                : t.spec.header.format === 'text'
                                  ? t.spec.header.parameters
                                  : 1,
                            buttons: t.spec.urlButtons.length,
                          }}
                        />
                      </span>
                    )}
                  </div>
                  {canUpdate ? (
                    <div className="customers__actions">
                      <Button
                        variant="secondary"
                        disabled={busy !== undefined}
                        onClick={() =>
                          void run(`check:${t.id}`, () => client.checkTemplate(connectionId, t.id))
                        }
                      >
                        <FormattedMessage id="connections.templates.check" />
                      </Button>
                      {t.status === 'disabled' ? null : (
                        <Button
                          variant="secondary"
                          disabled={busy !== undefined}
                          onClick={() =>
                            void run(`disable:${t.id}`, () =>
                              client.disableTemplate(connectionId, t.id),
                            )
                          }
                        >
                          <FormattedMessage id="connections.templates.disable" />
                        </Button>
                      )}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canUpdate ? (
            <form className="connections__form" onSubmit={(e) => void register(e)}>
              <label className="documents__picker">
                <span>
                  <FormattedMessage id="connections.templates.name" />
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="order_update"
                  maxLength={512}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <label className="documents__picker">
                <span>
                  <FormattedMessage id="connections.templates.language" />
                </span>
                <input
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  maxLength={12}
                  autoCapitalize="none"
                  spellCheck={false}
                />
              </label>
              <div className="customers__actions">
                <Button type="submit" disabled={name.trim() === '' || busy !== undefined}>
                  <FormattedMessage
                    id={
                      busy === 'register'
                        ? 'connections.templates.registering'
                        : 'connections.templates.register'
                    }
                  />
                </Button>
              </div>
            </form>
          ) : null}
        </>
      )}
      {error === undefined ? null : (
        <p className="notice notice--danger" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
    </section>
  );
}
