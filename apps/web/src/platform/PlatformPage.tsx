import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, DataTable, PageHeader, PeriodPicker, StateMessage, Toolbar } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import { usd } from '../aiUsage/AIUsagePage.js';
import { periodDays, type UsagePeriod } from '../aiUsage/aiUsageClient.js';
import { CommercialAdmin } from './CommercialAdmin.js';
import type {
  PlatformAI,
  PlatformBucket,
  PlatformClient,
  PlatformPricing,
  PlatformUsage,
} from './platformClient.js';

/**
 * The platform AI view (ADR-0082), for the MelonOffice platform administrator only: AI providers
 * and their health, models with their price and terms, routing and fallback policies, and every
 * organization's AI usage with MelonOffice's internal cost next to the credits it charged. Read
 * only, from the one AI Gateway's registry and the one usage ledger. Companies never see it.
 */

type IntlShape = ReturnType<typeof useIntl>;
type Load<T> = T | 'loading' | 'error';

const PERIODS: readonly UsagePeriod[] = ['today', 'week', 'month'];

/** A provider's health as a badge's tone. */
const HEALTH_TONE = { available: 'success', degraded: 'warning', unavailable: 'danger' } as const;

export function PlatformPage({
  client,
  now = () => new Date(),
  currentUserId,
}: {
  readonly client: PlatformClient;
  readonly now?: () => Date;
  /** The administrator's own id, offered as a new account's first admin. */
  readonly currentUserId?: string;
}) {
  const intl = useIntl();
  const [ai, setAI] = useState<Load<PlatformAI>>('loading');
  const [period, setPeriod] = useState<UsagePeriod>('month');
  const [usage, setUsage] = useState<{ key: UsagePeriod; load: Load<PlatformUsage> }>();

  useEffect(() => {
    let live = true;
    client.ai().then(
      (value) => live && setAI(value),
      () => live && setAI('error'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    let live = true;
    const { from, to } = periodDays(period, now());
    client.usage(from, to).then(
      (value) => live && setUsage({ key: period, load: value }),
      () => live && setUsage({ key: period, load: 'error' }),
    );
    return () => {
      live = false;
    };
    // `now` is read when the period changes; it is not a dependency of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, period]);

  const load: Load<PlatformUsage> = usage?.key === period ? usage.load : 'loading';

  return (
    <article className="mo-page platform">
      <PageHeader
        title={<FormattedMessage id="platform.title" />}
        description={<FormattedMessage id="platform.lead" />}
      />

      <CommercialAdmin
        client={client}
        {...(currentUserId === undefined ? {} : { currentUserId })}
      />

      {ai === 'loading' ? (
        <Loading />
      ) : ai === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="platform.error" />
        </StateMessage>
      ) : (
        <>
          <section className="mo-panel mo-page-section" aria-labelledby="platform-providers">
            <h2 id="platform-providers" className="mo-section-title">
              <FormattedMessage id="platform.providers.title" />
            </h2>
            <p className="mo-lead">
              <FormattedMessage
                id="platform.environment"
                values={{ environment: ai.environment ?? '—' }}
              />
            </p>
            {ai.providers.length === 0 ? (
              <StateMessage kind="empty">
                <FormattedMessage id="platform.providers.none" />
              </StateMessage>
            ) : (
              <ul className="mo-list">
                {ai.providers.map((p) => (
                  <li key={p.id} className="mo-list-item" data-health={p.health}>
                    <div className="mo-list-item__main">
                      <div className="mo-list-item__heading">
                        <span className="mo-list-item__title">{p.name}</span>
                        <Badge tone={HEALTH_TONE[p.health]}>
                          <FormattedMessage id={`platform.health.${p.health}`} />
                        </Badge>
                      </div>
                      <span className="mo-list-item__meta">
                        {p.id} · {p.environments.join(', ')} ·{' '}
                        <FormattedMessage
                          id="platform.sensitivity"
                          values={{ level: p.maxSensitivity }}
                        />
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mo-hint">
              <FormattedMessage id="platform.health.note" />
            </p>
          </section>

          <section className="mo-panel mo-page-section" aria-labelledby="platform-models">
            <h2 id="platform-models" className="mo-section-title">
              <FormattedMessage id="platform.models.title" />
            </h2>
            {ai.models.length === 0 ? (
              <StateMessage kind="empty">
                <FormattedMessage id="platform.models.none" />
              </StateMessage>
            ) : (
              <DataTable label={intl.formatMessage({ id: 'platform.models.title' })}>
                <thead>
                  <tr>
                    <th scope="col">
                      <FormattedMessage id="platform.models.model" />
                    </th>
                    <th scope="col">
                      <FormattedMessage id="platform.models.price" />
                    </th>
                    <th scope="col">
                      <FormattedMessage id="platform.models.terms" />
                    </th>
                    <th scope="col">
                      <FormattedMessage id="platform.models.environments" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {ai.models.map((m) => (
                    <tr key={`${m.providerId}/${m.modelId}`}>
                      <th scope="row">
                        {m.displayName ?? m.modelId}
                        <span className="mo-hint">
                          {' '}
                          {m.providerId}/{m.modelId}@{m.version}
                        </span>
                      </th>
                      <td>
                        <Price intl={intl} pricing={m.pricing} />
                      </td>
                      <td>
                        {m.terms === null ? (
                          <FormattedMessage id="platform.models.noTerms" />
                        ) : (
                          <FormattedMessage
                            id="platform.models.termsValue"
                            values={{
                              offering: m.terms.offering,
                              production: m.terms.production,
                            }}
                          />
                        )}
                      </td>
                      <td>{m.environments.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
            )}
          </section>

          <section className="mo-panel mo-page-section" aria-labelledby="platform-routing">
            <h2 id="platform-routing" className="mo-section-title">
              <FormattedMessage id="platform.routing.title" />
            </h2>
            <ul className="mo-list">
              {ai.policies.map((p) => (
                <li key={`${p.id}@${p.version}`} className="mo-list-item">
                  <div className="mo-list-item__main">
                    <span className="mo-list-item__title">
                      {p.id} v{p.version}
                    </span>
                    <span className="mo-list-item__meta">
                      {p.allowedModels === null ? (
                        <FormattedMessage id="platform.routing.anyModel" />
                      ) : (
                        p.allowedModels.join(', ')
                      )}
                      {' · '}
                      <FormattedMessage id={`platform.routing.fallback.${p.fallback}`} />
                      {' · '}
                      <FormattedMessage
                        id="platform.routing.attempts"
                        values={{ count: p.maxAttempts }}
                      />
                      {p.maxCostMicroUsd === null ? null : (
                        <>
                          {' · '}
                          <FormattedMessage
                            id="platform.routing.maxCost"
                            values={{ cost: usd(intl, p.maxCostMicroUsd) }}
                          />
                        </>
                      )}
                      {' · '}
                      {p.environments.join(', ')}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <section className="mo-panel mo-page-section" aria-labelledby="platform-usage">
        <h2 id="platform-usage" className="mo-section-title">
          <FormattedMessage id="platform.usage.title" />
        </h2>
        <Toolbar>
          <PeriodPicker
            label={intl.formatMessage({ id: 'aiUsage.period' })}
            options={PERIODS}
            value={period}
            onChange={setPeriod}
            renderOption={(p) => <FormattedMessage id={`aiUsage.period.${p}`} />}
          />
        </Toolbar>
        {load === 'loading' ? (
          <Loading />
        ) : load === 'error' ? (
          <StateMessage kind="error">
            <FormattedMessage id="platform.usage.error" />
          </StateMessage>
        ) : (
          <>
            <p className="mo-hint">
              <FormattedMessage id="aiUsage.range" values={{ from: load.from, to: load.to }} />
            </p>
            <dl className="mo-stats">
              <Total labelId="aiUsage.internalCost" value={usd(intl, load.totals.costMicroUsd)} />
              <Total labelId="aiUsage.credits" value={intl.formatNumber(load.totals.credits)} />
              <Total
                labelId="aiUsage.operations"
                value={intl.formatNumber(load.totals.operations)}
              />
              {load.totals.unpricedOperations > 0 ? (
                <p className="mo-hint platform__note">
                  <FormattedMessage
                    id="aiUsage.unpriced"
                    values={{ count: load.totals.unpricedOperations }}
                  />
                </p>
              ) : null}
            </dl>
            {load.totals.operations === 0 ? (
              <StateMessage kind="empty">
                <FormattedMessage id="aiUsage.none" />
              </StateMessage>
            ) : (
              <div className="platform__breakdowns">
                <Breakdown
                  intl={intl}
                  titleId="platform.usage.byOrganization"
                  rows={load.byOrganization.map((o) => [o.name ?? o.organizationId, o])}
                />
                <Breakdown
                  intl={intl}
                  titleId="aiUsage.by.provider"
                  rows={Object.entries(load.by.provider ?? {})}
                />
                <Breakdown
                  intl={intl}
                  titleId="aiUsage.by.model"
                  rows={Object.entries(load.by.model ?? {})}
                />
              </div>
            )}
          </>
        )}
      </section>
    </article>
  );
}

function Price({ intl, pricing }: { readonly intl: IntlShape; readonly pricing: PlatformPricing }) {
  if (pricing.status !== 'known') return <FormattedMessage id="aiUsage.priceUnknown" />;
  return (
    <FormattedMessage
      id="platform.models.priceValue"
      values={{
        input: usd(intl, pricing.inputMicroUsdPerMillionTokens),
        output: usd(intl, pricing.outputMicroUsdPerMillionTokens),
      }}
    />
  );
}

function Total({ labelId, value }: { readonly labelId: string; readonly value: string }) {
  return (
    <div className="mo-stat">
      <dt>
        <FormattedMessage id={labelId} />
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

function Breakdown({
  intl,
  titleId,
  rows,
}: {
  readonly intl: IntlShape;
  readonly titleId: string;
  readonly rows: readonly (readonly [string, PlatformBucket])[];
}) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort(
    ([, a], [, b]) => b.costMicroUsd - a.costMicroUsd || b.operations - a.operations,
  );
  const id = `platform-${titleId.replaceAll('.', '-')}`;
  return (
    <section className="platform__breakdown" aria-labelledby={id}>
      <h3 id={id} className="mo-subsection-title">
        <FormattedMessage id={titleId} />
      </h3>
      <DataTable label={intl.formatMessage({ id: titleId })}>
        <thead>
          <tr>
            <th scope="col">
              <FormattedMessage id={titleId} />
            </th>
            <th scope="col" className="mo-table__num">
              <FormattedMessage id="aiUsage.operations" />
            </th>
            <th scope="col" className="mo-table__num">
              <FormattedMessage id="aiUsage.internalCost" />
            </th>
            <th scope="col" className="mo-table__num">
              <FormattedMessage id="aiUsage.credits" />
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map(([key, bucket], index) => (
            // Two organizations can share a name: the row is its place, the label its name.
            <tr key={`${index}-${key}`}>
              <th scope="row">{key}</th>
              <td className="mo-table__num">{intl.formatNumber(bucket.operations)}</td>
              <td className="mo-table__num">
                {usd(intl, bucket.costMicroUsd)}
                {bucket.unpricedOperations > 0 ? ' *' : ''}
              </td>
              <td className="mo-table__num">{intl.formatNumber(bucket.credits)}</td>
            </tr>
          ))}
        </tbody>
      </DataTable>
    </section>
  );
}

const Loading = () => (
  <StateMessage kind="loading">
    <FormattedMessage id="aiUsage.loading" />
  </StateMessage>
);
