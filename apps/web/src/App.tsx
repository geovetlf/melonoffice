import { WithoutOrganization } from './commercial/WithoutOrganization.js';
import { AuthProvider } from './identity/AuthProvider.js';
import {
  FORGOT_PASSWORD_PATH,
  ForgotPasswordPage,
  Loading,
  LoginPage,
  NotConfigured,
  ProtectedRoute,
  PublicFrame,
  SIGN_UP_PATH,
  SignUpPage,
  type LocaleProps,
} from './identity/pages.js';
import { usePath } from './identity/router.js';
import type { IdentityServices } from './identity/services.js';
import { InvitePage } from './invitations/InvitePage.js';
import { JoinPage } from './invitations/JoinPage.js';
import { INVITE_PATH, JOIN_PATH } from './invitations/invitationToken.js';
import { AppShell } from './shell/AppShell.js';
import { paths } from './shell/routes.js';

export interface AppProps extends LocaleProps {
  /** The sign-in services: still loading, ready, or `undefined` when this site has none set up. */
  readonly identity: 'loading' | IdentityServices | undefined;
}

/**
 * The web app (ADR-0036): `/login`, `/signup` and `/forgot-password` are public (ADR-0105), `/invite` walks an invited person in (ADR-0089),
 * `/join` walks someone invited to a partner or agency account in (ADR-0093), and every other
 * path is behind `ProtectedRoute`.
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
  if (path === SIGN_UP_PATH) return <SignUpPage {...locale} />;
  if (path === FORGOT_PASSWORD_PATH) return <ForgotPasswordPage {...locale} />;
  if (path === INVITE_PATH) return <InvitePage {...locale} />;
  if (path === JOIN_PATH) return <JoinPage {...locale} />;
  return (
    <ProtectedRoute
      {...locale}
      withoutOrganization={
        <WithoutOrganization {...locale} partnerConsole={path === paths.partnerConsole()} />
      }
    >
      <AppShell {...locale} />
    </ProtectedRoute>
  );
}
