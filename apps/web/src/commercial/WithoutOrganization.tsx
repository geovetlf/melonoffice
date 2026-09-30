import { FormattedMessage } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../identity/AuthProvider.js';
import { CreateOrganization, Loading, PublicFrame, type LocaleProps } from '../identity/pages.js';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import { createConsoleClient, type ConsoleClient } from './consoleClient.js';
import { PartnerConsole } from './PartnerConsole.js';

/**
 * A signed-in person who belongs to no organization (ADR-0094). A member of a partner or agency
 * account works in its console without a company of their own; anyone else creates one. Whether
 * they are a member is the API's answer, never guessed here.
 */
export function WithoutOrganization({
  partnerConsole,
  client,
  ...locale
}: LocaleProps & { readonly partnerConsole: boolean; readonly client?: ConsoleClient }) {
  const auth = useAuth();
  const services = auth.services;
  const consoleClient = useMemo(
    () => client ?? createConsoleClient(services.api.request),
    [client, services],
  );
  const [accounts, setAccounts] = useState<number | 'loading'>('loading');

  useEffect(() => {
    let live = true;
    consoleClient.accounts().then(
      (found) => live && setAccounts(found.length),
      () => live && setAccounts(0),
    );
    return () => {
      live = false;
    };
  }, [consoleClient]);

  const signOut = (
    <Button variant="secondary" onClick={() => auth.signOut()}>
      <FormattedMessage id="auth.signOut" />
    </Button>
  );

  if (accounts === 'loading') {
    return (
      <PublicFrame {...locale}>
        <Loading />
      </PublicFrame>
    );
  }
  if (partnerConsole && accounts > 0) {
    return (
      <main className="public public--wide">
        <div className="light-surface">
          <PartnerConsole client={consoleClient} origin={globalThis.location.origin} />
        </div>
        <div className="partners__actions">
          <Button variant="secondary" onClick={() => navigate('/')}>
            <FormattedMessage id="console.noCompany.create" />
          </Button>
          {signOut}
        </div>
      </main>
    );
  }
  return (
    <PublicFrame {...locale}>
      {accounts > 0 ? (
        <p className="notice" role="status">
          <FormattedMessage id="console.noCompany.lead" />{' '}
          <Button onClick={() => navigate(paths.partnerConsole())}>
            <FormattedMessage id="console.noCompany.open" />
          </Button>
        </p>
      ) : null}
      <CreateOrganization />
      {signOut}
    </PublicFrame>
  );
}
