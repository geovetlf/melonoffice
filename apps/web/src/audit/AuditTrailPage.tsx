import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, Button, PageHeader, StateMessage, Toolbar } from '@melonoffice/ui';
import { Fragment, useEffect, useState } from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import {
  AuditTrailRequestError,
  type AuditTrailClient,
  type AuditTrailItemView,
  type AuditTrailQuery,
} from './auditTrailClient.js';

/**
 * The audit history (ADR-0147): what was recorded in the organization, newest first, a page at a
 * time. Read only: nothing on this page changes or removes an event. Filters are sent as asked
 * and checked again by the API, which reads only the person's own organization.
 */

type IntlShape = ReturnType<typeof useIntl>;

const has = (intl: IntlShape, id: string) => intl.messages[id] !== undefined;

/** A code turned into words when no label exists: `version_created` → "version created". */
const words = (code: string) => code.replaceAll(/[_.]/g, ' ');

export function actionLabel(intl: IntlShape, action: string, category: string): string {
  for (const id of [`audit.action.${action}`, `activity.action.${action}`]) {
    if (has(intl, id)) return intl.formatMessage({ id });
  }
  const verb = action.slice(action.indexOf('.') + 1);
  return `${categoryLabel(intl, category)}: ${words(verb)}`;
}

export function categoryLabel(intl: IntlShape, category: string): string {
  const id = `audit.category.${category}`;
  return has(intl, id) ? intl.formatMessage({ id }) : words(category);
}

const codeLabel = (intl: IntlShape, prefix: string, code: string) => {
  const id = `${prefix}.${code}`;
  return has(intl, id) ? intl.formatMessage({ id }) : words(code);
};

function actorLabel(intl: IntlShape, actor: AuditTrailItemView['actor']): string {
  const who = intl.formatMessage({ id: `audit.actor.${actor.kind}` });
  return actor.onBehalfOf === undefined
    ? who
    : intl.formatMessage(
        { id: 'audit.actor.onBehalfOf' },
        { who, whom: intl.formatMessage({ id: `audit.actor.for.${actor.onBehalfOf}` }) },
      );
}

const ERRORS: ReadonlySet<string> = new Set([
  'invalid_period',
  'invalid_filter',
  'invalid_cursor',
  'invalid_target',
]);

function errorOf(error: unknown): string {
  if (!(error instanceof AuditTrailRequestError)) return 'generic';
  if (error.status === 403) return 'permission';
  return error.code !== undefined && ERRORS.has(error.code) ? error.code : 'generic';
}

function openLink(link: NonNullable<AuditTrailItemView['target']>['link']): string | undefined {
  if (link === undefined) return undefined;
  if (link.kind === 'conversation') return paths.conversation(link.id);
  if (link.kind === 'follow_up') return paths.followUp(link.id);
  return paths.automations();
}

