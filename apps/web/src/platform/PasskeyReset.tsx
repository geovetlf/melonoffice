import { FormattedMessage } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useId, useState } from 'react';
import { needsIdentityCheck, SignInAgain } from '../identity/SignInAgain.js';
import { PasskeyRequestError, type PasskeysClient } from '../identity/passkeysClient.js';

/**
 * For someone who lost every device with their passkey (ADR-0188): the platform administrator
 * removes their passkeys, and they go back to signing in again until they add a new one. The API
 * checks the administrator and records it.
 */
export function PasskeyReset({ client }: { readonly client: PasskeysClient }) {
  const id = useId();
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<number>();
  const [failed, setFailed] = useState<string>();

  return (
    <section className="mo-panel mo-page-section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="mo-section-title">
        <FormattedMessage id="platform.passkeys.title" />
      </h2>
      <p className="mo-lead">
        <FormattedMessage id="platform.passkeys.lead" />
      </p>
      <form
        className="platform__form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setFailed(undefined);
          setRemoved(undefined);
          client.reset(userId.trim()).then(
            (count) => {
              setRemoved(count);
              setUserId('');
              setBusy(false);
            },
            (error: unknown) => {
              setFailed(error instanceof PasskeyRequestError ? error.code : 'network');
              setBusy(false);
            },
          );
        }}
      >
        <label htmlFor={`${id}-user`}>
          <FormattedMessage id="platform.passkeys.user" />
        </label>
        <input
          id={`${id}-user`}
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          required
          spellCheck={false}
        />
        <Button type="submit" disabled={busy || userId.trim() === ''}>
          <FormattedMessage id="platform.passkeys.reset" />
        </Button>
      </form>
      {removed === undefined ? null : (
        <StateMessage kind="success">
          <FormattedMessage id="platform.passkeys.done" values={{ count: removed }} />
        </StateMessage>
      )}
      {failed === undefined ? null : needsIdentityCheck(failed) ? (
        <SignInAgain code={failed} />
      ) : (
        <StateMessage kind="error">
          <FormattedMessage id="platform.refused" values={{ reason: failed }} />
        </StateMessage>
      )}
    </section>
  );
}
