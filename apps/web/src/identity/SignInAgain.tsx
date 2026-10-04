import { FormattedMessage } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useAuth } from './AuthProvider.js';

/** The API's refusal of a sensitive administrator's change after an old sign-in (ADR-0138). */
export const REAUTHENTICATION_REQUIRED = 'reauthentication_required';

/**
 * Says why a change was refused and lets the person sign in again. A new sign-in is what the API
 * checks; the browser decides nothing here.
 */
export function SignInAgain() {
  const { signOut } = useAuth();
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
