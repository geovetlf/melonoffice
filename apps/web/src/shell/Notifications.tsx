import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalsClient } from '../approvals/approvalsClient.js';
import type { AutomationsClient } from '../automations/automationsClient.js';
import type { FollowUpsClient } from '../followUps/followUpsClient.js';
import { navigate } from '../identity/router.js';
import { Icon } from '../office/icons.js';
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
}: {
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
    return () => {
      live = false;
    };
  }, [approvals, automations, followUps]);

  useEffect(read, [read]);

  const waiting = (items ?? []).reduce(
    (sum, i) => sum + (typeof i.count === 'number' ? i.count : 0),
    0,
  );
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
        ) : items.length === 0 ? (
          <p className="panel__empty">
            <FormattedMessage id="notifications.none" />
          </p>
        ) : shown.length === 0 ? (
          <p className="panel__empty">
            <FormattedMessage id="notifications.empty" />
          </p>
        ) : (
          <ul className="notifications__list">
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
