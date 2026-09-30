import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { navigate } from '../identity/router.js';
import { Icon, type IconName } from '../office/icons.js';
import { paths } from '../shell/routes.js';
import type {
  ActivityClient,
  ActivityItemView,
  ActivityPageView,
  ActivityPeriod,
} from './activityClient.js';

/**
 * The office's real activity (ADR-0049): what the audit trail recorded, in the business's time
 * zone. Used by the Home's panel and by GIA's Workplace. It never shows an example: no data is
 * "no activity yet", a failed read is "could not load".
 */

const ActivityClientContext = createContext<ActivityClient | undefined>(undefined);

export function ActivityProvider({
  client,
  children,
}: {
  readonly client: ActivityClient | undefined;
  readonly children: ReactNode;
}) {
  return <ActivityClientContext.Provider value={client}>{children}</ActivityClientContext.Provider>;
}

export type ActivityState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly page: ActivityPageView;
      /** When it was read: "5 minutes ago" counts from here. */
      readonly readAt: number;
    }
  | { readonly status: 'unavailable' }
  | { readonly status: 'hidden' };

/** Reads one period; `hidden` when the role cannot read activity (no call is made). */
export function useActivity(period: ActivityPeriod): ActivityState {
  const client = useContext(ActivityClientContext);
  const initial = (): ActivityState =>
    client === undefined ? { status: 'hidden' } : { status: 'loading' };
  const [state, setState] = useState<ActivityState>(initial);
  const [readFor, setReadFor] = useState({ client, period });
  if (readFor.client !== client || readFor.period !== period) {
    setReadFor({ client, period });
    setState(initial());
  }
  useEffect(() => {
    if (client === undefined) return;
    let live = true;
    client.list(period).then(
      (page) => {
        if (live) setState({ status: 'ready', page, readAt: Date.now() });
      },
      () => {
        if (live) setState({ status: 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, period]);
  return state;
}

const ICONS: readonly [string, IconName][] = [
  ['gia.', 'gia'],
  ['conversation.', 'communications'],
  ['channel.', 'apps'],
  ['credits.', 'coins'],
  ['tool.', 'automations'],
  ['execution.', 'automations'],
  ['plan.', 'automations'],
  ['workflow.', 'automations'],
];

/** Where an item opens: the conversations, or the follow-up among Comercial's (C5). */
const linkPath = (link: NonNullable<ActivityItemView['link']>) =>
  link.kind === 'follow_up' ? paths.followUp(link.id) : paths.conversations();

const iconOf = (action: string): IconName =>
  ICONS.find(([prefix]) => action.startsWith(prefix))?.[1] ?? 'building';

/** How long ago, in the largest unit that fits. */
function useAgo() {
  const intl = useIntl();
  return (at: string, now: number) => {
    const seconds = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
    if (seconds < 60) return intl.formatRelativeTime(0, 'minute');
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return intl.formatRelativeTime(-minutes, 'minute');
    const hours = Math.round(minutes / 60);
    if (hours < 24) return intl.formatRelativeTime(-hours, 'hour');
    return intl.formatRelativeTime(-Math.round(hours / 24), 'day');
  };
}

export function ActivityItemText({ item }: { readonly item: ActivityItemView }) {
  const intl = useIntl();
  const key = `activity.action.${item.action}`;
  const text =
    intl.messages[key] === undefined
      ? intl.formatMessage({ id: 'activity.action.unknown' })
      : intl.formatMessage({ id: key });
  const result = item.result === 'success' ? undefined : `activity.result.${item.result}`;
  return (
    <>
      {text}
      {result !== undefined && intl.messages[result] !== undefined
        ? ` · ${intl.formatMessage({ id: result })}`
        : null}
    </>
  );
}

export function ActivityList({
  state,
  max,
}: {
  readonly state: ActivityState;
  /** At most this many entries, newest first (the Home shows a few). */
  readonly max?: number;
}) {
  const intl = useIntl();
  const ago = useAgo();
  if (state.status === 'hidden') {
    return (
      <p className="panel__empty">
        <FormattedMessage id="activity.hidden" />
      </p>
    );
  }
  if (state.status === 'unavailable') {
    return (
      <p className="panel__empty" role="status">
        <FormattedMessage id="activity.unavailable" />
      </p>
    );
  }
  if (state.status === 'loading') {
    return <p className="panel__empty" aria-busy="true" />;
  }
  const { items } = state.page;
  if (items.length === 0) {
    return (
      <p className="panel__empty">
        <FormattedMessage id={`activity.empty.${state.page.period}`} />
      </p>
    );
  }
  return (
    <ul className="panel__list">
      {items.slice(0, max).map((item) => {
        const who = intl.formatMessage({ id: `activity.actor.${item.actor}` });
        const body = (
          <span className="task__body">
            <span className="task__title">
              <ActivityItemText item={item} />
            </span>
            <span className="task__meta">
              {who} · <time dateTime={item.at}>{ago(item.at, state.readAt)}</time>
            </span>
          </span>
        );
        return (
          <li key={item.id} className="activity">
            <span className="activity__icon">
              <Icon name={iconOf(item.action)} size={16} />
            </span>
            {item.link !== undefined ? (
              <a
                className="activity__link"
                href={linkPath(item.link)}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
                    return;
                  }
                  event.preventDefault();
                  navigate(linkPath(item.link as NonNullable<typeof item.link>));
                }}
              >
                {body}
              </a>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}

export const ACTIVITY_PERIODS: readonly ActivityPeriod[] = ['today', 'week', 'month'];

/** Today, this week, this month: one set of toggle buttons, in the business's time zone. */
export function PeriodPicker({
  period,
  onChange,
  labelId,
}: {
  readonly period: ActivityPeriod;
  readonly onChange: (period: ActivityPeriod) => void;
  readonly labelId: string;
}) {
  const intl = useIntl();
  return (
    <div className="period-picker" role="group" aria-label={intl.formatMessage({ id: labelId })}>
      {ACTIVITY_PERIODS.map((p) => (
        <button
          key={p}
          type="button"
          className="mo-chip period-picker__option"
          aria-pressed={p === period}
          onClick={() => onChange(p)}
        >
          <FormattedMessage id={`activity.period.${p}`} />
        </button>
      ))}
    </div>
  );
}
