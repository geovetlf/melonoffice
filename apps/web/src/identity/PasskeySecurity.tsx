import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import { PasskeysProvider } from './PasskeysContext.js';
import { needsIdentityCheck, SignInAgain } from './SignInAgain.js';
import {
  PasskeyRequestError,
  type PasskeyOverview,
  type PasskeysClient,
} from './passkeysClient.js';

/**
 * A sensitive administrator's passkeys (ADR-0188): add one on this device, see when each was
 * used, remove one. Shown only to someone who administers something and only where passkeys are
 * set up; a business owner never sees it. The API decides every step.
 */
export function PasskeySecurity({ client }: { readonly client: PasskeysClient }) {
  const intl = useIntl();
  const [overview, setOverview] = useState<PasskeyOverview | 'loading' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [added, setAdded] = useState(false);

  const load = () =>
    client.overview().then(
      (value) => setOverview(value),
      () => setOverview('error'),
    );
  useEffect(() => {
    let live = true;
    client.overview().then(
      (value) => live && setOverview(value),
      () => live && setOverview('error'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  // Nothing to show while loading, when it cannot be read, or to someone who administers nothing.
  if (overview === 'loading' || overview === 'error') return null;
  if (!overview.available || !overview.administrator) return null;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setFailed(undefined);
    setAdded(false);
    try {
      await work();
      await load();
      return true;
    } catch (error) {
      // A cancelled device prompt is not a refusal: the person simply did not go on.
      setFailed(error instanceof PasskeyRequestError ? error.code : 'not_confirmed');
      return false;
    } finally {
      setBusy(false);
    }
  };
  const day = (iso: string) => intl.formatDate(new Date(iso), { dateStyle: 'medium' });

  return (
    <PasskeysProvider client={client}>
      <section className="mo-panel mo-page-section" aria-labelledby="passkey-security">
        <h2 id="passkey-security" className="mo-section-title">
          <FormattedMessage id="identity.passkeys.title" />
        </h2>
        <p className="mo-lead">
          <FormattedMessage id="identity.passkeys.lead" />
        </p>
        {overview.passkeys.length === 0 ? (
          <StateMessage kind="empty">
            <FormattedMessage id="identity.passkeys.none" />
          </StateMessage>
        ) : (
          <ul className="mo-list" aria-label="passkeys">
            {overview.passkeys.map((p) => (
              <li key={p.id} className="mo-list-item">
                <div className="mo-list-item__main">
                  <span className="mo-list-item__title">
                    <FormattedMessage
                      id="identity.passkeys.item"
                      values={{ date: day(p.createdAt) }}
                    />
                  </span>
                  <span className="mo-list-item__meta">
                    {p.lastUsedAt === null ? (
                      <FormattedMessage id="identity.passkeys.unused" />
                    ) : (
                      <FormattedMessage
                        id="identity.passkeys.used"
                        values={{ date: day(p.lastUsedAt) }}
                      />
                    )}
                  </span>
                </div>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (
                      !globalThis.confirm(
                        intl.formatMessage({ id: 'identity.passkeys.removeConfirm' }),
                      )
                    ) {
                      return;
                    }
                    void run(() => client.remove(p.id));
                  }}
                >
                  <FormattedMessage id="identity.passkeys.remove" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {client.supported() ? (
          <Button
            disabled={busy}
            onClick={() => {
              void run(() => client.add()).then((ok) => setAdded(ok));
            }}
          >
            <FormattedMessage id="identity.passkeys.add" />
          </Button>
        ) : (
          <StateMessage kind="warning">
            <FormattedMessage id="identity.passkey.unsupported" />
          </StateMessage>
        )}
        {added ? (
          <StateMessage kind="success">
            <FormattedMessage id="identity.passkeys.added" />
          </StateMessage>
        ) : null}
        {failed === undefined ? null : needsIdentityCheck(failed) ? (
          <SignInAgain code={failed} />
        ) : (
          <StateMessage kind="error">
            <FormattedMessage
              id={
                failed === 'not_confirmed'
                  ? 'identity.passkey.confirm.failed'
                  : 'identity.passkeys.error'
              }
              values={{ reason: failed }}
            />
          </StateMessage>
        )}
      </section>
    </PasskeysProvider>
  );
}
