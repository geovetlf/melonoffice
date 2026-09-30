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

export type TodayWorkState = {
  readonly due: Load<FollowUpList>;
  readonly pending: Load<number>;
};

/**
 * Today's work, read once for the Home: the follow-ups due and the approvals waiting, each only
 * with its permission. The Home's header counts them and the panel lists them.
 */
export function useTodayWork(
  followUps: FollowUpsClient | undefined,
  approvals: ApprovalsClient | undefined,
): TodayWorkState {
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
  return { due, pending };
}

/** How many things wait on the person today: approvals, and follow-ups due or overdue. */
export function attentionCount({ due, pending }: TodayWorkState): number | undefined {
  if (due === 'loading' || pending === 'loading') return undefined;
  if (due === undefined && pending === undefined) return undefined;
  const dueCount = typeof due === 'object' ? due.counts.overdue + due.counts.today : 0;
  return dueCount + (typeof pending === 'number' ? pending : 0);
}

export function TodayWork({
  followUps,
  approvals,
  work,
  shown = SHOWN,
}: {
  /** With `follow_up.read`. */
  readonly followUps?: FollowUpsClient | undefined;
  /** With `approval.read`. */
  readonly approvals?: ApprovalsClient | undefined;
  /** Today's work already read by the page; without it, the panel reads it itself. */
  readonly work?: TodayWorkState;
  /** How many entries fit, the approvals line included (the Home gives fewer on a short screen). */
  readonly shown?: number;
}) {
  const intl = useIntl();
  const own = useTodayWork(
    work === undefined ? followUps : undefined,
    work === undefined ? approvals : undefined,
  );
  const { due, pending } = work ?? own;

  const loading = due === 'loading' || pending === 'loading';
  const items =
    typeof due === 'object'
      ? due.items.filter((f) => f.when === 'overdue' || f.when === 'today')
      : [];
  const dueCount = typeof due === 'object' ? due.counts.overdue + due.counts.today : 0;
  const approvalsCount = typeof pending === 'number' ? pending : 0;
  const listed = Math.max(0, shown - (approvalsCount > 0 ? 1 : 0));
  return (
    <Panel titleId="home.tasks.title" icon="check">
      {due === undefined && pending === undefined ? (
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
                <span className="task__box task__box--approval" aria-hidden="true" />
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
            {items.slice(0, listed).map((f) => (
              <li key={f.id} className="task">
                <span
                  className={`task__box${f.when === 'overdue' ? ' task__box--overdue' : ''}`}
                  aria-hidden="true"
                />
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
          {dueCount > Math.min(items.length, listed) ? (
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
