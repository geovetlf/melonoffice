import { FormattedMessage, SUPPORTED_LOCALES, useIntl, type Locale } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useBrand } from '../brand/brand.js';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from './AuthProvider.js';
import type { IdentityErrorCode } from './identityPlatform.js';
import { navigate } from './router.js';
import {
  INVITE_PATH,
  JOIN,
  JOIN_PATH,
  pendingInvitationToken,
} from '../invitations/invitationToken.js';

export interface LocaleProps {
  readonly locale: Locale;
  readonly onLocaleChange: (locale: Locale) => void;
}

export function LanguageSwitcher({ locale, onLocaleChange }: LocaleProps) {
  const labelId = useId();
  return (
    <nav aria-labelledby={labelId} className="languages">
      <span id={labelId}>
        <FormattedMessage id="language.label" />
      </span>
      {SUPPORTED_LOCALES.map((option) => (
        <Button
          key={option}
          variant="secondary"
          lang={option}
          aria-pressed={option === locale}
          onClick={() => onLocaleChange(option)}
        >
          <FormattedMessage id={`language.name.${option}`} />
        </Button>
      ))}
    </nav>
  );
}

/** The public pages' frame: the product name, its tagline, the language choice. */
export function PublicFrame({
  children,
  ...locale
}: LocaleProps & { readonly children: ReactNode }) {
  const brand = useBrand();
  return (
    <main className="public">
      <header className="public__header">
        <h1>{brand?.productName ?? <FormattedMessage id="app.name" />}</h1>
        <p className="public__tagline">
          <FormattedMessage id="app.tagline" />
        </p>
      </header>
      <section className="public__card">{children}</section>
      <LanguageSwitcher {...locale} />
    </main>
  );
}

export function Loading() {
  return (
    <p role="status" className="notice">
      <FormattedMessage id="auth.loading" />
    </p>
  );
}

/** Replaces the current page with another, once rendered. */
export function Redirect({ to }: { readonly to: string }) {
  useEffect(() => navigate(to, { replace: true }), [to]);
  return null;
}

export const SIGN_IN_ERRORS: Record<IdentityErrorCode, string> = {
  invalid_credentials: 'auth.error.invalid_credentials',
  user_disabled: 'auth.error.user_disabled',
  too_many_attempts: 'auth.error.too_many_attempts',
  session_expired: 'auth.error.unavailable',
  network: 'auth.error.network',
  unavailable: 'auth.error.unavailable',
  email_exists: 'auth.error.email_exists',
  weak_password: 'auth.error.weak_password',
};

/**
 * Email and password sign-in with Identity Platform. The password goes from this form to Google
 * and is dropped from memory after the attempt; MelonOffice never stores it.
 */
export function LoginPage(locale: LocaleProps) {
  const { state, signIn } = useAuth();
  const intl = useIntl();
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IdentityErrorCode | undefined>();

  // Someone following an invitation link goes back to it once signed in (ADR-0089, ADR-0093).
  if (state.status === 'signed_in') {
    const back =
      pendingInvitationToken(undefined, JOIN) !== undefined
        ? JOIN_PATH
        : pendingInvitationToken() !== undefined
          ? INVITE_PATH
          : '/';
    return <Redirect to={back} />;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const result = await signIn(email.trim(), password);
    setPassword('');
    setBusy(false);
    if (!result.ok) setError(result.code);
  }

  return (
    <PublicFrame {...locale}>
      <h2>
        <FormattedMessage id="auth.signIn.title" />
      </h2>
      {state.status === 'signed_out' && state.expired && error === undefined && (
        <p role="status" className="notice notice--warning">
          <FormattedMessage id="auth.expired" />
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className="notice notice--danger">
          {intl.formatMessage({ id: SIGN_IN_ERRORS[error] })}
        </p>
      )}
      <form className="login" onSubmit={(event) => void submit(event)} noValidate>
        <label htmlFor={`${id}-email`}>
          <FormattedMessage id="auth.email" />
        </label>
        <input
          id={`${id}-email`}
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <label htmlFor={`${id}-password`}>
          <FormattedMessage id="auth.password" />
        </label>
        <input
          id={`${id}-password`}
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" disabled={busy || email.trim() === '' || password === ''}>
          <FormattedMessage id={busy ? 'auth.signIn.busy' : 'auth.signIn.submit'} />
        </Button>
      </form>
    </PublicFrame>
  );
}

