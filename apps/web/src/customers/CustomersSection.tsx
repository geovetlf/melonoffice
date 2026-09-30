import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
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

/** Today's date (YYYY-MM-DD) in the business's time zone, to mark a next action as overdue. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

const errorKey = (error: unknown): string =>
  error instanceof CustomerRequestError && error.code !== undefined
    ? `customers.error.${error.code}`
    : 'customers.error.generic';

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
    <section className="dept-office__section customers" aria-labelledby="customers-title">
      <div className="customers__header">
        <h2 id="customers-title">
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
      <div className="customers__tabs" role="tablist">
        {STAGES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === stage}
            className="mo-chip customers__tab"
            onClick={() => setStage(s)}
          >
            <FormattedMessage id={`customers.stage.${s}.plural`} />
            {counts === undefined ? null : <span className="customers__count">{counts[s]}</span>}
          </button>
        ))}
      </div>
      {list.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="customers.loading" />
        </p>
      ) : list.status === 'error' ? (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id="customers.error.load" />
        </p>
      ) : list.value.items.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage
            id={
              STAGES.every((s) => list.value.counts[s] === 0)
                ? 'customers.empty'
                : `customers.empty.${stage}`
            }
          />
        </p>
      ) : (
        <ul className="customers__list">
          {list.value.items.map((c) => {
            const next = c.commercial?.nextAction ?? null;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  className="customers__row"
                  aria-current={c.id === selected ? 'true' : undefined}
                  onClick={() => setSelected(c.id === selected ? undefined : c.id)}
                >
                  <span className="customers__name">{c.displayName ?? c.phone ?? c.email}</span>
                  <span className="customers__meta">{c.phone ?? c.email}</span>
                  {next === null ? null : (
                    <span
                      className={`customers__next${next.dueOn < today ? ' customers__next--late' : ''}`}
                    >
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
      className="customers__form"
      onSubmit={submit}
      aria-label={intl.formatMessage({ id: 'customers.add' })}
    >
      <label>
        <FormattedMessage id="customers.field.name" />
        <input
          className="gia-chat__input"
          value={name}
          maxLength={100}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label>
        <FormattedMessage id="customers.field.phone" />
        <input
          className="gia-chat__input"
          value={phone}
          inputMode="tel"
          placeholder="+51 987 654 321"
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>
      <label>
        <FormattedMessage id="customers.field.email" />
        <input
          className="gia-chat__input"
          value={email}
          type="email"
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error.key} />{' '}
          {error.existing === undefined ? null : (
            <button
              type="button"
              className="customers__link"
              onClick={() => onDone(error.existing)}
            >
              <FormattedMessage id="customers.openExisting" />
            </button>
          )}
        </p>
      )}
      <div className="customers__actions">
        <Button type="submit" disabled={pending}>
          <FormattedMessage id="customers.save" />
        </Button>
        <Button variant="secondary" onClick={() => onDone()}>
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
      <p className="panel__empty" role="status">
        <FormattedMessage id="customers.loading" />
      </p>
    );
  }
  if (detail.status === 'error') {
    return (
      <p className="gia-chat__error" role="alert">
        <FormattedMessage id="customers.error.load" />
      </p>
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
    <article className="customers__card" aria-labelledby="customer-name">
      <h3 id="customer-name">{c.displayName ?? c.phone ?? c.email}</h3>
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
      <fieldset className="customers__edit" disabled={!canManage || pending}>
        <label>
          <FormattedMessage id="customers.field.stage" />
          <select
            className="gia-chat__input"
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
            <label>
              <FormattedMessage id="customers.field.consent" />
              <select
                className="gia-chat__input"
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
            <div className="customers__actions">
              {commercial.owner === 'you' ? (
                <Button variant="secondary" onClick={() => void change({ ownerId: null })}>
                  <FormattedMessage id="customers.owner.release" />
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => void change({ ownerId: currentUserId })}>
                  <FormattedMessage id="customers.owner.take" />
                </Button>
              )}
            </div>
            {commercial.nextAction?.followUpId !== undefined ? (
              // The next action is the earliest open follow-up (ADR-0058): it moves with them.
              <p className={`customers__next${late ? ' customers__next--late' : ''}`}>
                {late ? <FormattedMessage id="customers.next.overdue" /> : null}{' '}
                <FormattedMessage id="customers.field.nextAction" />: {commercial.nextAction.text} ·{' '}
                {commercial.nextAction.dueOn}{' '}
                <span className="customers__meta">
                  <FormattedMessage id="followUps.nextActionFrom" />
                </span>
              </p>
            ) : (
              <div className="customers__next-edit">
                <label>
                  <FormattedMessage id="customers.field.nextAction" />
                  <input
                    className="gia-chat__input"
                    value={nextText}
                    maxLength={200}
                    onChange={(e) => setNextText(e.target.value)}
                  />
                </label>
                <label>
                  <FormattedMessage id="customers.field.dueOn" />
                  <input
                    className="gia-chat__input"
                    type="date"
                    value={nextDue}
                    onChange={(e) => setNextDue(e.target.value)}
                  />
                </label>
                <div className="customers__actions">
                  <Button
                    variant="secondary"
                    disabled={nextText.trim() === '' || nextDue === ''}
                    onClick={() =>
                      void change({ nextAction: { text: nextText.trim(), dueOn: nextDue } })
                    }
                  >
                    <FormattedMessage id="customers.next.save" />
                  </Button>
                  {commercial.nextAction === null ? null : (
                    <Button variant="secondary" onClick={() => void change({ nextAction: null })}>
                      <FormattedMessage id="customers.next.clear" />
                    </Button>
                  )}
                </div>
                {late ? (
                  <p className="customers__next customers__next--late">
                    <FormattedMessage id="customers.next.overdue" />
                  </p>
                ) : null}
              </div>
            )}
          </>
        )}
      </fieldset>
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
        </p>
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
      <h4>
        <FormattedMessage id="customers.notes" />
      </h4>
      {c.notes.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="customers.notes.empty" />
        </p>
      ) : (
        <ul className="customers__notes">
          {c.notes.map((n) => (
            <li key={n.id}>
              <p>{n.text}</p>
              <span className="customers__meta">
                <FormattedMessage id={`customers.owner.${n.author}`} /> ·{' '}
                {intl.formatDate(n.createdAt, { dateStyle: 'short', timeStyle: 'short' } as never)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form className="gia-chat__composer" onSubmit={addNote}>
          <textarea
            className="gia-chat__input"
            value={note}
            maxLength={2000}
            rows={2}
            aria-label={label('customers.notes.add')}
            onChange={(e) => setNote(e.target.value)}
          />
          <Button type="submit" disabled={pending || note.trim() === ''}>
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
