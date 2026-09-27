import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useMemo } from 'react';
import { ConversationsCenter } from '../conversations/ConversationsCenter.js';
import { createInboxClient } from '../conversations/inboxClient.js';
import { useAuth, useCan } from '../identity/AuthProvider.js';
import { LanguageSwitcher, type LocaleProps } from '../identity/pages.js';
import { navigate } from '../identity/router.js';

/**
 * The signed-in frame (ADR-0036): who is signed in, in which organization, sign-out, and the
 * Conversations Center (ADR-0035). The center reaches the API only through the session's
 * authenticated client, for the organization the API gave this user: it has no sign-in, tenant
 * choice or permission rules of its own.
 */
export function AppShell(locale: LocaleProps) {
  const { state, services, signOut } = useAuth();
  const intl = useIntl();
  const canReadConversations = useCan('conversation.read');
  const workspace = state.status === 'signed_in' ? state.workspace : undefined;
  const organizationId = workspace?.organization.id;
  const client = useMemo(
    () =>
      organizationId === undefined
        ? undefined
        : createInboxClient(services.api.request, organizationId),
    [services, organizationId],
  );
  if (state.status !== 'signed_in' || workspace === undefined || client === undefined) return null;
  const { me } = state;
  return (
    <div className="shell">
      <header className="shell__header">
        <p className="shell__brand">
          <FormattedMessage id="app.name" />
        </p>
        <nav aria-label={intl.formatMessage({ id: 'nav.label' })} className="shell__nav">
          {canReadConversations ? (
            <a
              href="/"
              aria-current="page"
              onClick={(event) => {
                event.preventDefault();
                navigate('/');
              }}
            >
              <FormattedMessage id="nav.conversations" />
            </a>
          ) : null}
        </nav>
        <div className="shell__who">
          <span className="shell__organization">{workspace.organization.name}</span>
          <span className="shell__user">{me.email ?? me.userId}</span>
        </div>
        <Button variant="secondary" onClick={signOut}>
          <FormattedMessage id="auth.signOut" />
        </Button>
      </header>
      <main className="shell__main">
        {canReadConversations ? (
          <ConversationsCenter
            client={client}
            currentUserId={me.userId}
            can={(permission) => workspace.permissions.has(permission)}
          />
        ) : (
          <>
            <h1>
              <FormattedMessage id="home.title" />
            </h1>
            <p>
              <FormattedMessage id="home.noConversations" />
            </p>
          </>
        )}
        <LanguageSwitcher {...locale} />
      </main>
    </div>
  );
}
