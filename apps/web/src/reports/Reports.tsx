import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { PageHeader, PeriodPicker, StateMessage } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import {
  ReportRequestError,
  type MetricHistoryView,
  type MetricView,
  type ReportFrequency,
  type ReportsClient,
} from './reportsClient.js';

/**
 * Reports (ADR-0060): what was recorded for each metric the person may read, per day, week or
 * month, in the business's time zone. Every figure is the API's, added up from the
 * organization's own records: nothing here is projected, estimated or filled in, and the period
 * under way is shown apart, as "so far". How much history exists for a projection is the
 * Forecasting Engine's own count.
 */

type IntlShape = ReturnType<typeof useIntl>;

type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly error: unknown };

const FREQUENCIES: readonly ReportFrequency[] = ['day', 'week', 'month'];

function useLoad<T>(load: () => Promise<T>, key: string): Load<T> {
  const [read, setRead] = useState<{ key: string; load: Load<T> } | undefined>();
  useEffect(() => {
    let live = true;
    load().then(
      (value) => live && setRead({ key, load: { status: 'ready', value } }),
      (error: unknown) => live && setRead({ key, load: { status: 'error', error } }),
    );
    return () => {
      live = false;
    };
    // The key names everything the load depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return read?.key === key ? read.load : { status: 'loading' };
}

/** A period (`YYYY-MM-DD`, a local date of the business) as the reader's calendar shows it. */
const periodLabel = (intl: IntlShape, period: string, frequency: ReportFrequency) =>
  intl.formatDate(new Date(`${period}T12:00:00Z`), {
    timeZone: 'UTC',
    ...(frequency === 'month'
      ? { month: 'short', year: 'numeric' }
      : { day: 'numeric', month: 'short' }),
  });

const amount = (intl: IntlShape, history: MetricHistoryView, value: number) =>
  history.unit === 'currency'
    ? intl.formatNumber(value, { style: 'currency', currency: history.entity })
    : intl.formatNumber(value, { maximumFractionDigits: 1 });

/** The reports of the metrics a department is served by, or all of them. */
export function ReportsSection({
  client,
  department,
}: {
  readonly client: ReportsClient;
  /** A department's catalogue type: only its metrics. Absent: every metric. */
  readonly department?: string;
}) {
  const [frequency, setFrequency] = useState<ReportFrequency>('day');
  const metrics = useLoad(() => client.metrics(), 'metrics');
  const titleId = `reports-${department ?? 'all'}`;
  const shown =
    metrics.status === 'ready'
      ? metrics.value.filter(
          (m) =>
            m.readable &&
            m.frequencies.includes(frequency) &&
            (department === undefined || m.departments.includes(department)),
        )
      : [];
  if (department !== undefined && metrics.status === 'ready' && shown.length === 0) return null;
  return (
    <section className="mo-panel mo-page-section reports" aria-labelledby={titleId}>
      <header className="mo-page-section__header">
        <h2 id={titleId} className="mo-section-title">
          <FormattedMessage id="reports.title" />
        </h2>
        <div className="mo-toolbar">
          <span id={`${titleId}-per`} className="mo-toolbar__label">
            <FormattedMessage id="reports.per" />
          </span>
          <PeriodPicker
            labelledBy={`${titleId}-per`}
            options={FREQUENCIES}
            value={frequency}
            onChange={setFrequency}
            renderOption={(f) => <FormattedMessage id={`reports.frequency.${f}`} />}
          />
        </div>
      </header>
      <p className="mo-hint">
        <FormattedMessage id="reports.recordedOnly" />
      </p>
      {metrics.status === 'loading' ? (
        <StateMessage kind="loading">
          <FormattedMessage id="reports.loading" />
        </StateMessage>
      ) : metrics.status === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="reports.error.generic" />
        </StateMessage>
      ) : shown.length === 0 ? (
        <StateMessage kind="empty">
          <FormattedMessage id="reports.none" />
        </StateMessage>
      ) : (
        <ul className="reports__list">
          {shown.map((metric) => (
            <li key={metric.id}>
              <MetricCard client={client} metric={metric} frequency={frequency} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MetricCard({
  client,
  metric,
  frequency,
}: {
  readonly client: ReportsClient;
  readonly metric: MetricView;
  readonly frequency: ReportFrequency;
}) {
  const intl = useIntl();
  const history = useLoad(
    () => client.history(metric.id, { frequency }),
    `${metric.id}:${frequency}`,
  );
  const titleId = `metric-${metric.id.replace('.', '-')}-${frequency}`;
  return (
    <article className="mo-card report-card" aria-labelledby={titleId}>
      <h3 id={titleId} className="report-card__title">
        <FormattedMessage id={`reports.metric.${metric.id}`} />
      </h3>
      {history.status === 'loading' ? (
        <StateMessage kind="loading" inline>
          <FormattedMessage id="reports.loading" />
        </StateMessage>
      ) : history.status === 'error' ? (
        <MetricError error={history.error} />
      ) : (
        <MetricFigures intl={intl} history={history.value} />
      )}
    </article>
  );
}

function MetricError({ error }: { readonly error: unknown }) {
  const missing =
    error instanceof ReportRequestError && error.code === 'invalid_request'
      ? error.field === 'business_context'
        ? 'profile'
        : error.field === 'entity'
          ? 'currency'
          : undefined
      : undefined;
  if (missing === undefined) {
    return (
      <StateMessage kind="error">
        <FormattedMessage id="reports.error.generic" />
      </StateMessage>
    );
  }
  return (
    <StateMessage kind="warning">
      <FormattedMessage id={`reports.error.${missing}`} />{' '}
      <a
        className="mo-link"
        href={paths.memory()}
        onClick={(event) => {
          event.preventDefault();
          navigate(paths.memory());
        }}
      >
        <FormattedMessage id="reports.openMemory" />
      </a>
    </StateMessage>
  );
}

function MetricFigures({
  intl,
  history,
}: {
  readonly intl: IntlShape;
  readonly history: MetricHistoryView;
}) {
  const { frequency, points, total, previousTotal, readiness } = history;
  const change =
    previousTotal === null || previousTotal === 0
      ? null
      : Math.round(((total - previousTotal) / previousTotal) * 100);
  const range = {
    count: points.length,
    from: periodLabel(intl, history.from, frequency),
    to: periodLabel(intl, history.to, frequency),
  };
  return (
    <>
      <p className="report-card__total">{amount(intl, history, total)}</p>
      <p className="report-card__meta">
        <FormattedMessage id={`reports.window.${frequency}`} values={range} />
      </p>
      <p className="report-card__meta">
        {previousTotal === null ? (
          <FormattedMessage id="reports.compare.none" />
        ) : change === null ? (
          <FormattedMessage
            id="reports.compare.fromZero"
            values={{ previous: amount(intl, history, previousTotal) }}
          />
        ) : (
          <FormattedMessage
            id="reports.compare.change"
            values={{
              change: `${change > 0 ? '+' : ''}${change}%`,
              previous: amount(intl, history, previousTotal),
            }}
          />
        )}
      </p>
      <Bars
        intl={intl}
        history={history}
        label={intl.formatMessage({ id: `reports.window.${frequency}` }, range)}
      />
      <p className="report-card__meta">
        <FormattedMessage
          id={`reports.current.${frequency}`}
          values={{ value: amount(intl, history, history.current.value) }}
        />
      </p>
      <p className="report-card__readiness">
        {readiness.ready ? (
          <FormattedMessage
            id="reports.readiness.ready"
            values={{ have: readiness.have, unit: frequency }}
          />
        ) : readiness.problem === 'insufficient_data' &&
          readiness.have !== null &&
          readiness.need !== null ? (
          <FormattedMessage
            id={
              readiness.shortOf === 'active_periods'
                ? 'reports.readiness.activity'
                : 'reports.readiness.history'
            }
            values={{ have: readiness.have, need: readiness.need, unit: frequency }}
          />
        ) : (
          <FormattedMessage id="reports.readiness.invalid" />
        )}
      </p>
    </>
  );
}

/** One bar per period, scaled to the largest; the figures are in the words around it. */
function Bars({
  intl,
  history,
  label,
}: {
  readonly intl: IntlShape;
  readonly history: MetricHistoryView;
  readonly label: string;
}) {
  const { points } = history;
  const top = Math.max(0, ...points.map((p) => p.value));
  const width = 100 / Math.max(1, points.length);
  return (
    <svg
      className="report-card__bars"
      viewBox="0 0 100 32"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {points.map((p, i) => {
        const height = top === 0 ? 0 : (p.value / top) * 30;
        return (
          <rect
            key={p.period}
            x={i * width + width * 0.15}
            y={32 - Math.max(height, 0.6)}
            width={width * 0.7}
            height={Math.max(height, 0.6)}
            className={
              p.value === 0 ? 'report-card__bar report-card__bar--zero' : 'report-card__bar'
            }
          >
            <title>
              {`${periodLabel(intl, p.period, history.frequency)}: ${amount(intl, history, p.value)}`}
            </title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Reports, the tool (ADR-0060): every metric the person may read. */
export function ReportsPage({ client }: { readonly client: ReportsClient }) {
  return (
    <article className="mo-page reports-page">
      <PageHeader title={<FormattedMessage id="nav.reports" />} />
      <ReportsSection client={client} />
    </article>
  );
}
