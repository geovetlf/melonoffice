import { AuthProvider } from './identity/AuthProvider.js';
import {
  Loading,
  LoginPage,
  NotConfigured,
  ProtectedRoute,
  PublicFrame,
  type LocaleProps,
} from './identity/pages.js';
import { usePath } from './identity/router.js';
import type { IdentityServices } from './identity/services.js';
import { InvitePage } from './invitations/InvitePage.js';
import { INVITE_PATH } from './invitations/invitationToken.js';
import { AppShell } from './shell/AppShell.js';

export interface AppProps extends LocaleProps {
  /** The sign-in services: still loading, ready, or `undefined` when this site has none set up. */
  readonly identity: 'loading' | IdentityServices | undefined;
}

/**
 * The web app (ADR-0036): `/login` is public, `/invite` walks an invited person in (ADR-0089),
 * and every other path is behind `ProtectedRoute`.
 */
export function App({ identity, ...locale }: AppProps) {
  if (identity === 'loading') {
    return (
      <PublicFrame {...locale}>
        <Loading />
      </PublicFrame>
    );
  }
  if (identity === undefined) return <NotConfigured {...locale} />;
  return (
    <AuthProvider services={identity}>
      <Pages {...locale} />
    </AuthProvider>
  );
}

function Pages(locale: LocaleProps) {
  const path = usePath();
  if (path === '/login') return <LoginPage {...locale} />;
  if (path === INVITE_PATH) return <InvitePage {...locale} />;
  return (
    <ProtectedRoute {...locale}>
      <AppShell {...locale} />
    </ProtectedRoute>
  );
}
