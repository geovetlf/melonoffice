import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import { navigate } from '../identity/router.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { paths } from '../shell/routes.js';
import {
  ApprovalRequestError,
  type ApprovalView,
  type ApprovalsClient,
} from './approvalsClient.js';

/**
 * The approval center (ADR-0026): every operation agents asked a person to approve, in one list,
 * by status. A pending one shows who asks, what, why, its risk, its credits and when it expires,
 * and can be approved or rejected by a person with `approval.approve`. Plans are approved in
 * Automations, where their steps are shown; the page links there.
 */

type Tab = 'pending' | 'decided';

type IntlShape = ReturnType<typeof useIntl>;

const label = (intl: IntlShape, prefix: string, code: string) => {
  const id = `${prefix}.${code}`;
  return intl.messages[id] === undefined ? code : intl.formatMessage({ id });
};

/** Errors a decision can meet, each with its own message. */
const DECIDE_ERRORS: ReadonlySet<string> = new Set([
  'approval_not_pending',
  'approval_expired',
  'approval_concurrency_conflict',
  'permission_denied',
]);

export function ApprovalsPage({
  client,
  canDecide,
  canReadPlans,
}: {
  readonly client: ApprovalsClient;
  readonly canDecide: boolean;
  readonly canReadPlans: boolean;
}) {
  const intl = useIntl();
  const { specialists } = useOfficeData();
  const agents = readyList(specialists);
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<readonly ApprovalView[] | 'error' | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ code: string } | undefined>();

  useEffect(() => {
    let live = true;
    client.list().then(
      (list) => live && setItems(list),
      () => live && setItems('error'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  const decide = async (approval: ApprovalView, decision: 'approve' | 'reject') => {
    setBusy(approval.id);
    setNotice(undefined);
    try {
      const updated = await client.decide(approval.id, decision);
      setItems((current) =>
        Array.isArray(current) ? current.map((a) => (a.id === updated.id ? updated : a)) : current,
      );
      setNotice({ code: decision === 'approve' ? 'approved' : 'rejected' });
    } catch (error) {
      const code = error instanceof ApprovalRequestError ? (error.code ?? 'generic') : 'generic';
      setNotice({ code: DECIDE_ERRORS.has(code) ? code : 'generic' });
      // What happened may have changed it: read the list again.
      client.list().then(setItems, () => undefined);
    } finally {
      setBusy(undefined);
    }
  };

  const list = Array.isArray(items) ? items : [];
  const pending = list.filter((a) => a.status === 'pending');
  const decided = list.filter((a) => a.status !== 'pending');
  const shown = tab === 'pending' ? pending : decided;

  return (
    <article className="dept-office approvals-page">
      <h1 className="dept-office__title">
        <FormattedMessage id="approvals.title" />
      </h1>
      <p className="documents__lead">
        <FormattedMessage id="approvals.lead" />
      </p>
      {canReadPlans ? (
        <p className="documents__hint">
          <FormattedMessage id="approvals.plans" />{' '}
          <a
            className="panel__link"
            href={paths.automations()}
            onClick={(event) => {
              event.preventDefault();
              navigate(paths.automations());
            }}
          >
            <FormattedMessage id="nav.automations" />
          </a>
        </p>
      ) : null}
      <div className="memory__domains" role="tablist">
        {(['pending', 'decided'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            className="mo-chip customers__tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            <FormattedMessage id={`approvals.tab.${t}`} />
            {items === undefined || items === 'error' ? null : (
              <span className="customers__count">
                {(t === 'pending' ? pending : decided).length}
              </span>
            )}
          </button>
        ))}
      </div>
      {notice === undefined ? null : (
        <p
          className="panel__empty"
          role={notice.code === 'approved' || notice.code === 'rejected' ? 'status' : 'alert'}
        >
          <FormattedMessage id={`approvals.notice.${notice.code}`} />
        </p>
      )}
      {items === undefined ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="approvals.loading" />
        </p>
      ) : items === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="approvals.error" />
        </p>
      ) : shown.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id={`approvals.none.${tab}`} />
        </p>
      ) : (
        <ul className="documents__list">
          {shown.map((a) => {
            const agent = agents.find((s) => s.id === a.specialist.id);
            return (
              <li key={a.id} className="approval-card">
                <div className="documents__main">
                  <span className="documents__name">
                    {label(intl, 'approvals.tool', a.tool.id)}
                  </span>
                  <span className="documents__meta">
                    <FormattedMessage
                      id="approvals.who"
                      values={{ agent: agent?.displayName ?? a.specialist.id }}
                    />{' '}
                    · {label(intl, 'approvals.action', a.action)}
                  </span>
                  <span className="documents__meta">
                    <FormattedMessage id="approvals.why" />:{' '}
                    {label(intl, 'approvals.reason', a.reason)} ·{' '}
                    {label(intl, 'approvals.impact', a.impact)}
                  </span>
                  <span className="documents__meta">
                    <FormattedMessage
                      id="approvals.risk"
                      values={{ level: label(intl, 'approvals.riskLevel', a.riskLevel) }}
                    />{' '}
                    ·{' '}
                    {a.estimatedCredits === null ? (
                      <FormattedMessage id="approvals.creditsUnknown" />
                    ) : (
                      <FormattedMessage
                        id="approvals.credits"
                        values={{ count: a.estimatedCredits }}
                      />
                    )}
                  </span>
                  <span className="documents__meta">
                    {a.status === 'pending' ? (
                      <FormattedMessage
                        id="approvals.expires"
                        values={{
                          at: intl.formatDate(new Date(a.expiresAt), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }),
                        }}
                      />
                    ) : (
                      <FormattedMessage
                        id={`approvals.status.${a.status}`}
                        values={{
                          at:
                            a.decidedAt === null
                              ? ''
                              : intl.formatDate(new Date(a.decidedAt), {
                                  dateStyle: 'medium',
                                  timeStyle: 'short',
                                }),
                        }}
                      />
                    )}
                  </span>
                </div>
                {a.status === 'pending' && canDecide ? (
                  <div className="customers__actions">
                    <button
                      type="button"
                      className="mo-button mo-button--primary mo-button--sm"
                      disabled={busy !== undefined}
                      onClick={() => void decide(a, 'approve')}
                    >
                      <FormattedMessage id="approvals.approve" />
                    </button>
                    <button
                      type="button"
                      className="mo-button mo-button--danger mo-button--sm"
                      disabled={busy !== undefined}
                      onClick={() => void decide(a, 'reject')}
                    >
                      <FormattedMessage id="approvals.reject" />
                    </button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
