import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../office/icons.js';
import type { CreditsView } from '../office/officeClient.js';
import type { Loadable } from '../office/OfficeData.js';
import type { ActivityItem, MeetingItem, TaskItem } from './sampleData.js';

/**
 * The Home's panels under the office (ADR-0040). They complement the office; they are not the
 * page. Each says where its content comes from: credits are the organization's real balance; the
 * other panels show examples, marked as such, until their data exists.
 */

function Panel({
  titleId,
  icon,
  sample = false,
  children,
}: {
  readonly titleId: string;
  readonly icon: IconName;
  readonly sample?: boolean;
  readonly children: ReactNode;
}) {
  const id = `panel-${titleId.replaceAll('.', '-')}`;
  return (
    <section className="panel" aria-labelledby={id}>
      <header className="panel__header">
        <Icon name={icon} size={18} className="panel__icon" />
        <h2 id={id} className="panel__title">
          <FormattedMessage id={titleId} />
        </h2>
        {sample ? (
          <span className="panel__sample">
            <FormattedMessage id="home.sample.badge" />
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

const useDepartmentName = () => {
  const intl = useIntl();
  return (typeId: string) => {
    const key = `department.${typeId}.short`;
    return intl.messages[key] === undefined ? typeId : intl.formatMessage({ id: key });
  };
};

/** A local time of day, `HH:MM`, in the person's locale. */
function useTimeOfDay() {
  const intl = useIntl();
  return (at: string) => {
    const [hours = 0, minutes = 0] = at.split(':').map(Number);
    const date = new Date(2000, 0, 1, hours, minutes);
    return intl.formatTime(date, { hour: 'numeric', minute: '2-digit' });
  };
}

export function TodayTasks({
  tasks,
  sample,
}: {
  readonly tasks: readonly TaskItem[];
  readonly sample: boolean;
}) {
  const intl = useIntl();
  const department = useDepartmentName();
  const time = useTimeOfDay();
  return (
    <Panel titleId="home.tasks.title" icon="check" sample={sample}>
      {tasks.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="home.tasks.empty" />
        </p>
      ) : (
        <ul className="panel__list">
          {tasks.map((task) => (
            <li key={task.id} className="task">
              <span className="task__box" aria-hidden="true" />
              <span className="task__body">
                <span className="task__title">{intl.formatMessage({ id: task.titleKey })}</span>
                <span className="task__meta">
                  {department(task.departmentTypeId)} · {time(task.at)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function RecentActivity({
  items,
  sample,
}: {
  readonly items: readonly ActivityItem[];
  readonly sample: boolean;
}) {
  const intl = useIntl();
  return (
    <Panel titleId="home.activity.title" icon="reports" sample={sample}>
      {items.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="home.activity.empty" />
        </p>
      ) : (
        <ul className="panel__list">
          {items.map((item) => (
            <li key={item.id} className="activity">
              <span className="activity__icon">
                <Icon name={item.icon} size={16} />
              </span>
              <span className="task__body">
                <span className="task__title">{intl.formatMessage({ id: item.textKey })}</span>
                <span className="task__meta">
                  {intl.formatRelativeTime(
                    item.minutesAgo >= 60 ? -Math.round(item.minutesAgo / 60) : -item.minutesAgo,
                    item.minutesAgo >= 60 ? 'hour' : 'minute',
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function UpcomingMeetings({
  meetings,
  sample,
}: {
  readonly meetings: readonly MeetingItem[];
  readonly sample: boolean;
}) {
  const intl = useIntl();
  const department = useDepartmentName();
  const time = useTimeOfDay();
  return (
    <Panel titleId="home.meetings.title" icon="calendar" sample={sample}>
      {meetings.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="home.meetings.empty" />
        </p>
      ) : (
        <ol className="timeline">
          {meetings.map((meeting) => (
            <li key={meeting.id} className="timeline__item">
              <span className="timeline__time">{time(meeting.at)}</span>
              <span className="task__body">
                <span className="task__title">{intl.formatMessage({ id: meeting.titleKey })}</span>
                <span className="task__meta">{department(meeting.departmentTypeId)}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
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
}: {
  readonly credits: Loadable<CreditsView>;
  readonly extras?: CreditUsageExtras;
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
            <span className="credits__number">{intl.formatNumber(balance)}</span>
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
    </Panel>
  );
}
