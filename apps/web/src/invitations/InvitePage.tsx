import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '../identity/AuthProvider.js';
import type { IdentityErrorCode } from '../identity/identityPlatform.js';
import {
  CreateOrganization,
  Loading,
  PublicFrame,
  SIGN_IN_ERRORS,
  type LocaleProps,
} from '../identity/pages.js';
import { navigate } from '../identity/router.js';
import type { CustomerScope } from '../partners/partnersClient.js';
import { captureInvitationToken, clearInvitationToken } from './invitationToken.js';
import {
  createInvitationsClient,
  InvitationRequestError,
  type InvitationLookup,
  type InvitationsClient,
} from './invitationsClient.js';

/**
 * Where an invitation link lands (ADR-0089). The person signs in or creates their account,
 * verifies their email, creates their company if they have none, and then decides. Every check
 * is the API's: this page only walks the person to the point where the API can answer.
 */
export function InvitePage(locale: LocaleProps) {
  const auth = useAuth();
  const [token] = useState(() => captureInvitationToken());
  const client = useMemo(
    () => createInvitationsClient((path, init) => auth.services.api.request(path, init)),
    [auth.services],
  );
  const { state } = auth;

  let content;
  if (token === undefined) {
    content = (
      <p className="notice">
        <FormattedMessage id="invite.missing" />
      </p>
    );
  } else if (state.status === 'loading') {
    content = <Loading />;
  } else if (state.status === 'signed_out') {
    content = <CreateAccount />;
  } else if (state.status !== 'signed_in') {
    content = (
      <p role="alert" className="notice notice--danger">
        <FormattedMessage id="auth.unavailable" />
      </p>
    );
  } else if (!state.me.emailVerified) {
    content = <VerifyEmail email={state.me.email} />;
  } else if (state.workspace === undefined) {
    content = (
      <>
        <p className="notice">
          <FormattedMessage id="invite.createCompany" />
        </p>
        <CreateOrganization />
      </>
    );
  } else {
    content = <InvitationDecision client={client} token={token} onSignOut={() => auth.signOut()} />;
  }
  return (
    <PublicFrame {...locale}>
      <h2>
        <FormattedMessage id="invite.title" />
      </h2>
      {content}
    </PublicFrame>
  );
}

/** A new account for the invited person, or a way to sign in with the one they have. */
export function CreateAccount() {
  const { signUp } = useAuth();
  const intl = useIntl();
  const id = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<IdentityErrorCode>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(undefined);
    const result = await signUp(email.trim(), password);
    setPassword('');
    setBusy(false);
    if (!result.ok) setError(result.code);
  }

  return (
    <>
      <p>
        <FormattedMessage id="invite.signedOut" />
      </p>
      <Button variant="secondary" onClick={() => navigate('/login')}>
        <FormattedMessage id="invite.signIn" />
      </Button>
      <h3>
        <FormattedMessage id="invite.signUp.title" />
      </h3>
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
          autoComplete="new-password"
          required
          minLength={6}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" disabled={busy || email.trim() === '' || password === ''}>
          <FormattedMessage id={busy ? 'auth.signIn.busy' : 'invite.signUp.submit'} />
        </Button>
      </form>
    </>
  );
}

/** Identity Platform emails the link; once followed, a fresh token carries the verified email. */
export function VerifyEmail({ email }: { readonly email: string | null }) {
  const { sendVerification, refreshIdentity, signOut } = useAuth();
  const [sent, setSent] = useState<boolean>();
  return (
    <>
      <p className="notice">
        <FormattedMessage id="invite.verify" values={{ email: email ?? '' }} />
      </p>
      <Button onClick={() => void refreshIdentity()}>
        <FormattedMessage id="invite.verify.done" />
      </Button>
      <Button variant="secondary" onClick={() => void sendVerification().then(setSent)}>
        <FormattedMessage id="invite.verify.resend" />
      </Button>
      {sent === undefined ? null : (
        <p role="status" className="notice">
          <FormattedMessage id={sent ? 'invite.verify.sent' : 'invite.verify.failed'} />
        </p>
      )}
      <Button variant="secondary" onClick={signOut}>
        <FormattedMessage id="auth.signOut" />
      </Button>
    </>
  );
}

/** Scopes that open the company's own content: shown with a warning, as in Partners. */
const SENSITIVE = new Set<CustomerScope>(['knowledge', 'conversations', 'support']);

/** The API's refusals this page explains; any other is a generic error. */
const REFUSALS = new Set([
  'relationship_exists',
  'commercial_limit_reached',
  'invitation_not_pending',
  'commercial_conflict',
]);

type Load = InvitationLookup | 'loading' | 'missing' | 'error';

