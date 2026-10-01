import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, Button, StateMessage } from '@melonoffice/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { RecordFollowUps } from '../followUps/FollowUps.js';
import { LoadMore, usePagedRead } from '../lists/usePagedRead.js';
import type { FollowUpsClient } from '../followUps/followUpsClient.js';
import { openedWith } from '../shell/routes.js';
import { ContactConversations, ContactHistory, ContactOpportunities } from './ContactContext.js';
import {
  CONSENTS,
  CustomerRequestError,
  STAGES,
  type Consent,
  type CustomerChange,
  type CustomerDetail,
  type CustomerStage,
  type CustomersClient,
} from './customersClient.js';
import { errorMessage } from '../shell/errors.js';

/** Today's date (YYYY-MM-DD) in the business's time zone, to mark a next action as overdue. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const errorKey = (error: unknown): string => errorMessage(error, CustomerRequestError, 'customers');

type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error' };

/**
 * Customers and leads (C1, ADR-0053), in the Comercial office: the organization's contacts by
 * stage, each one's responsible person, consent, next action and notes, and a form to register a
 * contact. The contacts are the ones the conversations already use; nothing here is an example.
 */
export function CustomersSection({
  client,
  canManage,
  currentUserId,
  timeZone,
  followUps,
}: {
  readonly client: CustomersClient;
  readonly canManage: boolean;
  readonly currentUserId: string;
  readonly timeZone: string;
  /** A contact's upcoming follow-ups (C5), for a role that may read them. */
  readonly followUps?: { readonly client: FollowUpsClient; readonly canManage: boolean };
}) {
  // A tab opened from elsewhere (GIA's links, C4) starts selected.
  const [stage, setStage] = useState<CustomerStage>(() => {
    const opened = openedWith('stage');
    return STAGES.find((s) => s === opened) ?? 'lead';
  });
  // A card opened from elsewhere (the Conversations Center, C3) starts open.
  const [selected, setSelected] = useState<string | undefined>(() => openedWith('contact'));
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  // The pages of this tab and version (ADR-0061): a new tab or a change starts from the first.
  const pages = usePagedRead(`${stage}:${version}`, (cursor?: string) =>
    client.list(stage, cursor === undefined ? {} : { cursor }),
  );
  const list = pages.list;

  const today = todayIn(timeZone);
  const counts = list.status === 'ready' ? list.value.counts : undefined;
  return (
    <section className="mo-panel mo-page-section customers" aria-labelledby="customers-title">
      <div className="mo-page-section__header">
        <h2 id="customers-title" className="mo-section-title">
          <FormattedMessage id="customers.title" />
        </h2>
        {canManage && !creating ? (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            <FormattedMessage id="customers.add" />
          </Button>
        ) : null}
      </div>
      {creating ? (
        <CreateCustomer
          client={client}
          onDone={(id) => {
            setCreating(false);
            if (id !== undefined) {
              setSelected(id);
              reload();
            }
          }}
        />
      ) : null}
      <div className="mo-chips" role="tablist">
        {STAGES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === stage}
            className="mo-chip"
            onClick={() => setStage(s)}
          >
            <FormattedMessage id={`customers.stage.${s}.plural`} />
            {counts === undefined ? null : <Badge>{counts[s]}</Badge>}
          </button>
        ))}
      </div>
      {list.status === 'loading' ? (
        <StateMessage kind="loading">
          <FormattedMessage id="customers.loading" />
        </StateMessage>
      ) : list.status === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="customers.error.load" />
        </StateMessage>
      ) : list.value.items.length === 0 ? (
        <StateMessage kind="empty">
          <FormattedMessage
            id={
              STAGES.every((s) => list.value.counts[s] === 0)
                ? 'customers.empty'
                : `customers.empty.${stage}`
            }
          />
        </StateMessage>
      ) : (
        <ul className="mo-list">
          {list.value.items.map((c) => {
            const next = c.commercial?.nextAction ?? null;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="mo-list-item crm-record"
                  aria-current={c.id === selected ? 'true' : undefined}
                  onClick={() => setSelected(c.id === selected ? undefined : c.id)}
                >
                  <span className="mo-list-item__title">{c.displayName ?? c.phone ?? c.email}</span>
                  <span className="mo-list-item__meta">{c.phone ?? c.email}</span>
                  {next === null ? null : (
                    <span className={`crm-next${next.dueOn < today ? ' crm-next--late' : ''}`}>
                      {next.dueOn < today ? <FormattedMessage id="customers.next.overdue" /> : null}{' '}
                      {next.text} · {next.dueOn}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <LoadMore read={pages} />
      {selected === undefined ? null : (
        <CustomerCard
          key={selected}
          client={client}
          id={selected}
          canManage={canManage}
          currentUserId={currentUserId}
          today={today}
          onChanged={reload}
          {...(followUps === undefined ? {} : { followUps })}
        />
      )}
    </section>
  );
}

function CreateCustomer({
  client,
  onDone,
}: {
  readonly client: CustomersClient;
  readonly onDone: (id?: string) => void;
}) {
  const intl = useIntl();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ key: string; existing?: string } | undefined>();
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === '' || (phone.trim() === '' && email.trim() === '')) {
      setError({ key: 'customers.error.needContact' });
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const created = await client.create({
        displayName: name.trim(),
        ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
        ...(email.trim() === '' ? {} : { email: email.trim() }),
      });
      onDone(created.id);
    } catch (failure) {
      setError({
        key: errorKey(failure),
        ...(failure instanceof CustomerRequestError && failure.contactId !== undefined
          ? { existing: failure.contactId }
          : {}),
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <form
      className="mo-card mo-form crm-form"
      onSubmit={submit}
      aria-label={intl.formatMessage({ id: 'customers.add' })}
    >
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="customers.field.name" />
        </span>
        <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="customers.field.phone" />
        </span>
        <input
          value={phone}
          inputMode="tel"
          placeholder="+51 987 654 321"
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="customers.field.email" />
        </span>
        <input value={email} type="email" onChange={(e) => setEmail(e.target.value)} />
      </label>
      {error === undefined ? null : (
        <StateMessage kind="error" inline>
          <FormattedMessage id={error.key} />{' '}
          {error.existing === undefined ? null : (
            <button type="button" className="mo-link-button" onClick={() => onDone(error.existing)}>
              <FormattedMessage id="customers.openExisting" />
            </button>
          )}
        </StateMessage>
      )}
      <div className="mo-form__actions">
        <Button type="submit" disabled={pending}>
          <FormattedMessage id="customers.save" />
        </Button>
        <Button variant="ghost" onClick={() => onDone()}>
          <FormattedMessage id="customers.cancel" />
        </Button>
      </div>
    </form>
  );
}

function CustomerCard({
  client,
  id,
  canManage,
  currentUserId,
  today,
  onChanged,
  followUps,
}: {
  readonly client: CustomersClient;
  readonly id: string;
  readonly canManage: boolean;
  readonly currentUserId: string;
  readonly today: string;
  readonly onChanged: () => void;
  readonly followUps?: { readonly client: FollowUpsClient; readonly canManage: boolean };
}) {
  const intl = useIntl();
  const [detail, setDetail] = useState<Load<CustomerDetail>>({ status: 'loading' });
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [note, setNote] = useState('');
  const [nextText, setNextText] = useState('');
  const [nextDue, setNextDue] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    client.get(id).then(
      (value) => {
        if (!live) return;
        setDetail({ status: 'ready', value });
        setNextText(value.commercial?.nextAction?.text ?? '');
        setNextDue(value.commercial?.nextAction?.dueOn ?? '');
      },
      () => live && setDetail({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [client, id, version]);

  if (detail.status === 'loading') {
    return (
      <StateMessage kind="loading">
        <FormattedMessage id="customers.loading" />
      </StateMessage>
    );
  }
  if (detail.status === 'error') {
    return (
      <StateMessage kind="error">
        <FormattedMessage id="customers.error.load" />
      </StateMessage>
    );
  }
  const c = detail.value;
  const commercial = c.commercial;

  async function change(patch: Omit<CustomerChange, 'revision'>) {
    setPending(true);
    setError(undefined);
    try {
      await client.update(id, { revision: c.revision, ...patch });
      onChanged();
      setVersion((v) => v + 1);
    } catch (failure) {
      setError(errorKey(failure));
      if (
        failure instanceof CustomerRequestError &&
        failure.code === 'contact_concurrency_conflict'
      ) {
        setVersion((v) => v + 1);
      }
    } finally {
      setPending(false);
    }
  }
  async function addNote(event: FormEvent) {
    event.preventDefault();
    if (note.trim() === '') return;
    setPending(true);
    setError(undefined);
    try {
      await client.addNote(id, note.trim());
      setNote('');
      setVersion((v) => v + 1);
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(false);
    }
  }
  const late = commercial?.nextAction != null && commercial.nextAction.dueOn < today;
  const label = (key: string) => intl.formatMessage({ id: key });
  return (
    <article className="mo-card crm-card" aria-labelledby="customer-name">
      <h3 id="customer-name" className="mo-subsection-title">
        {c.displayName ?? c.phone ?? c.email}
      </h3>
      <dl className="agent-facts">
        {c.phone === null ? null : <Fact term="customers.field.phone" value={c.phone} />}
        {c.email === null ? null : <Fact term="customers.field.email" value={c.email} />}
        <Fact
          term="customers.field.source"
          value={label(`customers.source.${commercial?.source ?? c.origin}`)}
        />
        <Fact
          term="customers.field.owner"
          value={label(`customers.owner.${commercial?.owner ?? 'none'}`)}
        />
      </dl>
      <fieldset className="mo-form crm-fieldset" disabled={!canManage || pending}>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="customers.field.stage" />
          </span>
          <select
            value={commercial?.stage ?? ''}
            onChange={(e) => void change({ stage: e.target.value as CustomerStage })}
          >
            {commercial === null ? <option value="">{label('customers.stage.none')}</option> : null}
            {STAGES.map((s) => (
              <option key={s} value={s}>
                {label(`customers.stage.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {commercial === null ? null : (
          <>
            <label className="mo-field">
              <span className="mo-label">
                <FormattedMessage id="customers.field.consent" />
              </span>
              <select
                value={commercial.consent}
                onChange={(e) =>
                  void change({
                    consent: { messaging: e.target.value as Consent, recordedBy: 'member' },
                  })
                }
              >
                {CONSENTS.map((s) => (
                  <option key={s} value={s}>
                    {label(`customers.consent.${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <div className="mo-form__actions">
              {commercial.owner === 'you' ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void change({ ownerId: null })}
                >
                  <FormattedMessage id="customers.owner.release" />
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void change({ ownerId: currentUserId })}
                >
                  <FormattedMessage id="customers.owner.take" />
                </Button>
              )}
            </div>
            {commercial.nextAction?.followUpId !== undefined ? (
              // The next action is the earliest open follow-up (ADR-0058): it moves with them.
              <p className={`crm-next${late ? ' crm-next--late' : ''}`}>
                {late ? <FormattedMessage id="customers.next.overdue" /> : null}{' '}
                <FormattedMessage id="customers.field.nextAction" />: {commercial.nextAction.text} ·{' '}
                {commercial.nextAction.dueOn}{' '}
                <span className="mo-hint">
                  <FormattedMessage id="followUps.nextActionFrom" />
                </span>
              </p>
            ) : (
              <div className="mo-form">
                <label className="mo-field">
                  <span className="mo-label">
                    <FormattedMessage id="customers.field.nextAction" />
                  </span>
                  <input
                    value={nextText}
                    maxLength={200}
                    onChange={(e) => setNextText(e.target.value)}
                  />
                </label>
                <label className="mo-field">
                  <span className="mo-label">
                    <FormattedMessage id="customers.field.dueOn" />
                  </span>
                  <input type="date" value={nextDue} onChange={(e) => setNextDue(e.target.value)} />
                </label>
                <div className="mo-form__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={nextText.trim() === '' || nextDue === ''}
                    onClick={() =>
                      void change({ nextAction: { text: nextText.trim(), dueOn: nextDue } })
                    }
                  >
                    <FormattedMessage id="customers.next.save" />
                  </Button>
                  {commercial.nextAction === null ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void change({ nextAction: null })}
                    >
                      <FormattedMessage id="customers.next.clear" />
                    </Button>
                  )}
                </div>
                {late ? (
                  <p className="crm-next crm-next--late">
                    <FormattedMessage id="customers.next.overdue" />
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </fieldset>
      {error === undefined ? null : (
        <StateMessage kind="error" inline>
          <FormattedMessage id={error} />
        </StateMessage>
      )}
      <ContactConversations detail={c} />
      <ContactOpportunities detail={c} today={today} />
      {followUps === undefined ? null : (
        <RecordFollowUps
          client={followUps.client}
          contactId={c.id}
          canManage={followUps.canManage}
          onChanged={() => {
            onChanged();
            setVersion((v) => v + 1);
          }}
        />
      )}
      <h4 className="mo-subsection-title">
        <FormattedMessage id="customers.notes" />
      </h4>
      {c.notes.length === 0 ? (
        <StateMessage kind="empty" inline>
          <FormattedMessage id="customers.notes.empty" />
        </StateMessage>
      ) : (
        <ul className="crm-notes">
          {c.notes.map((n) => (
            <li key={n.id}>
              <p>{n.text}</p>
              <span className="mo-hint">
                <FormattedMessage id={`customers.owner.${n.author}`} /> ·{' '}
                {intl.formatDate(n.createdAt, { dateStyle: 'short', timeStyle: 'short' } as never)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form className="crm-composer" onSubmit={addNote}>
          <textarea
            value={note}
            maxLength={2000}
            rows={2}
            aria-label={label('customers.notes.add')}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button variant="secondary" type="submit" disabled={pending || note.trim() === ''}>
            <FormattedMessage id="customers.notes.add" />
          </Button>
        </form>
      ) : null}
      <ContactHistory detail={c} />
    </article>
  );
}

function Fact({ term, value }: { readonly term: string; readonly value: string }) {
  return (
    <div className="agent-facts__row">
      <dt>
        <FormattedMessage id={term} />
      </dt>
      <dd>{value}</dd>
    </div>
  );
}
