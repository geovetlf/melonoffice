import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, Button, ListItem, PageHeader, StateMessage } from '@melonoffice/ui';
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
    <article className="mo-page partners-page">
      <PageHeader
        title={<FormattedMessage id="partners.title" />}
        description={<FormattedMessage id="partners.lead" />}
      />
      {load === 'loading' ? (
        <StateMessage kind="loading">
          <FormattedMessage id="partners.loading" />
        </StateMessage>
      ) : load === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="partners.error" />
        </StateMessage>
      ) : open.length === 0 ? (
        <StateMessage kind="empty">
          <FormattedMessage id="partners.none" />
        </StateMessage>
      ) : (
        <ul className="mo-list">
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
        <section className="mo-panel mo-page-section" aria-labelledby="partners-ended">
          <h2 id="partners-ended" className="mo-section-title">
            <FormattedMessage id="partners.ended" />
          </h2>
          <ul className="mo-list">
            {ended.map((r) => (
              <ListItem key={r.commercialAccountId} title={nameOf(r)} titleAs="span" />
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
    <li className="mo-list-item partners__item" aria-labelledby={titleId}>
      <div className="mo-list-item__main">
        <span id={titleId} className="mo-list-item__title">
          {nameOf(r)}
        </span>
        <span className="mo-list-item__meta">
          {r.account === null ? null : <FormattedMessage id={`partners.type.${r.account.type}`} />}{' '}
          · <FormattedMessage id={`partners.mode.${r.mode}`} /> ·{' '}
          <FormattedMessage id={`partners.status.${r.status}`} />
        </span>
        <fieldset className="partners__scopes" disabled={!canManage || busy}>
          <legend>
            <FormattedMessage id={pending ? 'partners.asks' : 'partners.grants'} />
          </legend>
          {r.scopes.length === 0 ? (
            <p className="mo-hint">
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
                  <>
                    {' '}
                    <Badge tone="warning">
                      <FormattedMessage id="partners.sensitive" />
                    </Badge>
                  </>
                ) : null}
              </label>
            ))
          )}
        </fieldset>
        {canManage ? (
          <div className="mo-list-item__actions">
            {pending ? (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => void act(() => client.accept(r, selected))}
              >
                <FormattedMessage id="partners.accept" />
              </Button>
            ) : r.scopes.length > 0 ? (
              <Button
                size="sm"
                disabled={busy || unchanged}
                onClick={() => void act(() => client.setScopes(r, selected))}
              >
                <FormattedMessage id="partners.save" />
              </Button>
            ) : null}
            <Button
              variant="danger"
              size="sm"
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
          <StateMessage kind="error" inline>
            <FormattedMessage id={failed} />
          </StateMessage>
        )}
      </div>
    </li>
  );
}
