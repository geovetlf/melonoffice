import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import type { ApprovalsClient } from '../approvals/approvalsClient.js';
import type { FollowUpList, FollowUpsClient } from '../followUps/followUpsClient.js';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import { Panel } from './panels.js';

/**
 * Today's work on the Home: what really waits on the person today. Open follow-ups that are due
 * today or overdue (C5, ADR-0058) and approvals waiting for a decision (ADR-0026), each read
 * with the person's own permissions and each opening the place where it is done. Never an
 * example: with nothing due, it says so.
 */

/** How many follow-ups the Home lists; the rest are one click away. */
const SHOWN = 5;

type Load<T> = T | 'loading' | 'error' | undefined;

export function TodayWork({
  followUps,
  approvals,
}: {
  /** With `follow_up.read`. */
  readonly followUps?: FollowUpsClient | undefined;
  /** With `approval.read`. */
  readonly approvals?: ApprovalsClient | undefined;
}) {
  const intl = useIntl();
  const [due, setDue] = useState<Load<FollowUpList>>(
    followUps === undefined ? undefined : 'loading',
  );
  const [pending, setPending] = useState<Load<number>>(
    approvals === undefined ? undefined : 'loading',
  );

  useEffect(() => {
    let live = true;
    followUps?.list({ open: true }).then(
      (list) => live && setDue(list),
      () => live && setDue('error'),
    );
    approvals?.list().then(
      (list) => live && setPending(list.filter((a) => a.status === 'pending').length),
      () => live && setPending('error'),
    );
    return () => {
      live = false;
    };
  }, [followUps, approvals]);

  const loading = due === 'loading' || pending === 'loading';
  const items =
    typeof due === 'object'
      ? due.items.filter((f) => f.when === 'overdue' || f.when === 'today')
      : [];
  const dueCount = typeof due === 'object' ? due.counts.overdue + due.counts.today : 0;
  const approvalsCount = typeof pending === 'number' ? pending : 0;

  return (
    <Panel titleId="home.tasks.title" icon="check">
      {followUps === undefined && approvals === undefined ? (
        <p className="panel__empty">
          <FormattedMessage id="home.tasks.none" />
        </p>
      ) : loading ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="home.tasks.loading" />
        </p>
      ) : (
        <>
          {due === 'error' || pending === 'error' ? (
            <p className="panel__empty" role="alert">
              <FormattedMessage id="home.tasks.error" />
            </p>
          ) : null}
          {approvalsCount === 0 && items.length === 0 && due !== 'error' && pending !== 'error' ? (
            <p className="panel__empty">
              <FormattedMessage id="home.tasks.empty" />
            </p>
          ) : null}
          <ul className="panel__list">
            {approvalsCount > 0 ? (
              <li className="task">
                <span className="task__box" aria-hidden="true" />
                <button
                  type="button"
                  className="task__body task__link"
                  onClick={() => navigate(paths.approvals())}
                >
                  <span className="task__title">
                    <FormattedMessage
                      id="home.tasks.approvals"
                      values={{ count: approvalsCount }}
                    />
                  </span>
                  <span className="task__meta">
                    <FormattedMessage id="home.tasks.approvalsMeta" />
                  </span>
                </button>
              </li>
            ) : null}
            {items.slice(0, SHOWN).map((f) => (
              <li key={f.id} className="task">
                <span className="task__box" aria-hidden="true" />
                <button
                  type="button"
                  className="task__body task__link"
                  onClick={() => navigate(paths.followUp(f.id))}
                >
                  <span className="task__title">{f.title}</span>
                  <span className="task__meta">
                    {f.contactName ?? intl.formatMessage({ id: 'home.tasks.contact' })}
                    {' · '}
                    {f.when === 'overdue' ? (
                      <FormattedMessage
                        id="home.tasks.overdue"
                        values={{ days: Math.abs(f.days) }}
                      />
                    ) : (
                      f.time
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {dueCount > Math.min(items.length, SHOWN) ? (
            <button
              type="button"
              className="panel__link"
              onClick={() => navigate(paths.followUps())}
            >
              <FormattedMessage id="home.tasks.all" values={{ count: dueCount }} />
            </button>
          ) : null}
        </>
      )}
    </Panel>
  );
}
