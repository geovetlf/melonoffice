import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import {
  PartnersRequestError,
  type CustomerScope,
  type PartnersClient,
  type Relationship,
} from './partnersClient.js';

/**
 * Partners and agencies (ADR-0088): the owner sees who asked to reach the organization and who
 * may, and decides. Nothing is granted by default: a request is accepted with the scopes the owner
 * ticks, never more than were asked for; scopes can only be narrowed; ending closes all access.
 */

type Load = readonly Relationship[] | 'loading' | 'error';

/** Scopes that open the company's own content: shown with a warning. */
const SENSITIVE = new Set<CustomerScope>(['knowledge', 'conversations', 'support']);

export function PartnersPage({
  client,
  canManage,
}: {
  readonly client: PartnersClient;
  readonly canManage: boolean;
}) {
  const [load, setLoad] = useState<Load>('loading');

  useEffect(() => {
    let live = true;
    client.list().then(
      (list) => live && setLoad(list),
      () => live && setLoad('error'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  const replace = (next: Relationship) =>
    setLoad((current) =>
      Array.isArray(current)
        ? current.map((r) => (r.commercialAccountId === next.commercialAccountId ? next : r))
        : current,
    );

  const open = Array.isArray(load) ? load.filter((r) => r.status !== 'ended') : [];
  const ended = Array.isArray(load) ? load.filter((r) => r.status === 'ended') : [];

  return (
    <article className="dept-office partners-page">
      <h1 className="dept-office__title">
        <FormattedMessage id="partners.title" />
      </h1>
      <p className="documents__lead">
        <FormattedMessage id="partners.lead" />
      </p>
      {load === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="partners.loading" />
        </p>
      ) : load === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="partners.error" />
        </p>
      ) : open.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="partners.none" />
        </p>
      ) : (
        <ul className="documents__list">
          {open.map((r) => (
            <RelationshipCard
              key={r.commercialAccountId}
              relationship={r}
              client={client}
              canManage={canManage}
              onChange={replace}
            />
          ))}
        </ul>
      )}
      {ended.length > 0 ? (
        <section className="dept-office__section" aria-labelledby="partners-ended">
          <h2 id="partners-ended">
            <FormattedMessage id="partners.ended" />
          </h2>
          <ul className="documents__list">
            {ended.map((r) => (
              <li key={r.commercialAccountId} className="documents__item">
                <span className="documents__name">{nameOf(r)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

const nameOf = (r: Relationship) => r.account?.name ?? r.commercialAccountId;

function RelationshipCard({
  relationship: r,
  client,
  canManage,
  onChange,
}: {
  readonly relationship: Relationship;
  readonly client: PartnersClient;
  readonly canManage: boolean;
  readonly onChange: (next: Relationship) => void;
}) {
  const intl = useIntl();
  const pending = r.status === 'pending';
  // Pending: nothing ticked until the owner ticks it. Active: what is granted now.
  const [chosen, setChosen] = useState<ReadonlySet<CustomerScope>>(
    () => new Set(pending ? [] : r.scopes),
  );
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string>();

  const act = async (work: () => Promise<Relationship>) => {
    setBusy(true);
    setFailed(undefined);
    try {
      const next = await work();
      setChosen(new Set(next.status === 'pending' ? [] : next.scopes));
      onChange(next);
    } catch (error) {
      setFailed(
        error instanceof PartnersRequestError && error.code === 'commercial_conflict'
          ? 'partners.conflict'
          : 'partners.failed',
      );
    } finally {
      setBusy(false);
    }
  };
  const selected = r.scopes.filter((s) => chosen.has(s));
  const unchanged = !pending && selected.length === r.scopes.length;
  const titleId = `partner-${r.commercialAccountId}`;

  return (
    <li className="documents__item partners__item" aria-labelledby={titleId}>
      <div className="documents__main">
        <span id={titleId} className="documents__name">
          {nameOf(r)}
        </span>
        <span className="documents__meta">
          {r.account === null ? null : <FormattedMessage id={`partners.type.${r.account.type}`} />}{' '}
          · <FormattedMessage id={`partners.mode.${r.mode}`} /> ·{' '}
          <FormattedMessage id={`partners.status.${r.status}`} />
        </span>
      </div>
      <fieldset className="partners__scopes" disabled={!canManage || busy}>
        <legend>
          <FormattedMessage id={pending ? 'partners.asks' : 'partners.grants'} />
        </legend>
        {r.scopes.length === 0 ? (
          <p className="documents__meta">
            <FormattedMessage id="partners.noScopes" />
          </p>
        ) : (
          r.scopes.map((scope) => (
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
      {canManage ? (
        <div className="partners__actions">
          {pending ? (
            <Button disabled={busy} onClick={() => void act(() => client.accept(r, selected))}>
              <FormattedMessage id="partners.accept" />
            </Button>
          ) : r.scopes.length > 0 ? (
            <Button
              disabled={busy || unchanged}
              onClick={() => void act(() => client.setScopes(r, selected))}
            >
              <FormattedMessage id="partners.save" />
            </Button>
          ) : null}
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (
                globalThis.confirm(
                  intl.formatMessage(
                    { id: pending ? 'partners.rejectConfirm' : 'partners.endConfirm' },
                    { name: nameOf(r) },
                  ),
                )
              ) {
                void act(() => client.end(r));
              }
            }}
          >
            <FormattedMessage id={pending ? 'partners.reject' : 'partners.end'} />
          </Button>
        </div>
      ) : null}
      {failed === undefined ? null : (
        <p className="panel__empty" role="alert">
          <FormattedMessage id={failed} />
        </p>
      )}
    </li>
  );
}
