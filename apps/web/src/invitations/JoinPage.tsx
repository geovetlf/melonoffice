import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../identity/AuthProvider.js';
import { Loading, PublicFrame, type LocaleProps } from '../identity/pages.js';
import { navigate } from '../identity/router.js';
import { CreateAccount, VerifyEmail } from './InvitePage.js';
import { captureInvitationToken, clearInvitationToken, JOIN } from './invitationToken.js';
import { InvitationRequestError } from './invitationsClient.js';
import { createJoinClient, type JoinClient, type JoinLookup } from './joinClient.js';

/**
 * Where a link to join a partner or agency account lands (ADR-0093). The person signs in or
 * creates their account and verifies their email; no company of their own is needed. Then they
 * see which account and which role, and join or decline. Every check is the API's.
 */
export function JoinPage(locale: LocaleProps) {
  const auth = useAuth();
  const [token] = useState(() => captureInvitationToken(undefined, JOIN));
  const client = useMemo(
    () => createJoinClient((path, init) => auth.services.api.request(path, init)),
    [auth.services],
  );
  const { state } = auth;

  let content;
  if (token === undefined) {
    content = (
      <p className="mo-hint">
        <FormattedMessage id="invite.missing" />
      </p>
    );
  } else if (state.status === 'loading') {
    content = <Loading />;
  } else if (state.status === 'signed_out') {
    content = <CreateAccount />;
  } else if (state.status !== 'signed_in') {
    content = (
      <StateMessage kind="error">
        <FormattedMessage id="auth.unavailable" />
      </StateMessage>
    );
  } else if (!state.me.emailVerified) {
    content = <VerifyEmail email={state.me.email} />;
  } else {
    content = <JoinDecision client={client} token={token} onSignOut={() => auth.signOut()} />;
  }
  return (
    <PublicFrame {...locale}>
      <h2 className="mo-section-title">
        <FormattedMessage id="join.title" />
      </h2>
      {content}
    </PublicFrame>
  );
}

/** The API's refusals this page explains; any other is a generic error. */
const REFUSALS = new Set([
  'already_member',
  'commercial_limit_reached',
  'commercial_account_inactive',
  'invitation_not_pending',
  'commercial_conflict',
]);

type Load = JoinLookup | 'loading' | 'missing' | 'error';

export function JoinDecision({
  client,
  token,
  onSignOut,
}: {
  readonly client: JoinClient;
  readonly token: string;
  readonly onSignOut: () => void;
}) {
  const intl = useIntl();
  const [load, setLoad] = useState<Load>('loading');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();
  const [outcome, setOutcome] = useState<'joined' | 'rejected'>();

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
        <StateMessage kind="success">
          <FormattedMessage id={`join.outcome.${outcome}`} />
        </StateMessage>
        <Button onClick={() => navigate(outcome === 'joined' ? '/partner' : '/')}>
          <FormattedMessage id="invite.continue" />
        </Button>
      </>
    );
  }
  if (load === 'loading') return <Loading />;
  if (load === 'missing' || load === 'error') {
    return (
      <StateMessage kind="error">
        <FormattedMessage id={load === 'missing' ? 'invite.missing' : 'invite.error'} />
      </StateMessage>
    );
  }
  const { invitation, person } = load;
  if (person !== 'invited') {
    return (
      <>
        <StateMessage kind="error">
          <FormattedMessage id={`invite.person.${person}`} />
        </StateMessage>
        <Button variant="secondary" onClick={onSignOut}>
          <FormattedMessage id="auth.signOut" />
        </Button>
      </>
    );
  }
  if (invitation.status !== 'pending') {
    return (
      <StateMessage kind="error">
        <FormattedMessage id={`invite.status.${invitation.status}`} />
      </StateMessage>
    );
  }

  const act = async (work: () => Promise<'joined' | 'rejected'>) => {
    setBusy(true);
    setFailed(undefined);
    try {
      const done = await work();
      clearInvitationToken(undefined, JOIN);
      setOutcome(done);
    } catch (error) {
      setFailed(
        error instanceof InvitationRequestError &&
          error.code !== undefined &&
          REFUSALS.has(error.code)
          ? `join.refused.${error.code}`
          : 'invite.error',
      );
    } finally {
      setBusy(false);
    }
  };
  const name = invitation.account?.name ?? '';

  return (
    <>
      <p>
        <FormattedMessage
          id="join.offer"
          values={{
            name,
            kind: invitation.account
              ? intl.formatMessage({ id: `partners.type.${invitation.account.type}` })
              : '',
            role: intl.formatMessage({ id: `console.role.${invitation.role}` }),
          }}
        />
      </p>
      <div className="mo-form__actions">
        <Button
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await client.accept(token, invitation.updatedAt);
              return 'joined';
            })
          }
        >
          <FormattedMessage id="join.accept" />
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (globalThis.confirm(intl.formatMessage({ id: 'join.rejectConfirm' }, { name }))) {
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
        <StateMessage kind="error">
          <FormattedMessage id={failed} />
        </StateMessage>
      )}
    </>
  );
}
