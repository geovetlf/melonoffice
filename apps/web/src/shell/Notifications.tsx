import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalsClient } from '../approvals/approvalsClient.js';
import type { AutomationsClient } from '../automations/automationsClient.js';
import type { FollowUpsClient } from '../followUps/followUpsClient.js';
import { navigate } from '../identity/router.js';
import { Icon } from '../office/icons.js';
import { useOfficeData } from '../office/OfficeData.js';
import type { AgentNoticeView, AgentNotificationsClient } from './agentNotificationsClient.js';
import { paths } from './routes.js';

/**
 * The bell: what waits on the person right now, read from the systems that hold it, each with
 * the place where it is done. Approvals waiting for a decision (ADR-0026), plans waiting for
 * approval (ADR-0028) and follow-ups due today or overdue (ADR-0058). Each is read with the
 * person's own permission; nothing is stored here and nothing is invented: with nothing waiting
 * it says so.
 */

type Count = number | 'error';

interface Item {
  readonly id: 'approvals' | 'plans' | 'followUps';
  readonly count: Count;
  readonly path: string;
}

export function Notifications({
  approvals,
  automations,
  followUps,
  agents,
}: {
  /** The person's own notices about their agents (ADR-0117), with `specialist.read`. */
  readonly agents?: AgentNotificationsClient | undefined;
  /** With `approval.read`. */
  readonly approvals?: ApprovalsClient | undefined;
  /** With `plan.read`. */
  readonly automations?: AutomationsClient | undefined;
  /** With `follow_up.read`. */
  readonly followUps?: FollowUpsClient | undefined;
}) {
  const intl = useIntl();
  const menu = useRef<HTMLDetailsElement>(null);
  const [items, setItems] = useState<readonly Item[] | undefined>();
  const [notices, setNotices] = useState<
    { readonly items: readonly AgentNoticeView[]; readonly unread: number } | undefined
  >();
  const office = useOfficeData();

  const read = useCallback(() => {
    const count = <T,>(load: Promise<T>, of: (value: T) => number): Promise<Count> =>
      load.then(of, () => 'error' as const);
    const reads: Promise<Item>[] = [];
    if (approvals !== undefined) {
      reads.push(
        count(approvals.list(), (list) => list.filter((a) => a.status === 'pending').length).then(
          (c) => ({ id: 'approvals', count: c, path: paths.approvals() }),
        ),
      );
    }
    if (automations !== undefined) {
      reads.push(
        count(
          automations.plans(),
          (list) => list.filter((p) => p.status === 'approval_required').length,
        ).then((c) => ({ id: 'plans', count: c, path: paths.automations() })),
      );
    }
    if (followUps !== undefined) {
      reads.push(
        count(
          followUps.list({ open: true }),
          (list) => list.counts.overdue + list.counts.today,
        ).then((c) => ({ id: 'followUps', count: c, path: paths.followUps() })),
      );
    }
    let live = true;
    void Promise.all(reads).then((all) => live && setItems(all));
    agents?.list().then(
      (page) => live && setNotices({ items: page.notifications, unread: page.unread }),
      () => live && setNotices(undefined),
    );
    return () => {
      live = false;
    };
  }, [approvals, automations, followUps, agents]);

  useEffect(read, [read]);

  const waiting =
    (items ?? []).reduce((sum, i) => sum + (typeof i.count === 'number' ? i.count : 0), 0) +
    (notices?.unread ?? 0);
  const specialists = office.specialists.status === 'ready' ? office.specialists.value : [];
  const departments = office.departments.status === 'ready' ? office.departments.value : [];
  const agentName = (id: string | null) =>
    specialists.find((s) => s.id === id)?.displayName ??
    intl.formatMessage({ id: 'notifications.agent.someone' });
  /** The agent's place, where its task is read; the agents page when it is not known. */
  const placeOf = (notice: AgentNoticeView) => {
    // A plan's result opens GIA, who summarizes what the agents did (ADR-0119).
    if (typeof notice.planId === 'string') return paths.giaPlan(notice.planId);
    const agent = specialists.find((s) => s.id === notice.specialistId);
    const type = departments.find((d) => d.id === agent?.departmentId)?.typeId;
    return agent === undefined || type === null || type === undefined
      ? paths.agents()
      : paths.agent(type.replaceAll('_', '-'), agent.id);
  };
  const openNotice = (notice: AgentNoticeView) => {
    if (!notice.read) void agents?.markRead(notice.id).catch(() => undefined);
    go(placeOf(notice));
  };
  const shown = (items ?? []).filter((i) => i.count === 'error' || i.count > 0);
  const label =
    waiting === 0
      ? intl.formatMessage({ id: 'topbar.notifications' })
      : intl.formatMessage({ id: 'notifications.label' }, { count: waiting });

  const go = (path: string) => {
    if (menu.current !== null) menu.current.open = false;
    navigate(path);
  };

  return (
    <details
      ref={menu}
      className="user-menu notifications"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) read();
      }}
    >
      <summary className="topbar__icon" aria-label={label}>
        <Icon name="bell" size={20} />
        {waiting === 0 ? null : (
          <span className="mo-badge mo-badge--count notifications__count" aria-hidden="true">
            {waiting > 99 ? '99+' : waiting}
          </span>
        )}
      </summary>
      <div className="user-menu__panel notifications__panel">
        <p className="notifications__title">
          <FormattedMessage id="topbar.notifications" />
        </p>
        {items === undefined ? (
          <p className="panel__empty" role="status">
            <FormattedMessage id="notifications.loading" />
          </p>
        ) : items.length === 0 && notices === undefined ? (
          <p className="panel__empty">
            <FormattedMessage id="notifications.none" />
          </p>
        ) : shown.length === 0 && (notices?.items.length ?? 0) === 0 ? (
          <p className="panel__empty">
            <FormattedMessage id="notifications.empty" />
          </p>
        ) : (
          <ul className="notifications__list">
            {(notices?.items ?? []).map((notice) => (
              <li key={notice.id}>
                <button
                  type="button"
                  className={`notifications__item${notice.read ? '' : ' notifications__item--unread'}`}
                  onClick={() => openNotice(notice)}
                >
                  <FormattedMessage
                    id={`notifications.agent.${notice.kind}`}
                    values={{
                      name: agentName(notice.specialistId),
                      other: agentName(notice.otherSpecialistId),
                    }}
                  />
                </button>
              </li>
            ))}
            {shown.map((item) => (
              <li key={item.id}>
                <button type="button" className="notifications__item" onClick={() => go(item.path)}>
                  {item.count === 'error' ? (
                    <FormattedMessage id={`notifications.${item.id}.error`} />
                  ) : (
                    <FormattedMessage
                      id={`notifications.${item.id}`}
                      values={{ count: item.count }}
                    />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
