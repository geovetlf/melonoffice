import { DataTable, PageHeader, PeriodPicker, StateMessage, Toolbar } from '@melonoffice/ui';
import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { departmentName } from '../office/departments.js';
import { CreditsPanel } from './CreditsPanel.js';
import {
  eventKey,
  periodDays,
  USAGE_DIMENSIONS,
  type AIUsageClient,
  type UsageBucket,
  type UsageDimension,
  type UsageEvent,
  type UsagePeriod,
  type UsageSummary,
} from './aiUsageClient.js';

/**
 * AI usage (ADR-0074, ADR-0081, ADR-0082): what the organization's AI use charged it in credits
 * and where it went, by capability, department, agent, workflow and task. Which provider or model
 * MelonMotor used, and what it cost MelonOffice, are the platform administrator's and never shown
 * here. Every figure is the usage ledger's, over whole UTC days; a breakdown row filters the
 * recent operations below it to that row.
 */

type IntlShape = ReturnType<typeof useIntl>;

const PERIODS: readonly UsagePeriod[] = ['today', 'week', 'month'];

type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error' };

export const usd = (intl: IntlShape, micro: number) =>
  intl.formatNumber(micro / 1_000_000, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: micro > 0 && micro < 10_000 ? 6 : 2,
  });

export function AIUsagePage({
  client,
  now = () => new Date(),
}: {
  readonly client: AIUsageClient;
  readonly now?: () => Date;
}) {
  const intl = useIntl();
  const [period, setPeriod] = useState<UsagePeriod>('today');
  const [summary, setSummary] = useState<{ key: UsagePeriod; load: Load<UsageSummary> }>();
  const [events, setEvents] = useState<Load<readonly UsageEvent[]>>({ status: 'loading' });
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<{ dimension: UsageDimension; key: string } | undefined>();
  const names = useNames();

  useEffect(() => {
    let live = true;
    const { from, to } = periodDays(period, now());
    client.summary(from, to).then(
      (value) => live && setSummary({ key: period, load: { status: 'ready', value } }),
      () => live && setSummary({ key: period, load: { status: 'error' } }),
    );
    return () => {
      live = false;
    };
    // `now` is read when the period changes; it is not a dependency of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, period]);

  useEffect(() => {
    let live = true;
    client.events().then(
      (page) => {
        if (!live) return;
        setEvents({ status: 'ready', value: page.events });
        setNextCursor(page.nextCursor);
      },
      () => live && setEvents({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [client]);

  const more = async () => {
    if (nextCursor === null || events.status !== 'ready') return;
    try {
      const page = await client.events(nextCursor);
      setEvents({ status: 'ready', value: [...events.value, ...page.events] });
      setNextCursor(page.nextCursor);
    } catch {
      setEvents({ status: 'error' });
    }
  };

  const load: Load<UsageSummary> = summary?.key === period ? summary.load : { status: 'loading' };

  return (
    <article className="mo-page ai-usage">
      <PageHeader
        title={<FormattedMessage id="aiUsage.title" />}
        description={<FormattedMessage id="aiUsage.lead" />}
      />
      <CreditsPanel client={client} now={now} />
      <Toolbar>
        <PeriodPicker
          label={intl.formatMessage({ id: 'aiUsage.period' })}
          options={PERIODS}
          value={period}
          onChange={(p) => {
            setPeriod(p);
            setFilter(undefined);
          }}
          renderOption={(p) => <FormattedMessage id={`aiUsage.period.${p}`} />}
        />
      </Toolbar>

      {load.status === 'loading' ? (
        <StateMessage kind="loading">
          <FormattedMessage id="aiUsage.loading" />
        </StateMessage>
      ) : load.status === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="aiUsage.error" />
        </StateMessage>
      ) : (
        <div className="mo-panel mo-page-section">
          <p className="mo-hint">
            <FormattedMessage
              id="aiUsage.range"
              values={{ from: load.value.from, to: load.value.to }}
            />
          </p>
          <Totals intl={intl} totals={load.value.totals} />
          {load.value.totals.operations === 0 ? (
            <StateMessage kind="empty">
              <FormattedMessage id="aiUsage.none" />
            </StateMessage>
          ) : (
            <div className="ai-usage__breakdowns">
              {USAGE_DIMENSIONS.map((dimension) => (
                <Breakdown
                  key={dimension}
                  intl={intl}
                  dimension={dimension}
                  rows={load.value.by[dimension] ?? {}}
                  name={(key) => names(intl, dimension, key)}
                  selected={filter?.dimension === dimension ? filter.key : undefined}
                  onSelect={(key) =>
                    setFilter(
                      filter?.dimension === dimension && filter.key === key
                        ? undefined
                        : { dimension, key },
                    )
                  }
                />
              ))}
            </div>
          )}
        </div>
      )}

      <section className="mo-panel mo-page-section" aria-labelledby="ai-usage-events">
        <h2 id="ai-usage-events" className="mo-section-title">
          <FormattedMessage id="aiUsage.events.title" />
        </h2>
        {filter === undefined ? null : (
          <p className="mo-toolbar" role="status">
            <FormattedMessage
              id="aiUsage.events.filtered"
              values={{
                dimension: intl.formatMessage({ id: `aiUsage.by.${filter.dimension}` }),
                value: names(intl, filter.dimension, filter.key),
              }}
            />{' '}
            <button
              type="button"
              className="mo-button mo-button--ghost mo-button--sm"
              onClick={() => setFilter(undefined)}
            >
              <FormattedMessage id="aiUsage.events.clear" />
            </button>
          </p>
        )}
        <Events
          intl={intl}
          load={events}
          filter={filter}
          name={(dimension, key) => names(intl, dimension, key)}
        />
        {nextCursor !== null && events.status === 'ready' ? (
          <button
            type="button"
            className="mo-button mo-button--secondary mo-page-section__more"
            onClick={() => void more()}
          >
            <FormattedMessage id="aiUsage.events.more" />
          </button>
        ) : null}
      </section>
    </article>
  );
}

/** Credits charged and how many operations they paid for. */
function Totals({ intl, totals }: { readonly intl: IntlShape; readonly totals: UsageBucket }) {
  return (
    <dl className="mo-stats">
      <div className="mo-stat">
        <dt>
          <FormattedMessage id="aiUsage.credits" />
        </dt>
        <dd>{intl.formatNumber(totals.credits)}</dd>
      </div>
      <div className="mo-stat">
        <dt>
          <FormattedMessage id="aiUsage.operations" />
        </dt>
        <dd>{intl.formatNumber(totals.operations)}</dd>
      </div>
    </dl>
  );
}

function Breakdown({
  intl,
  dimension,
  rows,
  name,
  selected,
  onSelect,
}: {
  readonly intl: IntlShape;
  readonly dimension: UsageDimension;
  readonly rows: Readonly<Record<string, UsageBucket>>;
  readonly name: (key: string) => string;
  readonly selected: string | undefined;
  readonly onSelect: (key: string) => void;
}) {
  const entries = Object.entries(rows).sort(
    ([, a], [, b]) => b.credits - a.credits || b.operations - a.operations,
  );
  if (entries.length === 0) return null;
  const titleId = `ai-usage-by-${dimension}`;
  return (
    <section className="ai-usage__breakdown" aria-labelledby={titleId}>
      <h2 id={titleId} className="mo-subsection-title">
        <FormattedMessage id={`aiUsage.by.${dimension}`} />
      </h2>
      <DataTable label={intl.formatMessage({ id: `aiUsage.by.${dimension}` })}>
        <thead>
          <tr>
            <th scope="col">
              <FormattedMessage id={`aiUsage.by.${dimension}`} />
            </th>
            <th scope="col" className="mo-table__num">
              <FormattedMessage id="aiUsage.operations" />
            </th>
            <th scope="col" className="mo-table__num">
              <FormattedMessage id="aiUsage.credits" />
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([key, bucket]) => (
            <tr key={key}>
              <th scope="row">
                <button
                  type="button"
                  className="mo-link-button"
                  aria-pressed={selected === key}
                  onClick={() => onSelect(key)}
                >
                  {name(key)}
                </button>
              </th>
              <td className="mo-table__num">{intl.formatNumber(bucket.operations)}</td>
              <td className="mo-table__num">{intl.formatNumber(bucket.credits)}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </section>
  );
}

function Events({
  intl,
  load,
  filter,
  name,
}: {
  readonly intl: IntlShape;
  readonly load: Load<readonly UsageEvent[]>;
  readonly filter: { dimension: UsageDimension; key: string } | undefined;
  readonly name: (dimension: UsageDimension, key: string) => string;
}) {
  if (load.status === 'loading') {
    return (
      <StateMessage kind="loading">
        <FormattedMessage id="aiUsage.loading" />
      </StateMessage>
    );
  }
  if (load.status === 'error') {
    return (
      <StateMessage kind="error">
        <FormattedMessage id="aiUsage.events.error" />
      </StateMessage>
    );
  }
  const shown =
    filter === undefined
      ? load.value
      : load.value.filter((e) => eventKey(e, filter.dimension) === filter.key);
  if (shown.length === 0) {
    return (
      <StateMessage kind="empty">
        <FormattedMessage id="aiUsage.events.none" />
      </StateMessage>
    );
  }
  return (
    <ul className="mo-list">
      {shown.map((e) => {
        return (
          <li key={e.id} className="mo-list-item">
            <span className="mo-list-item__title">{name('capability', e.capability)}</span>
            <span className="mo-list-item__meta">
              {intl.formatDate(new Date(e.occurredAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
              {e.attribution.specialistId === undefined
                ? ''
                : ` · ${name('agent', e.attribution.specialistId)}`}
              {e.attribution.departmentId === undefined
                ? ''
                : ` · ${name('department', e.attribution.departmentId)}`}
            </span>
            <span className="mo-list-item__meta">
              <FormattedMessage id="aiUsage.credits" />: {intl.formatNumber(e.credits)}
              {e.outcome === 'failed' ? (
                <>
                  {' · '}
                  <FormattedMessage id="aiUsage.failed" />
                </>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Readable names for ledger keys: departments and agents from the office, capabilities by label. */
function useNames() {
  const { departments, specialists } = useOfficeData();
  const allDepartments = readyList(departments);
  const agents = readyList(specialists);
  return (intl: IntlShape, dimension: UsageDimension, key: string): string => {
    if (dimension === 'capability') {
      const id = `aiUsage.capability.${key}`;
      return intl.messages[id] === undefined ? key : intl.formatMessage({ id });
    }
    if (dimension === 'department') {
      const department = allDepartments.find((d) => d.id === key);
      return department === undefined ? key : departmentName(intl, department, 'name');
    }
    if (dimension === 'agent') return agents.find((a) => a.id === key)?.displayName ?? key;
    return key;
  };
}