export function AuditTrailPage({ client }: { readonly client: AuditTrailClient }) {
  const intl = useIntl();
  const [draft, setDraft] = useState<{ category: string; from: string; to: string }>({
    category: '',
    from: '',
    to: '',
  });
  const [query, setQuery] = useState<AuditTrailQuery>({});
  const [items, setItems] = useState<readonly AuditTrailItemView[] | undefined>();
  const [filters, setFilters] = useState<readonly string[]>([]);
  const [range, setRange] = useState<{ from: string; to: string } | undefined>();
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    client.page(query).then(
      (page) => {
        if (!live) return;
        setItems(page.items);
        setFilters(page.filters);
        setRange({ from: page.fromDay, to: page.toDay });
        setNext(page.nextCursor);
      },
      (failure: unknown) => live && setError(errorOf(failure)),
    );
    return () => {
      live = false;
    };
  }, [client, query]);

  const more = async () => {
    if (next === null) return;
    setLoadingMore(true);
    try {
      const page = await client.page({ ...query, cursor: next });
      setItems((current) => [...(current ?? []), ...page.items]);
      setNext(page.nextCursor);
    } catch (failure) {
      setError(errorOf(failure));
    } finally {
      setLoadingMore(false);
    }
  };

  const apply = () => {
    // A new question: the old answer and its error go, and the list reloads.
    setItems(undefined);
    setError(undefined);
    setQuery({
      ...(draft.category === '' ? {} : { category: draft.category }),
      ...(draft.from === '' ? {} : { from: draft.from }),
      ...(draft.to === '' ? {} : { to: draft.to }),
    });
  };

  const time = (at: string) =>
    intl.formatDate(new Date(at), { dateStyle: 'medium', timeStyle: 'medium' });

  return (
    <article className="mo-page audit-page">
      <PageHeader
        title={<FormattedMessage id="audit.title" />}
        description={<FormattedMessage id="audit.lead" />}
      />
      <Toolbar label={intl.formatMessage({ id: 'audit.filters' })}>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="audit.filter.category" />
          </span>
          <select
            value={draft.category}
            onChange={(e) => setDraft({ ...draft, category: e.target.value })}
          >
            <option value="">{intl.formatMessage({ id: 'audit.filter.all' })}</option>
            {filters.map((f) => (
              <option key={f} value={f}>
                {categoryLabel(intl, f)}
              </option>
            ))}
          </select>
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="audit.filter.from" />
          </span>
          <input
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="audit.filter.to" />
          </span>
          <input
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </label>
        <Button size="sm" onClick={apply}>
          <FormattedMessage id="audit.filter.apply" />
        </Button>
      </Toolbar>
      {range === undefined ? null : (
        <p className="mo-hint">
          <FormattedMessage id="audit.range" values={{ from: range.from, to: range.to }} />
        </p>
      )}
      {error !== undefined ? (
        <StateMessage kind="error">
          <FormattedMessage id={`audit.error.${error}`} />
        </StateMessage>
      ) : null}
      {items === undefined ? (
        error === undefined ? (
          <StateMessage kind="loading">
            <FormattedMessage id="audit.loading" />
          </StateMessage>
        ) : null
      ) : items.length === 0 ? (
        <StateMessage kind="empty">
          <FormattedMessage id="audit.empty" />
        </StateMessage>
      ) : (
        <ul className="mo-list" aria-label={intl.formatMessage({ id: 'audit.title' })}>
          {items.map((item) => {
            const action = actionLabel(intl, item.action, item.category);
            const target =
              item.target === undefined
                ? undefined
                : codeLabel(intl, 'audit.target', item.target.type);
            const link = openLink(item.target?.link);
            const shown = open === item.id;
            return (
              <li key={item.id} className="mo-list-item">
                <div className="mo-list-item__main">
                  <span className="mo-list-item__title">
                    {action}{' '}
                    {item.result === 'success' ? null : (
                      <Badge tone={item.result === 'denied' ? 'warning' : 'danger'}>
                        <FormattedMessage id={`audit.result.${item.result}`} />
                      </Badge>
                    )}
                  </span>
                  <span className="mo-list-item__meta">
                    <time dateTime={item.at}>{time(item.at)}</time> · {actorLabel(intl, item.actor)}
                    {target === undefined ? null : <> · {target}</>}
                  </span>
                  {shown ? (
                    <dl className="agent-facts">
                      <dt>
                        <FormattedMessage id="audit.detail.what" />
                      </dt>
                      <dd>
                        {action} ({categoryLabel(intl, item.category)})
                      </dd>
                      <dt>
                        <FormattedMessage id="audit.detail.who" />
                      </dt>
                      <dd>{actorLabel(intl, item.actor)}</dd>
                      <dt>
                        <FormattedMessage id="audit.detail.when" />
                      </dt>
                      <dd>{time(item.at)}</dd>
                      {target === undefined ? null : (
                        <>
                          <dt>
                            <FormattedMessage id="audit.detail.on" />
                          </dt>
                          <dd>
                            {link === undefined ? (
                              target
                            ) : (
                              <a
                                className="mo-link"
                                href={link}
                                onClick={(event) => {
                                  event.preventDefault();
                                  navigate(link);
                                }}
                              >
                                {target}
                              </a>
                            )}
                          </dd>
                        </>
                      )}
                      <dt>
                        <FormattedMessage id="audit.detail.result" />
                      </dt>
                      <dd>
                        <FormattedMessage id={`audit.result.${item.result}`} />
                      </dd>
                      <Details item={item} intl={intl} />
                    </dl>
                  ) : null}
                </div>
                <div className="mo-list-item__actions">
                  <button
                    type="button"
                    className="mo-button mo-button--ghost mo-button--sm"
                    aria-expanded={shown}
                    onClick={() => setOpen(shown ? undefined : item.id)}
                  >
                    <FormattedMessage id={shown ? 'audit.detail.hide' : 'audit.detail.show'} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {items !== undefined && next !== null ? (
        <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void more()}>
          <FormattedMessage id={loadingMore ? 'audit.loading' : 'audit.more'} />
        </Button>
      ) : null}
    </article>
  );
}

/** The event's own codes, each with its label: why, version, change, step, tool, model. */
function Details({ item, intl }: { readonly item: AuditTrailItemView; readonly intl: IntlShape }) {
  const d = item.details;
  const rows: [string, string][] = [];
  if (d.reason !== undefined) rows.push(['reason', codeLabel(intl, 'audit.reason', d.reason)]);
  if (d.version !== undefined) rows.push(['version', String(d.version)]);
  if (d.transition !== undefined) {
    rows.push(['transition', `${words(d.transition.from)} → ${words(d.transition.to)}`]);
  }
  if (d.step !== undefined) rows.push(['step', d.step]);
  if (d.tool !== undefined) rows.push(['tool', codeLabel(intl, 'approvals.tool', d.tool)]);
  if (d.permission !== undefined) rows.push(['permission', d.permission]);
  if (d.model !== undefined) rows.push(['model', d.model]);
  if (d.decision !== undefined) rows.push(['decision', d.decision]);
  return (
    <>
      {rows.map(([key, value]) => (
        <Fragment key={key}>
          <dt>
            <FormattedMessage id={`audit.detail.${key}`} />
          </dt>
          <dd>{value}</dd>
        </Fragment>
      ))}
    </>
  );
}
