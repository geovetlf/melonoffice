import { FormattedMessage, SUPPORTED_LOCALES, useIntl, type Locale } from '@melonoffice/i18n';
import { Button, PageHeader, StateMessage } from '@melonoffice/ui';
import { useBrand } from '../brand/brand.js';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
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
      <span className="mo-segmented">
        {SUPPORTED_LOCALES.map((option) => (
          <button
            key={option}
            type="button"
            lang={option}
            aria-pressed={option === locale}
            onClick={() => onLocaleChange(option)}
          >
            <FormattedMessage id={`language.name.${option}`} />
          </button>
        ))}
      </span>
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
      <PageHeader
        className="public__header"
        title={brand?.productName ?? <FormattedMessage id="app.name" />}
        description={<FormattedMessage id="app.tagline" />}
      />
      <section className="public__card">{children}</section>
      <LanguageSwitcher {...locale} />
    </main>
  );
}

export function Loading() {
  return (
    <StateMessage kind="loading">
      <FormattedMessage id="auth.loading" />
    </StateMessage>
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
  provider_disabled: 'auth.error.provider_disabled',
  provider_cancelled: 'auth.error.provider_cancelled',
  account_exists: 'auth.error.account_exists',
};

export const SIGN_UP_PATH = '/signup';
export const FORGOT_PASSWORD_PATH = '/forgot-password';

/** Whether this URL is Google sending the browser back after a sign-in (ADR-0105). */
function isProviderReturn(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.has('state') || params.has('code') || params.has('error');
}

/** Where a person who just signed in goes: back to the invitation they followed, or home. */
function homeAfterSignIn(): string {
  // Someone following an invitation link goes back to it once signed in (ADR-0089, ADR-0093).
  if (pendingInvitationToken(undefined, JOIN) !== undefined) return JOIN_PATH;
  if (pendingInvitationToken() !== undefined) return INVITE_PATH;
  return '/';
}

/** A link to another page of the app, without reloading it. */
function AppLink({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return (
    <a
      className="mo-link"
      href={to}
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

/** Google's "G", as its sign-in button guidelines show it. */
function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

/** The "or" line and "Continue with Google" (ADR-0105), under the email and password form. */
function ContinueWithGoogle({
  busy,
  onError,
  onStart,
}: {
  readonly busy: boolean;
  readonly onError: (code: IdentityErrorCode) => void;
  readonly onStart: () => void;
}) {
  const { signInWithGoogle } = useAuth();
  const [leaving, setLeaving] = useState(false);

  async function google() {
    if (busy || leaving) return;
    setLeaving(true);
    onStart();
    const result = await signInWithGoogle();
    // On success the browser is leaving for Google; the button stays busy until it does.
    if (!result.ok) {
      setLeaving(false);
      onError(result.code);
    }
  }

  return (
    <>
      <p className="auth-or">
        <span>
          <FormattedMessage id="auth.signIn.or" />
        </span>
      </p>
      <Button
        variant="secondary"
        className="auth-google"
        disabled={busy || leaving}
        onClick={() => void google()}
      >
        <GoogleMark />
        <FormattedMessage id="auth.signIn.google" />
      </Button>
    </>
  );
}

function ErrorNotice({ error }: { readonly error: IdentityErrorCode | undefined }) {
  const intl = useIntl();
  if (error === undefined) return null;
  return (
    <StateMessage kind="error">{intl.formatMessage({ id: SIGN_IN_ERRORS[error] })}</StateMessage>
  );
}

/**
 * Sign-in: email and password, or Google (ADR-0036, ADR-0105). The password goes from this form
 * to Google and is dropped from memory after the attempt; MelonOffice never stores it.
 */
export function LoginPage(locale: LocaleProps) {
  const { state, signIn, finishGoogleSignIn, services } = useAuth();
  const intl = useIntl();
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IdentityErrorCode | undefined>();
  // Coming back from Google: finish that sign-in once, then drop Google's answer from the URL.
  const [finishing, setFinishing] = useState(
    () => services.session.providerPending && isProviderReturn(globalThis.location.search),
  );
  const finishStarted = useRef(false);
  useEffect(() => {
    if (!finishing || finishStarted.current) return;
    finishStarted.current = true;
    const requestUri = globalThis.location.href;
    globalThis.history.replaceState(null, '', globalThis.location.pathname);
    void finishGoogleSignIn(requestUri).then((result) => {
      setFinishing(false);
      if (!result.ok) setError(result.code);
    });
  }, [finishing, finishGoogleSignIn]);

  if (state.status === 'signed_in') return <Redirect to={homeAfterSignIn()} />;

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

  if (finishing) return <Loading />;

  return (
    <PublicFrame {...locale}>
      <h2 className="visually-hidden">
        <FormattedMessage id="auth.signIn.title" />
      </h2>
      {state.status === 'signed_out' && state.expired && error === undefined && (
        <StateMessage kind="warning">
          <FormattedMessage id="auth.expired" />
        </StateMessage>
      )}
      <ErrorNotice error={error} />
      <form className="mo-form login" onSubmit={(event) => void submit(event)} noValidate>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-email`}>
            <FormattedMessage id="auth.email" />
          </label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="username"
            inputMode="email"
            placeholder={intl.formatMessage({ id: 'auth.email.placeholder' })}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-password`}>
            <FormattedMessage id="auth.password" />
          </label>
          <input
            id={`${id}-password`}
            type="password"
            autoComplete="current-password"
            placeholder="••••••••••"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p className="mo-hint login__forgot">
            <AppLink to={FORGOT_PASSWORD_PATH}>
              <FormattedMessage id="auth.forgot.link" />
            </AppLink>
          </p>
        </div>
        <div className="mo-form__actions">
          <Button type="submit" disabled={busy || email.trim() === '' || password === ''}>
            <FormattedMessage id={busy ? 'auth.signIn.busy' : 'auth.signIn.submit'} />
          </Button>
        </div>
      </form>
      <ContinueWithGoogle busy={busy} onStart={() => setError(undefined)} onError={setError} />
      <p className="auth-switch">
        <FormattedMessage id="auth.signUp.prompt" />{' '}
        <AppLink to={SIGN_UP_PATH}>
          <FormattedMessage id="auth.signUp.link" />
        </AppLink>
      </p>
    </PublicFrame>
  );
}

/**
 * A new account with an email and a password the person chooses (ADR-0105), or Google. Once
 * created it is signed in and goes on like any sign-in: a person with no organization creates one.
 */
export function SignUpPage(locale: LocaleProps) {
  const { state, signUp } = useAuth();
  const intl = useIntl();
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IdentityErrorCode | undefined>();
  const [mismatch, setMismatch] = useState(false);

  if (state.status === 'signed_in') return <Redirect to={homeAfterSignIn()} />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError(undefined);
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setBusy(true);
    const result = await signUp(email.trim(), password);
    setPassword('');
    setConfirm('');
    setBusy(false);
    if (!result.ok) setError(result.code);
  }

  return (
    <PublicFrame {...locale}>
      <h2 className="mo-section-title">
        <FormattedMessage id="auth.signUp.title" />
      </h2>
      <ErrorNotice error={error} />
      {mismatch && (
        <StateMessage kind="error">
          <FormattedMessage id="auth.signUp.mismatch" />
        </StateMessage>
      )}
      <form className="mo-form login" onSubmit={(event) => void submit(event)} noValidate>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-email`}>
            <FormattedMessage id="auth.email" />
          </label>
          <input
            id={`${id}-email`}
            type="email"
            autoComplete="username"
            inputMode="email"
            placeholder={intl.formatMessage({ id: 'auth.email.placeholder' })}
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-password`}>
            <FormattedMessage id="auth.signUp.password" />
          </label>
          <input
            id={`${id}-password`}
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            aria-describedby={`${id}-hint`}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <p id={`${id}-hint`} className="mo-hint">
            <FormattedMessage id="auth.signUp.hint" />
          </p>
        </div>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-confirm`}>
            <FormattedMessage id="auth.signUp.confirm" />
          </label>
          <input
            id={`${id}-confirm`}
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        <div className="mo-form__actions">
          <Button
            type="submit"
            disabled={busy || email.trim() === '' || password === '' || confirm === ''}
          >
            <FormattedMessage id={busy ? 'auth.signUp.busy' : 'auth.signUp.submit'} />
          </Button>
        </div>
      </form>
      <ContinueWithGoogle busy={busy} onStart={() => setError(undefined)} onError={setError} />
      <p className="auth-switch">
        <FormattedMessage id="auth.signIn.prompt" />{' '}
        <AppLink to="/login">
          <FormattedMessage id="auth.signIn.link" />
        </AppLink>
      </p>
    </PublicFrame>
  );
}

/**
 * "Forgot your password?": Identity Platform emails a link to choose a new one. The page says
 * the same whether or not the address has an account.
 */
export function ForgotPasswordPage(locale: LocaleProps) {
  const { sendPasswordReset } = useAuth();
  const intl = useIntl();
  const id = useId();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string>();
  const [error, setError] = useState<IdentityErrorCode | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const address = email.trim();
    if (busy || !address.includes('@')) return;
    setBusy(true);
    setError(undefined);
    const result = await sendPasswordReset(address);
    setBusy(false);
    if (result.ok) setSentTo(address);
    else setError(result.code);
  }

  return (
    <PublicFrame {...locale}>
      <h2 className="mo-section-title">
        <FormattedMessage id="auth.forgot.title" />
      </h2>
      {sentTo === undefined ? (
        <>
          <p className="mo-hint">
            <FormattedMessage id="auth.forgot.body" />
          </p>
          <ErrorNotice error={error} />
          <form className="mo-form login" onSubmit={(event) => void submit(event)} noValidate>
            <div className="mo-field">
              <label className="mo-label" htmlFor={`${id}-email`}>
                <FormattedMessage id="auth.email" />
              </label>
              <input
                id={`${id}-email`}
                type="email"
                autoComplete="username"
                inputMode="email"
                placeholder={intl.formatMessage({ id: 'auth.email.placeholder' })}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="mo-form__actions">
              <Button type="submit" disabled={busy || !email.trim().includes('@')}>
                <FormattedMessage id={busy ? 'auth.forgot.busy' : 'auth.forgot.submit'} />
              </Button>
            </div>
          </form>
        </>
      ) : (
        <StateMessage kind="success">
          <FormattedMessage id="auth.forgot.sent" values={{ email: sentTo }} />
        </StateMessage>
      )}
      <p className="auth-switch">
        <AppLink to="/login">
          <FormattedMessage id="auth.forgot.back" />
        </AppLink>
      </p>
    </PublicFrame>
  );
}

/** Shown when this site has no sign-in configuration yet (no API or identity key). */
export function NotConfigured(locale: LocaleProps) {
  return (
    <PublicFrame {...locale}>
      <p className="mo-hint">
        <FormattedMessage id="auth.notConfigured" />
      </p>
    </PublicFrame>
  );
}

export function AccessDenied() {
  return (
    // A StateMessage's error, drawn by hand so its title stays the section's heading.
    <section className="mo-state mo-state--error" role="alert">
      <span className="mo-state__icon" aria-hidden="true">
        !
      </span>
      <div className="mo-state__body">
        <h2 className="mo-state__title">
          <FormattedMessage id="auth.denied.title" />
        </h2>
        <p className="mo-state__text">
          <FormattedMessage id="auth.denied.body" />
        </p>
      </div>
    </section>
  );
}

/**
 * The gate to every signed-in page: waits for the session, sends anyone without one to sign-in,
 * and shows the page only to a signed-in member of an organization; a person with none creates
 * one, unless the caller shows them something else.
 */
export function ProtectedRoute({
  children,
  withoutOrganization,
  ...locale
}: LocaleProps & {
  readonly children: ReactNode;
  /** What a signed-in person with no organization sees instead of creating one (ADR-0094). */
  readonly withoutOrganization?: ReactNode;
}) {
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
          <StateMessage kind="error">
            <FormattedMessage id="auth.unavailable" />
          </StateMessage>
          <Button onClick={retry}>
            <FormattedMessage id="auth.retry" />
          </Button>
        </PublicFrame>
      );
    case 'signed_in':
      if (state.workspace === undefined) {
        if (withoutOrganization !== undefined) return <>{withoutOrganization}</>;
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
      <h2 className="mo-section-title">
        <FormattedMessage id="organization.create.title" />
      </h2>
      <p className="mo-hint">
        <FormattedMessage id="auth.noOrganization" />
      </p>
      {error === undefined ? null : (
        <StateMessage kind="error">
          <FormattedMessage id={`organization.create.error.${error}`} />
        </StateMessage>
      )}
      <form className="mo-form login" onSubmit={(event) => void submit(event)} noValidate>
        <div className="mo-field">
          <label className="mo-label" htmlFor={`${id}-name`}>
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
        </div>
        <div className="mo-form__actions">
          <Button type="submit" disabled={busy || name.trim() === ''}>
            <FormattedMessage
              id={busy ? 'organization.create.busy' : 'organization.create.submit'}
            />
          </Button>
        </div>
      </form>
    </>
  );
}
