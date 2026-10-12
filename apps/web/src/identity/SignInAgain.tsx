import { FormattedMessage } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useState } from 'react';
import { useAuth } from './AuthProvider.js';
import { usePasskeys } from './PasskeysContext.js';

/** The API's refusal of a sensitive administrator's change after an old sign-in (ADR-0138). */
export const REAUTHENTICATION_REQUIRED = 'reauthentication_required';
/** The same refusal for a person with passkeys: they confirm with one (ADR-0188). */
export const PASSKEY_REQUIRED = 'passkey_required';

/** Whether a refusal asks the person to prove again that it is them. */
export const needsIdentityCheck = (code: string | undefined): boolean =>
  code === REAUTHENTICATION_REQUIRED || code === PASSKEY_REQUIRED;

/**
 * Says why a change was refused and how to go on: sign in again, or, for a person with passkeys,
 * confirm with one. A new sign-in or a passkey confirmation is what the API checks; the browser
 * decides nothing here.
 */
export function SignInAgain({ code = REAUTHENTICATION_REQUIRED }: { readonly code?: string }) {
  const { signOut } = useAuth();
  if (code === PASSKEY_REQUIRED) return <ConfirmWithPasskey />;
  return (
    <StateMessage
      kind="error"
      action={
        <Button variant="secondary" onClick={signOut}>
          <FormattedMessage id="identity.signInAgain.action" />
        </Button>
      }
    >
      <FormattedMessage id="identity.signInAgain.message" />
    </StateMessage>
  );
}

/** Asks for the passkey; once confirmed, the person repeats the change. */
export function ConfirmWithPasskey() {
  const passkeys = usePasskeys();
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  if (state === 'done') {
    return (
      <StateMessage kind="success">
        <FormattedMessage id="identity.passkey.confirm.done" />
      </StateMessage>
    );
  }
  const supported = passkeys?.supported() ?? false;
  return (
    <StateMessage
      kind="error"
      action={
        supported ? (
          <Button
            variant="secondary"
            disabled={state === 'busy'}
            onClick={() => {
              setState('busy');
              passkeys?.confirm().then(
                () => setState('done'),
                () => setState('failed'),
              );
            }}
          >
            <FormattedMessage id="identity.passkey.confirm.action" />
          </Button>
        ) : undefined
      }
    >
      <FormattedMessage
        id={
          !supported
            ? 'identity.passkey.unsupported'
            : state === 'failed'
              ? 'identity.passkey.confirm.failed'
              : 'identity.passkey.confirm.message'
        }
      />
    </StateMessage>
  );
}
