import { StateMessage } from '@melonoffice/ui';
import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { periodDays, type AIUsageClient, type UsageSummary } from './aiUsageClient.js';

/**
 * The organization's plan and credits (D-12, ADR-0123), above its AI usage: the plan, what can be
 * spent now, where the balance came from, what running operations hold, what the plan includes
 * each month, and what AI used this month and on which agents. Every figure is the API's; what is
 * not decided yet (the renewal date, buying credits) says so and is never made up.
 */
export function CreditsPanel({
  client,
  now = () => new Date(),
}: {
  readonly client: AIUsageClient;
  readonly now?: () => Date;
}) {
  const intl = useIntl();
  const { credits, billing, planLimits, specialists } = useOfficeData();
  const [month, setMonth] = useState<UsageSummary | 'error' | undefined>();

  useEffect(() => {
    let live = true;
    const { from, to } = periodDays('month', now());
    client.summary(from, to).then(
      (value) => live && setMonth(value),
      () => live && setMonth('error'),
    );
    return () => {
      live = false;
    };
    // `now` is read once, when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  if (credits.status === 'hidden') return null;
  if (credits.status === 'loading') return null;
  if (credits.status === 'unavailable' || credits.value.status !== 'present') {
    return (
      <section className="mo-panel mo-page-section" aria-labelledby="credits-panel">
        <h2 id="credits-panel" className="mo-section-title">
          <FormattedMessage id="credits.panel.title" />
        </h2>
        <StateMessage kind="error">
          <FormattedMessage id="credits.panel.unavailable" />
        </StateMessage>
      </section>
    );
  }
  const wallet = credits.value;
  const n = (value: number) => intl.formatNumber(value);
  const planId =
    billing.status === 'ready' && billing.value.status === 'present'
      ? billing.value.subscription.plan.id
      : undefined;
  const planKey = planId === undefined ? undefined : `plan.${planId}.name`;
  const included = planLimits.status === 'ready' ? planLimits.value.monthlyIncluded : undefined;
  const agents = readyList(specialists);
  const topAgents =
    month === undefined || month === 'error'
      ? []
      : Object.entries(month.by.agent ?? {})
          .sort(([, a], [, b]) => b.credits - a.credits)
          .slice(0, 5);

  return (
    <section className="mo-panel mo-page-section credits-panel" aria-labelledby="credits-panel">
      <h2 id="credits-panel" className="mo-section-title">
        <FormattedMessage id="credits.panel.title" />
      </h2>
      <dl className="mo-stats">
        {planKey === undefined ? null : (
          <Stat label="credits.panel.plan">
            {Object.hasOwn(intl.messages, planKey) ? <FormattedMessage id={planKey} /> : planId}
          </Stat>
        )}
        <Stat label="credits.panel.available">{n(wallet.available ?? wallet.balance)}</Stat>
        {wallet.included === undefined ? null : (
          <Stat label="credits.panel.included">{n(wallet.included)}</Stat>
        )}
        {wallet.purchased === undefined ? null : (
          <Stat label="credits.panel.purchased">{n(wallet.purchased)}</Stat>
        )}
        {wallet.reserved === undefined || wallet.reserved === 0 ? null : (
          <Stat label="credits.panel.reserved">{n(wallet.reserved)}</Stat>
        )}
        {included === undefined ? null : (
          <Stat label="credits.panel.monthlyIncluded">
            {included === null ? (
              <FormattedMessage id="credits.panel.monthlyIncluded.none" />
            ) : included === 'unlimited' ? (
              <FormattedMessage id="credits.panel.unlimited" />
            ) : (
              n(included)
            )}
          </Stat>
        )}
        {month === undefined || month === 'error' ? null : (
          <Stat label="credits.panel.usedThisMonth">{n(month.totals.credits)}</Stat>
        )}
        <Stat label="credits.panel.renewal">
          <FormattedMessage id="credits.panel.renewal.pending" />
        </Stat>
      </dl>
      {topAgents.length === 0 ? null : (
        <>
          <h3 className="mo-section-title">
            <FormattedMessage id="credits.panel.byAgent" />
          </h3>
          <ul className="credits-panel__agents">
            {topAgents.map(([id, bucket]) => (
              <li key={id}>
                <span>{agents.find((a) => a.id === id)?.displayName ?? id}</span>{' '}
                <FormattedMessage id="topbar.credits" values={{ count: bucket.credits }} />
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mo-toolbar">
        <button type="button" className="mo-button mo-button--secondary" disabled>
          <FormattedMessage id="credits.panel.buy" />
        </button>{' '}
        <span className="mo-hint">
          <FormattedMessage id="credits.panel.buy.soon" />
        </span>
      </p>
    </section>
  );
}

function Stat({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div className="mo-stat">
      <dt>
        <FormattedMessage id={label} />
      </dt>
      <dd>{children}</dd>
    </div>
  );
}
