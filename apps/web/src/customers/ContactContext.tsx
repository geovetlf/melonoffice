import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { StateMessage } from '@melonoffice/ui';
import { navigate } from '../identity/router.js';
import { formatMoney, stageName } from '../opportunities/OpportunitiesSection.js';
import { paths } from '../shell/routes.js';
import type { ContactOpportunity, CustomerDetail } from './customersClient.js';

/**
 * A contact's commercial context (C3, ADR-0055), read from where each part already lives: its
 * conversations (the inbox), its opportunities and their stage (the pipeline) and its history
 * (the audit trail). Nothing here is stored or copied; a part the role may not read says so.
 */

type Intl = ReturnType<typeof useIntl>;

const when = (intl: Intl, iso: string) =>
  intl.formatDate(iso, { dateStyle: 'short', timeStyle: 'short' } as never);

const stageOf = (intl: Intl, o: ContactOpportunity) =>
  o.stage === null ? '' : stageName(intl, o.stage);

/** The opportunities still open, the most recently changed first. */
export const openOpportunities = (detail: CustomerDetail) =>
  (detail.opportunities ?? []).filter((o) => o.status === 'open');

function AppLink({ to, children }: { readonly to: string; readonly children: React.ReactNode }) {
  return (
    <a
      className="mo-link"
      href={to}
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function ContactConversations({
  detail,
  current,
}: {
  readonly detail: CustomerDetail;
  /** The conversation already open, which is not linked to itself. */
  readonly current?: string;
}) {
  const intl = useIntl();
  const list = detail.conversations;
  return (
    <section className="crm-context" aria-labelledby={`contact-conversations-${detail.id}`}>
      <h4 id={`contact-conversations-${detail.id}`} className="mo-subsection-title">
        <FormattedMessage id="contact.conversations" />
      </h4>
      {list === null || list === undefined ? (
        <p className="mo-hint">
          <FormattedMessage id="opportunities.conversations.hidden" />
        </p>
      ) : list.length === 0 ? (
        <StateMessage kind="empty" inline>
          <FormattedMessage id="opportunities.conversations.none" />
        </StateMessage>
      ) : (
        <ul className="crm-notes">
          {list.map((c) => {
            const text = (
              <>
                <FormattedMessage id={`conversations.channel.${c.channel}`} /> ·{' '}
                <FormattedMessage id={`conversations.status.${c.status}`} /> ·{' '}
                {when(intl, c.lastMessageAt)}
              </>
            );
            return (
              <li key={c.id}>
                {c.id === current ? (
                  <span aria-current="true">{text}</span>
                ) : (
                  <AppLink to={paths.conversation(c.id)}>{text}</AppLink>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function ContactOpportunities({
  detail,
  today,
}: {
  readonly detail: CustomerDetail;
  readonly today: string;
}) {
  const intl = useIntl();
  const list = detail.opportunities;
  if (list === undefined) return null;
  return (
    <section className="crm-context" aria-labelledby={`contact-opportunities-${detail.id}`}>
      <h4 id={`contact-opportunities-${detail.id}`} className="mo-subsection-title">
        <FormattedMessage id="contact.opportunities" />
      </h4>
      {list === null ? (
        <p className="mo-hint">
          <FormattedMessage id="contact.opportunities.hidden" />
        </p>
      ) : list.length === 0 ? (
        <StateMessage kind="empty" inline>
          <FormattedMessage id="contact.opportunities.none" />
        </StateMessage>
      ) : (
        <ul className="crm-notes contact-opportunities">
          {list.map((o) => {
            const late = o.status === 'open' && o.nextAction !== null && o.nextAction.dueOn < today;
            return (
              <li key={o.id} aria-label={o.title}>
                <p>
                  <strong>{o.title}</strong> · {stageOf(intl, o)}
                  {o.value === null ? null : <> · {formatMoney(intl, o.value)}</>}
                </p>
                <span className="mo-hint">
                  <FormattedMessage id="customers.field.owner" />:{' '}
                  <FormattedMessage id={`customers.owner.${o.owner ?? 'none'}`} />
                  {o.status === 'open' ? (
                    <>
                      {' · '}
                      <FormattedMessage
                        id="contact.opportunity.probability"
                        values={{ value: o.probability }}
                      />
                    </>
                  ) : null}
                  {o.status === 'open' && o.expectedCloseOn !== null ? (
                    <>
                      {' · '}
                      <FormattedMessage id="opportunities.field.expectedClose" />:{' '}
                      {o.expectedCloseOn}
                    </>
                  ) : null}
                  {o.status === 'lost' && o.lostReason !== null ? (
                    <>
                      {' · '}
                      <FormattedMessage id={`opportunities.lost.${o.lostReason}`} />
                    </>
                  ) : null}
                </span>
                {o.status === 'open' && o.nextAction !== null ? (
                  <span className={`crm-next${late ? ' crm-next--late' : ''}`}>
                    {late ? <FormattedMessage id="customers.next.overdue" /> : null}{' '}
                    <FormattedMessage id="customers.field.nextAction" />: {o.nextAction.text} ·{' '}
                    {o.nextAction.dueOn}
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

const contactStage = (stage: string) =>
  stage === 'none' ? 'customers.stage.none' : `customers.stage.${stage}`;

export function ContactHistory({ detail }: { readonly detail: CustomerDetail }) {
  const intl = useIntl();
  const list = detail.history;
  if (list === undefined || list === null) return null;
  const titles = new Map((detail.opportunities ?? []).map((o) => [o.id, o.title]));
  return (
    <section className="crm-context" aria-labelledby={`contact-history-${detail.id}`}>
      <h4 id={`contact-history-${detail.id}`} className="mo-subsection-title">
        <FormattedMessage id="contact.history" />
      </h4>
      {list.length === 0 ? (
        <StateMessage kind="empty" inline>
          <FormattedMessage id="contact.history.none" />
        </StateMessage>
      ) : (
        <ul className="crm-notes">
          {list.map((h) => (
            <li key={h.id}>
              <p>
                {h.opportunityId === null ? (
                  <>
                    <FormattedMessage id={`contact.history.${h.action}`} />
                    {h.action === 'contact.stage_changed' && h.transition !== null ? (
                      <>
                        {' '}
                        (<FormattedMessage id={contactStage(h.transition.from)} /> →{' '}
                        <FormattedMessage id={contactStage(h.transition.to)} />)
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <FormattedMessage id={`opportunities.history.${h.action}`} />
                    {titles.has(h.opportunityId) ? <> · {titles.get(h.opportunityId)}</> : null}
                  </>
                )}
              </p>
              <span className="mo-hint">
                <FormattedMessage id={`opportunities.actor.${h.actor}`} /> · {when(intl, h.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What the Conversations Center shows beside a conversation (C3): who the contact is for the
 * business, its open opportunities and next action, and a link to its full card in Comercial.
 * Only a person changes anything, and only there.
 */
export function CommercialSummary({
  detail,
  today,
}: {
  readonly detail: CustomerDetail;
  readonly today: string;
}) {
  const intl = useIntl();
  const commercial = detail.commercial;
  const open = openOpportunities(detail);
  const next = commercial?.nextAction ?? null;
  return (
    <section
      className="crm-context contact-summary"
      aria-labelledby={`contact-summary-${detail.id}`}
    >
      <h3 id={`contact-summary-${detail.id}`} className="mo-subsection-title">
        <FormattedMessage id="contact.summary" />
      </h3>
      <dl className="agent-facts">
        <div className="agent-facts__row">
          <dt>
            <FormattedMessage id="customers.field.stage" />
          </dt>
          <dd>
            <FormattedMessage id={contactStage(commercial?.stage ?? 'none')} />
          </dd>
        </div>
        <div className="agent-facts__row">
          <dt>
            <FormattedMessage id="customers.field.source" />
          </dt>
          <dd>
            <FormattedMessage id={`customers.source.${commercial?.source ?? detail.origin}`} />
          </dd>
        </div>
        <div className="agent-facts__row">
          <dt>
            <FormattedMessage id="customers.field.owner" />
          </dt>
          <dd>
            <FormattedMessage id={`customers.owner.${commercial?.owner ?? 'none'}`} />
          </dd>
        </div>
        {next === null ? null : (
          <div className="agent-facts__row">
            <dt>
              <FormattedMessage id="customers.field.nextAction" />
            </dt>
            <dd className={next.dueOn < today ? 'crm-next--late' : undefined}>
              {next.dueOn < today ? (
                <>
                  <FormattedMessage id="customers.next.overdue" />{' '}
                </>
              ) : null}
              {next.text} · {next.dueOn}
            </dd>
          </div>
        )}
      </dl>
      {detail.opportunities === null || detail.opportunities === undefined ? null : open.length ===
        0 ? (
        <StateMessage kind="empty" inline>
          <FormattedMessage id="contact.opportunities.noneOpen" />
        </StateMessage>
      ) : (
        <ul className="crm-notes">
          {open.map((o) => (
            <li key={o.id}>
              <strong>{o.title}</strong> · {stageOf(intl, o)}
              {o.value === null ? null : <> · {formatMoney(intl, o.value)}</>}
            </li>
          ))}
        </ul>
      )}
      <AppLink to={paths.customer(detail.id)}>
        <FormattedMessage id="contact.openCard" />
      </AppLink>
    </section>
  );
}