export function InvitationDecision({
  client,
  token,
  onSignOut,
}: {
  readonly client: InvitationsClient;
  readonly token: string;
  readonly onSignOut: () => void;
}) {
  const intl = useIntl();
  const [load, setLoad] = useState<Load>('loading');
  const [chosen, setChosen] = useState<ReadonlySet<CustomerScope>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [outcome, setOutcome] = useState<'active' | 'pending' | 'rejected'>();

  useEffect(() => {
    let live = true;
    client.lookup(token).then(
      (found) => live && setLoad(found),
      (error: unknown) =>
        live &&
        setLoad(
          error instanceof InvitationRequestError && error.status === 404 ? 'missing' : 'error',
        ),
    );
    return () => {
      live = false;
    };
  }, [client, token]);

  if (outcome !== undefined) {
    return (
      <>
        <p role="status" className="notice">
          <FormattedMessage id={`invite.outcome.${outcome}`} />
        </p>
        <Button onClick={() => navigate(outcome === 'active' ? '/settings/partners' : '/')}>
          <FormattedMessage id="invite.continue" />
        </Button>
      </>
    );
  }
  if (load === 'loading') return <Loading />;
  if (load === 'missing' || load === 'error') {
    return (
      <p role="alert" className="notice notice--danger">
        <FormattedMessage id={load === 'missing' ? 'invite.missing' : 'invite.error'} />
      </p>
    );
  }
  const { invitation, person, organization } = load;
  if (person !== 'invited') {
    return (
      <>
        <p role="alert" className="notice notice--danger">
          <FormattedMessage id={`invite.person.${person}`} />
        </p>
        <Button variant="secondary" onClick={onSignOut}>
          <FormattedMessage id="auth.signOut" />
        </Button>
      </>
    );
  }
  if (invitation.status !== 'pending') {
    return (
      <p role="alert" className="notice">
        <FormattedMessage id={`invite.status.${invitation.status}`} />
      </p>
    );
  }
  if (organization === null || organization === 'ambiguous') {
    return (
      <p role="alert" className="notice notice--danger">
        <FormattedMessage id="invite.noOrganization" />
      </p>
    );
  }

  const act = async (work: () => Promise<'active' | 'pending' | 'rejected'>) => {
    setBusy(true);
    setFailed(undefined);
    try {
      const done = await work();
      clearInvitationToken();
      setOutcome(done);
    } catch (error) {
      setFailed(
        error instanceof InvitationRequestError &&
          error.code !== undefined &&
          REFUSALS.has(error.code)
          ? `invite.refused.${error.code}`
          : 'invite.error',
      );
    } finally {
      setBusy(false);
    }
  };
  const selected = invitation.scopes.filter((s) => chosen.has(s));
  const name = invitation.account?.name ?? '';

  return (
    <>
      <p>
        <FormattedMessage
          id="invite.offer"
          values={{
            name,
            kind: invitation.account
              ? intl.formatMessage({ id: `partners.type.${invitation.account.type}` })
              : '',
            mode: intl.formatMessage({ id: `partners.mode.${invitation.mode}` }),
          }}
        />
      </p>
      {organization.canDecide ? (
        <fieldset className="partners__scopes" disabled={busy}>
          <legend>
            <FormattedMessage id="invite.choose" />
          </legend>
          {invitation.scopes.length === 0 ? (
            <p className="documents__meta">
              <FormattedMessage id="partners.noScopes" />
            </p>
          ) : (
            invitation.scopes.map((scope) => (
              <label key={scope} className="partners__scope">
                <input
                  type="checkbox"
                  checked={chosen.has(scope)}
                  onChange={(event) => {
                    const next = new Set(chosen);
                    if (event.target.checked) next.add(scope);
                    else next.delete(scope);
                    setChosen(next);
                  }}
                />{' '}
                <FormattedMessage id={`partners.scope.${scope}`} />
                {SENSITIVE.has(scope) ? (
                  <span className="documents__meta">
                    {' '}
                    <FormattedMessage id="partners.sensitive" />
                  </span>
                ) : null}
              </label>
            ))
          )}
        </fieldset>
      ) : (
        <p className="notice">
          <FormattedMessage id="invite.forOwner" />
        </p>
      )}
      <div className="partners__actions">
        <Button
          disabled={busy}
          onClick={() =>
            void act(
              async () => (await client.accept(token, selected, invitation.updatedAt)).status,
            )
          }
        >
          <FormattedMessage id={organization.canDecide ? 'invite.accept' : 'invite.forward'} />
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (globalThis.confirm(intl.formatMessage({ id: 'invite.rejectConfirm' }, { name }))) {
              void act(async () => {
                await client.reject(token, invitation.updatedAt);
                return 'rejected';
              });
            }
          }}
        >
          <FormattedMessage id="invite.reject" />
        </Button>
      </div>
      {failed === undefined ? null : (
        <p className="notice notice--danger" role="alert">
          <FormattedMessage id={failed} />
        </p>
      )}
    </>
  );
}
