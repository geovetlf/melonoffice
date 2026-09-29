import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState, type ReactNode } from 'react';
import { periodDays, type AIUsageClient, type UsageSummary } from '../aiUsage/aiUsageClient.js';
import type { ApprovalsClient } from '../approvals/approvalsClient.js';
import type { AutomationsClient, PlanView } from '../automations/automationsClient.js';
import { navigate } from '../identity/router.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { paths } from '../shell/routes.js';

/**
 * The AI Command Center (block 9): the company's AI operation on one screen, read from the
 * systems that already hold it: AI usage in credits (ADR-0074/0081; never provider, model or internal cost, ADR-0082), the credit wallet (ADR-0023),
 * approvals waiting (ADR-0026), agents by state (ADR-0025) and plans in flight (ADR-0028). Each
 * card reads with the person's own permission and opens the screen where the work is done. It
 * holds no data of its own and decides nothing.
 */

type Load<T> = T | 'loading' | 'error';

function useLoad<T>(load: (() => Promise<T>) | undefined): Load<T> | undefined {
  const [value, setValue] = useState<Load<T> | undefined>(
    load === undefined ? undefined : 'loading',
  );
  useEffect(() => {
    if (load === undefined) return;
    let live = true;
    load().then(
      (v) => live && setValue(v),
      () => live && setValue('error'),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return value;
}

/** How many capabilities the AI card lists. */
const TOP = 3;

export function CommandCenterPage({
  aiUsage,
  approvals,
  automations,
  now = () => new Date(),
}: {
  /** With `ai_usage.read`. */
  readonly aiUsage?: AIUsageClient | undefined;
  /** With `approval.read`. */
  readonly approvals?: ApprovalsClient | undefined;
  /** With `plan.read`. */
  readonly automations?: AutomationsClient | undefined;
  readonly now?: () => Date;
}) {
  const intl = useIntl();
  const { specialists, credits } = useOfficeData();
  const [month] = useState(() => periodDays('month', now()));
  const [loadUsage] = useState(() =>
    aiUsage === undefined ? undefined : () => aiUsage.summary(month.from, month.to),
  );
  const usage = useLoad<UsageSummary>(loadUsage);
  const waiting = useLoad(approvals?.list);
  const plans = useLoad<readonly PlanView[]>(automations?.plans);

  const agents = readyList(specialists);
  const count = (status: string) => agents.filter((a) => a.status === status).length;

  return (
    <article className="dept-office command-center">
      <h1 className="dept-office__title">
        <FormattedMessage id="commandCenter.title" />
      </h1>
      <p className="documents__lead">
        <FormattedMessage id="commandCenter.lead" />
      </p>
      <div className="command-center__grid">
        {usage === undefined ? null : (
          <Card
            titleId="commandCenter.ai.title"
            action="commandCenter.ai.open"
            to={paths.aiUsage()}
          >
            {usage === 'loading' ? (
              <Loading />
            ) : usage === 'error' ? (
              <Failed />
            ) : usage.totals.operations === 0 ? (
              <p className="panel__empty">
                <FormattedMessage id="commandCenter.ai.none" />
              </p>
            ) : (
              <>
                <dl className="command-center__figures">
                  <Figure
                    labelId="aiUsage.credits"
                    value={intl.formatNumber(usage.totals.credits)}
                  />
                  <Figure
                    labelId="aiUsage.operations"
                    value={intl.formatNumber(usage.totals.operations)}
                  />
                </dl>
                <ul className="command-center__list">
                  {Object.entries(usage.by.capability ?? {})
                    .sort(([, a], [, b]) => b.operations - a.operations)
                    .slice(0, TOP)
                    .map(([capability, bucket]) => (
                      <li key={capability}>
                        {Object.hasOwn(intl.messages, `aiUsage.capability.${capability}`)
                          ? intl.formatMessage({ id: `aiUsage.capability.${capability}` })
                          : capability}
                        {' · '}
                        <FormattedMessage
                          id="commandCenter.ai.row"
                          values={{ operations: bucket.operations, credits: bucket.credits }}
                        />
                      </li>
                    ))}
                </ul>
              </>
            )}
          </Card>
        )}
        {credits.status === 'hidden' ? null : (
          <Card titleId="commandCenter.credits.title">
            {credits.status === 'loading' ? (
              <Loading />
            ) : credits.status === 'ready' && credits.value.status === 'present' ? (
              <p className="command-center__big">
                <FormattedMessage
                  id="commandCenter.credits.balance"
                  values={{ balance: credits.value.balance }}
                />
              </p>
            ) : (
              <Failed />
            )}
          </Card>
        )}
        {waiting === undefined ? null : (
          <Card
            titleId="commandCenter.approvals.title"
            action="commandCenter.approvals.open"
            to={paths.approvals()}
          >
            {waiting === 'loading' ? (
              <Loading />
            ) : waiting === 'error' ? (
              <Failed />
            ) : (
              <p className="command-center__big">
                <FormattedMessage
                  id="commandCenter.approvals.count"
                  values={{ count: waiting.filter((a) => a.status === 'pending').length }}
                />
              </p>
            )}
          </Card>
        )}
        {specialists.status === 'hidden' ? null : (
          <Card
            titleId="commandCenter.agents.title"
            action="commandCenter.agents.open"
            to={paths.agents()}
          >
            {specialists.status === 'loading' ? (
              <Loading />
            ) : specialists.status !== 'ready' ? (
              <Failed />
            ) : (
              <dl className="command-center__figures">
                <Figure labelId="agents.status.active" value={intl.formatNumber(count('active'))} />
                <Figure labelId="agents.status.draft" value={intl.formatNumber(count('draft'))} />
                <Figure
                  labelId="agents.status.paused"
                  value={intl.formatNumber(count('paused') + count('disabled'))}
                />
              </dl>
            )}
          </Card>
        )}
        {plans === undefined ? null : (
          <Card
            titleId="commandCenter.plans.title"
            action="commandCenter.plans.open"
            to={paths.automations()}
          >
            {plans === 'loading' ? (
              <Loading />
            ) : plans === 'error' ? (
              <Failed />
            ) : (
              <dl className="command-center__figures">
                <Figure
                  labelId="automations.planStatus.approval_required"
                  value={intl.formatNumber(
                    plans.filter((p) => p.status === 'approval_required').length,
                  )}
                />
                <Figure
                  labelId="automations.planStatus.executing"
                  value={intl.formatNumber(
                    plans.filter((p) => p.status === 'executing' || p.status === 'approved').length,
                  )}
                />
                <Figure
                  labelId="automations.planStatus.failed"
                  value={intl.formatNumber(plans.filter((p) => p.status === 'failed').length)}
                />
              </dl>
            )}
          </Card>
        )}
      </div>
    </article>
  );
}

function Card({
  titleId,
  action,
  to,
  children,
}: {
  readonly titleId: string;
  readonly action?: string;
  readonly to?: string;
  readonly children: ReactNode;
}) {
  const id = `cc-${titleId.replaceAll('.', '-')}`;
  return (
    <section className="dept-office__section command-center__card" aria-labelledby={id}>
      <h2 id={id}>
        <FormattedMessage id={titleId} />
      </h2>
      {children}
      {action === undefined || to === undefined ? null : (
        <button type="button" className="panel__link" onClick={() => navigate(to)}>
          <FormattedMessage id={action} />
        </button>
      )}
    </section>
  );
}

function Figure({ labelId, value }: { readonly labelId: string; readonly value: string }) {
  return (
    <div className="command-center__figure">
      <dt>
        <FormattedMessage id={labelId} />
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

const Loading = () => (
  <p className="panel__empty" role="status">
    <FormattedMessage id="aiUsage.loading" />
  </p>
);

const Failed = () => (
  <p className="panel__empty" role="alert">
    <FormattedMessage id="commandCenter.error" />
  </p>
);