/** Shown when this site has no sign-in configuration yet (no API or identity key). */
export function NotConfigured(locale: LocaleProps) {
  return (
    <PublicFrame {...locale}>
      <p className="notice">
        <FormattedMessage id="auth.notConfigured" />
      </p>
    </PublicFrame>
  );
}

export function AccessDenied() {
  return (
    <section className="notice notice--danger" role="alert">
      <h2>
        <FormattedMessage id="auth.denied.title" />
      </h2>
      <p>
        <FormattedMessage id="auth.denied.body" />
      </p>
    </section>
  );
}

/**
 * The gate to every signed-in page: waits for the session, sends anyone without one to sign-in,
 * and shows the page only to a signed-in member of an organization.
 */
export function ProtectedRoute({
  children,
  ...locale
}: LocaleProps & { readonly children: ReactNode }) {
  const { state, retry, signOut } = useAuth();
  switch (state.status) {
    case 'loading':
      return (
        <PublicFrame {...locale}>
          <Loading />
        </PublicFrame>
      );
    case 'signed_out':
      return <Redirect to="/login" />;
    case 'denied':
      return (
        <PublicFrame {...locale}>
          <AccessDenied />
          <Button variant="secondary" onClick={signOut}>
            <FormattedMessage id="auth.signOut" />
          </Button>
        </PublicFrame>
      );
    case 'unavailable':
      return (
        <PublicFrame {...locale}>
          <p role="alert" className="notice notice--danger">
            <FormattedMessage id="auth.unavailable" />
          </p>
          <Button onClick={retry}>
            <FormattedMessage id="auth.retry" />
          </Button>
        </PublicFrame>
      );
    case 'signed_in':
      if (state.workspace === undefined) {
        return (
          <PublicFrame {...locale}>
            <CreateOrganization />
            <Button variant="secondary" onClick={signOut}>
              <FormattedMessage id="auth.signOut" />
            </Button>
          </PublicFrame>
        );
      }
      return <>{children}</>;
  }
}

const CREATE_ERRORS = new Set(['invalid_organization_name', 'organization_limit_reached']);

/**
 * A new user's first step: name their organization. The API creates it with them as owner and
 * decides everything else (plan, departments, credits); this form sends only the name.
 */
export function CreateOrganization() {
  const { createOrganization } = useAuth();
  const id = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const result = await createOrganization(name.trim());
    setBusy(false);
    if (!result.ok) setError(CREATE_ERRORS.has(result.code) ? result.code : 'generic');
  }

  return (
    <>
      <h2>
        <FormattedMessage id="organization.create.title" />
      </h2>
      <p className="notice">
        <FormattedMessage id="auth.noOrganization" />
      </p>
      {error === undefined ? null : (
        <p role="alert" className="notice notice--danger">
          <FormattedMessage id={`organization.create.error.${error}`} />
        </p>
      )}
      <form className="login" onSubmit={(event) => void submit(event)} noValidate>
        <label htmlFor={`${id}-name`}>
          <FormattedMessage id="organization.create.name" />
        </label>
        <input
          id={`${id}-name`}
          type="text"
          autoComplete="organization"
          maxLength={100}
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" disabled={busy || name.trim() === ''}>
          <FormattedMessage id={busy ? 'organization.create.busy' : 'organization.create.submit'} />
        </Button>
      </form>
    </>
  );
}
