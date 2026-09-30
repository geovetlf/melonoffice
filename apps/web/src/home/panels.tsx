import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useState, type ReactNode } from 'react';
import { ActivityList, PeriodPicker, useActivity } from '../activity/ActivityFeed.js';
import type { ActivityPeriod } from '../activity/activityClient.js';
import { Icon, type IconName } from '../office/icons.js';
import type { CreditsView } from '../office/officeClient.js';
import type { Loadable } from '../office/OfficeData.js';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';

/**
 * The Home's panels under the office (ADR-0040). They complement the office; they are not the
 * page. Each says where its content comes from: credits are the organization's real balance and
 * activity is the audit trail's (ADR-0049), today's work is the real follow-ups and approvals,
 * and meetings wait for a calendar connection. No panel shows example data.
 */

/**
 * How much a panel weighs beside the others: the day's activity leads, what waits on the person
 * follows, and a panel with nothing to show yet (meetings, with no calendar) stays quiet.
 */
export type PanelLevel = 'lead' | 'default' | 'quiet';

export function Panel({
  titleId,
  icon,
  level = 'default',
  children,
}: {
  readonly titleId: string;
  readonly icon: IconName;
  readonly level?: PanelLevel;
  readonly children: ReactNode;
}) {
  const id = `panel-${titleId.replaceAll('.', '-')}`;
  return (
    <section
      className={level === 'default' ? 'panel' : `panel panel--${level}`}
      aria-labelledby={id}
    >
      <header className="panel__header">
        <Icon name={icon} size={18} className="panel__icon" />
        <h2 id={id} className="panel__title">
          <FormattedMessage id={titleId} />
        </h2>
      </header>
      {children}
    </section>
  );
}

/**
 * The office's real activity (ADR-0049): what the audit trail recorded today, this week or this
 * month, in the business's time zone. It is never an example.
 */
/** The Home shows the latest few; GIA's workplace lists them all. */
export function RecentActivity({ shown = 3 }: { readonly shown?: number } = {}) {
  const [period, setPeriod] = useState<ActivityPeriod>('today');
  const state = useActivity(period);
  const more = state.status === 'ready' && state.page.items.length > shown;
  return (
    <Panel titleId="home.activity.title" icon="reports" level="lead">
      {state.status === 'hidden' ? null : (
        <PeriodPicker period={period} onChange={setPeriod} labelId="activity.period.label" />
      )}
      <ActivityList state={state} max={shown} />
      {state.status === 'ready' && state.page.items.length === 0 ? (
        <p className="panel__hint">
          <FormattedMessage id="home.activity.emptyHint" />
        </p>
      ) : null}
      {more ? (
        <button type="button" className="panel__link" onClick={() => navigate(paths.gia())}>
          <FormattedMessage id="home.activity.all" />
        </button>
      ) : null}
    </Panel>
  );
}

/**
 * Meetings come from a calendar, and MelonOffice has no calendar connection yet: the panel says
 * so rather than show examples.
 */
export function UpcomingMeetings() {
  return (
    <Panel titleId="home.meetings.title" icon="calendar" level="quiet">
      <p className="panel__empty">
        <FormattedMessage id="home.meetings.noCalendar" />
      </p>
    </Panel>
  );
}

/**
 * Credit use, from the organization's wallet (ADR-0023). Today the API gives the balance only:
 * the plan's allotment (D-12) and a weekly history do not exist yet, so the panel shows the
 * balance and draws the rest only once it is given.
 */
export interface CreditUsageExtras {
  readonly allotment?: number;
  readonly used?: number;
  readonly weekly?: readonly number[];
}

export function CreditsUsage({
  credits,
  extras = {},
  showUsage = false,
}: {
  readonly credits: Loadable<CreditsView>;
  readonly extras?: CreditUsageExtras;
  /** A link to AI usage and credits (ADR-0074), for a person who may read it. */
  readonly showUsage?: boolean;
}) {
  const intl = useIntl();
  if (credits.status === 'hidden') return null;
  const balance =
    credits.status === 'ready' && credits.value.status === 'present'
      ? credits.value.balance
      : undefined;
  const { allotment, used, weekly } = extras;
  const share =
    allotment !== undefined && used !== undefined && allotment > 0
      ? Math.min(1, used / allotment)
      : undefined;
  return (
    <Panel titleId="home.credits.title" icon="credits">
      {credits.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="home.credits.loading" />
        </p>
      ) : balance === undefined ? (
        <p className="panel__empty">
          <FormattedMessage id="home.credits.unavailable" />
        </p>
      ) : (
        <div className="credits">
          <p className="credits__balance">
            <span className="credits__number mo-figure">{intl.formatNumber(balance)}</span>
            {allotment === undefined ? null : (
              <span className="credits__of"> / {intl.formatNumber(allotment)}</span>
            )}
          </p>
          <p className="credits__label">
            <FormattedMessage id="home.credits.available" />
          </p>
          {share === undefined ? null : (
            <div
              className="credits__meter"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
              aria-label={intl.formatMessage({ id: 'home.credits.used' })}
            >
              <span style={{ width: `${share * 100}%` }} />
            </div>
          )}
          {weekly === undefined || weekly.length === 0 ? null : (
            <div className="credits__week" aria-hidden="true">
              {weekly.map((value, i) => (
                <span key={i} style={{ height: `${(value / Math.max(...weekly, 1)) * 100}%` }} />
              ))}
            </div>
          )}
        </div>
      )}
      {showUsage ? (
        <a
          className="panel__link"
          href={paths.aiUsage()}
          onClick={(event) => {
            event.preventDefault();
            navigate(paths.aiUsage());
          }}
        >
          <FormattedMessage id="home.credits.usage" />
        </a>
      ) : null}
    </Panel>
  );
}
