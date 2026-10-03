import { StateMessage } from '@melonoffice/ui';
import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { periodDays, type AIUsageClient, type UsageSummary } from './aiUsageClient.js';

/** The top `count` keys of a usage breakdown, most credits first. */
const top = (rows: UsageSummary['by'][string], count = 5) =>
  Object.entries(rows ?? {})
    .sort(([, a], [, b]) => b.credits - a.credits)
    .slice(0, count);

/**
 * The organization's plan and credits (D-12, ADR-0123, ADR-0127), above its AI usage: in one
 * sentence what the plan included this period, what was used and what is left; then the plan,
 * what can be spent now, where the balance came from, what running operations hold, the next
 * renewal, and what AI used this month on which agents and functions. Every figure is the API's;
 * what is not decided or not available yet (buying credits) says so and is never made up. Buying
 * credits never requires changing plan.
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
  const usage = month === undefined || month === 'error' ? undefined : month;
  const topAgents = top(usage?.by.agent);
  const topFunctions = top(usage?.by.capability);
  const period = wallet.period ?? undefined;
  const capabilityName = (key: string) => {
    const id = `aiUsage.capability.${key}`;
    return intl.messages[id] === undefined ? key : intl.formatMessage({ id });
  };

  return (
    <section className="mo-panel mo-page-section credits-panel" aria-labelledby="credits-panel">
      <h2 id="credits-panel" className="mo-section-title">
        <FormattedMessage id="credits.panel.title" />
      </h2>
      {period === undefined ? null : (
        <p className="credits-panel__summary">
          <FormattedMessage
            id="credits.panel.summary"
            values={{
              included: period.included,
              used: period.consumed,
              left: wallet.available ?? wallet.balance,
            }}
          />
        </p>
      )}
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
        {period === undefined ? null : (
          <Stat label="credits.panel.consumed">{n(period.consumed)}</Stat>
        )}
        {usage === undefined ? null : (
          <Stat label="credits.panel.usedThisMonth">{n(usage.totals.credits)}</Stat>
        )}
        <Stat label="credits.panel.renewal">
          {period === undefined ? (
            <FormattedMessage id="credits.panel.renewal.pending" />
          ) : (
            intl.formatDate(period.renewsAt, { dateStyle: 'long' })
          )}
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
      {topFunctions.length === 0 ? null : (
        <>
          <h3 className="mo-section-title">
            <FormattedMessage id="credits.panel.byFunction" />
          </h3>
          <ul className="credits-panel__agents">
            {topFunctions.map(([key, bucket]) => (
              <li key={key}>
                <span>{capabilityName(key)}</span>{' '}
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
        <a className="mo-button mo-button--ghost" href="#ai-usage-events">
          <FormattedMessage id="credits.panel.history" />
        </a>{' '}
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
