import { FormattedMessage } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useAuth, useCan } from '../identity/AuthProvider.js';
import { LanguageSwitcher, type LocaleProps } from '../identity/pages.js';

/**
 * The signed-in frame (ADR-0036): who is signed in, in which organization, and sign-out. Its
 * content is a placeholder until the Conversations Center is mounted here (next step).
 */
export function AppShell(locale: LocaleProps) {
  const { state, signOut } = useAuth();
  const canReadConversations = useCan('conversation.read');
  if (state.status !== 'signed_in' || state.workspace === undefined) return null;
  const { me, workspace } = state;
  return (
    <div className="shell">
      <header className="shell__header">
        <p className="shell__brand">
          <FormattedMessage id="app.name" />
        </p>
        <div className="shell__who">
          <span className="shell__organization">{workspace.organization.name}</span>
          <span className="shell__user">{me.email ?? me.userId}</span>
        </div>
        <Button variant="secondary" onClick={signOut}>
          <FormattedMessage id="auth.signOut" />
        </Button>
      </header>
      <main className="shell__main">
        <h1>
          <FormattedMessage id="home.title" />
        </h1>
        <p>
          <FormattedMessage
            id={canReadConversations ? 'home.conversationsNext' : 'home.noConversations'}
          />
        </p>
        <LanguageSwitcher {...locale} />
      </main>
    </div>
  );
}
