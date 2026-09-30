import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { navigate } from '../identity/router.js';
import { LoadMore, usePagedRead, type PagedRead } from '../lists/usePagedRead.js';
import { openedWith, paths } from '../shell/routes.js';
import {
  FOLLOW_UP_TYPES,
  FollowUpRequestError,
  newRequestKey,
  type FollowUpList,
  type FollowUpType,
  type FollowUpView,
  type FollowUpsClient,
} from './followUpsClient.js';

/**
 * Follow-ups in the Comercial office (C5, ADR-0058): what is overdue, due today and coming, the
 * ones of a contact or an opportunity, and the form that schedules one. A person does every
 * change; when a follow-up's time comes the scheduler marks it due and the office's activity
 * shows it. Nothing is sent to the contact.
 */

/** Refusals with their own words; any other is the generic one. */
const KNOWN_ERRORS = new Set([
  'invalid_request',
  'follow_up_not_scheduled',
  'follow_up_scheduler_unavailable',
  'follow_up_limit_reached',
  'follow_up_closed',
  'follow_up_concurrency_conflict',
  'follow_up_not_found',
  'opportunity_closed',
  'contact_not_found',
  'opportunity_not_found',
  'permission_denied',
  'duplicate_request',
  'owner_not_member',
]);
const KNOWN_FIELDS = new Set(['date_in_past', 'date_too_far', 'date', 'time', 'title']);

export const followUpErrorKey = (error: unknown): string => {
  if (!(error instanceof FollowUpRequestError) || error.code === undefined) {
    return 'followUps.error.generic';
  }
  if (error.code === 'invalid_request' && error.field !== undefined) {
    return KNOWN_FIELDS.has(error.field)
      ? `followUps.error.field.${error.field}`
      : 'followUps.error.invalid_request';
  }
  return KNOWN_ERRORS.has(error.code) ? `followUps.error.${error.code}` : 'followUps.error.generic';
};

/** The pages of a filter's follow-ups (ADR-0061); `reload` starts again from the first page. */
function useList(
  client: FollowUpsClient,
  filter: Parameters<FollowUpsClient['list']>[0],
): PagedRead<FollowUpList> & { reload: () => void } {
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const pages = usePagedRead(`${JSON.stringify(filter)}:${version}`, (cursor?: string) =>
    client.list(filter, cursor === undefined ? {} : { cursor }),
  );
  return { ...pages, reload };
}

/** One follow-up: when, what, for whom, and what a person may do with it. */
function FollowUpItem({
  item,
  client,
  canManage,
  onChanged,
  highlighted = false,
}: {
  readonly item: FollowUpView;
  readonly client: FollowUpsClient;
  readonly canManage: boolean;
  readonly onChanged: () => void;
  readonly highlighted?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [moving, setMoving] = useState(false);
  const [date, setDate] = useState(item.date);
  const [time, setTime] = useState(item.time);
  const open = item.status === 'scheduled' || item.status === 'due' || item.status === 'failed';
  async function act(work: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await work();
      setMoving(false);
      onChanged();
    } catch (failure) {
      setError(followUpErrorKey(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <li
      className={`follow-ups__item follow-ups__item--${item.when}${highlighted ? ' follow-ups__item--open' : ''}`}
      aria-label={item.title}
      aria-current={highlighted ? 'true' : undefined}
    >
      <p>
        <strong>{item.title}</strong> · <FormattedMessage id={`followUps.type.${item.type}`} />
      </p>
      <span className="customers__meta">
        {item.date} {item.time} · <FormattedMessage id={`followUps.status.${item.status}`} />
        {open && item.when === 'overdue' ? (
          <>
            {' · '}
            <FormattedMessage id="followUps.when.overdue" />
          </>
        ) : null}
        {item.contactName === undefined || item.contactName === null ? null : (
          <>
            {' · '}
            <a
              className="customers__link"
              href={paths.customer(item.contactId)}
              onClick={(event) => {
                event.preventDefault();
                navigate(paths.customer(item.contactId));
              }}
            >
              {item.contactName}
            </a>
          </>
        )}
        {item.assignee === null ? null : (
          <>
            {' · '}
            <FormattedMessage id={`followUps.assignee.${item.assignee}`} />
          </>
        )}
        {item.source === 'gia' || item.source === 'agent' ? (
          <>
            {' · '}
            <FormattedMessage id={`followUps.source.${item.source}`} />
          </>
        ) : null}
      </span>
      {item.status === 'failed' ? (
        <p className="customers__next customers__next--late">
          <FormattedMessage id="followUps.failed" />
        </p>
      ) : null}
      {canManage ? (
        <div className="customers__actions">
          {open ? (
            <>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => void act(() => client.complete(item.id, item.revision))}
              >
                <FormattedMessage id="followUps.complete" />
              </Button>
              <Button variant="secondary" disabled={pending} onClick={() => setMoving(!moving)}>
                <FormattedMessage id="followUps.reschedule" />
              </Button>
              <Button
                variant="secondary"
                disabled={pending}
                onClick={() => void act(() => client.cancel(item.id, item.revision))}
              >
                <FormattedMessage id="followUps.cancel" />
              </Button>
            </>
          ) : (
            <Button variant="secondary" disabled={pending} onClick={() => setMoving(!moving)}>
              <FormattedMessage id="followUps.reopen" />
            </Button>
          )}
        </div>
      ) : null}
      {moving ? (
        <form
          className="customers__next-edit"
          onSubmit={(event) => {
            event.preventDefault();
            void act(() => client.reschedule(item.id, { revision: item.revision, date, time }));
          }}
        >
          <DateTimeFields date={date} time={time} onDate={setDate} onTime={setTime} />
          <Button type="submit" disabled={pending || date === '' || time === ''}>
            <FormattedMessage id="followUps.saveTime" />
          </Button>
        </form>
      ) : null}
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
    </li>
  );
}

function DateTimeFields({
  date,
  time,
  onDate,
  onTime,
}: {
  readonly date: string;
  readonly time: string;
  readonly onDate: (value: string) => void;
  readonly onTime: (value: string) => void;
}) {
  return (
    <>
      <label>
        <FormattedMessage id="followUps.field.date" />
        <input
          className="gia-chat__input"
          type="date"
          required
          value={date}
          onChange={(e) => onDate(e.target.value)}
        />
      </label>
      <label>
        <FormattedMessage id="followUps.field.time" />
        <input
          className="gia-chat__input"
          type="time"
          required
          value={time}
          onChange={(e) => onTime(e.target.value)}
        />
      </label>
    </>
  );
}

/**
 * The form that schedules a follow-up for a contact, or for one of its opportunities. The time is
 * the person's to give: it starts empty and is required.
 */
export function FollowUpForm({
  client,
  contactId,
  opportunityId,
  initial,
  source = 'manual',
  onDone,
}: {
  readonly client: FollowUpsClient;
  readonly contactId: string;
  readonly opportunityId?: string;
  readonly initial?: {
    readonly type?: FollowUpType;
    readonly title?: string;
    readonly date?: string | null;
    readonly time?: string | null;
  };
  readonly source?: 'manual' | 'gia';
  readonly onDone: (created: FollowUpView | undefined) => void;
}) {
  const intl = useIntl();
  const [type, setType] = useState<FollowUpType>(initial?.type ?? 'follow_up');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [date, setDate] = useState(initial?.date ?? '');
  const [time, setTime] = useState(initial?.time ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // One key per form: sending it again is the same follow-up, never a second one.
  const [requestKey] = useState(newRequestKey);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (title.trim() === '' || date === '' || time === '') return;
    setPending(true);
    setError(undefined);
    try {
      const created = await client.create({
        requestKey,
        contactId,
        ...(opportunityId === undefined ? {} : { opportunityId }),
        type,
        title: title.trim(),
        date,
        time,
        source,
      });
      onDone(created);
    } catch (failure) {
      setError(followUpErrorKey(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <form className="customers__next-edit follow-ups__form" onSubmit={submit}>
      <label>
        <FormattedMessage id="followUps.field.type" />
        <select
          className="gia-chat__input"
          value={type}
          onChange={(e) => setType(e.target.value as FollowUpType)}
        >
          {FOLLOW_UP_TYPES.map((t) => (
            <option key={t} value={t}>
              {intl.formatMessage({ id: `followUps.type.${t}` })}
            </option>
          ))}
        </select>
      </label>
      <label>
        <FormattedMessage id="followUps.field.title" />
        <input
          className="gia-chat__input"
          value={title}
          maxLength={120}
          required
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <DateTimeFields date={date} time={time} onDate={setDate} onTime={setTime} />
      {time === '' ? (
        <p className="customers__meta">
          <FormattedMessage id="followUps.askTime" />
        </p>
      ) : null}
      <div className="customers__actions">
        <Button
          type="submit"
          disabled={pending || title.trim() === '' || date === '' || time === ''}
        >
          <FormattedMessage id={source === 'gia' ? 'followUps.confirm' : 'followUps.schedule'} />
        </Button>
        <Button variant="secondary" disabled={pending} onClick={() => onDone(undefined)}>
          <FormattedMessage id="followUps.discard" />
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
    </form>
  );
}

/**
 * The open follow-ups of one contact (its upcoming follow-ups) or one opportunity (its next
 * follow-up), with the form to schedule another.
 */
export function RecordFollowUps({
  client,
  contactId,
  opportunityId,
  canManage,
  onChanged,
}: {
  readonly client: FollowUpsClient;
  readonly contactId: string;
  readonly opportunityId?: string;
  readonly canManage: boolean;
  readonly onChanged?: () => void;
}) {
  const filter =
    opportunityId === undefined ? { contactId, open: true } : { opportunityId, open: true };
  const pages = useList(client, filter);
  const { list, reload } = pages;
  const [adding, setAdding] = useState(false);
  const changed = () => {
    reload();
    onChanged?.();
  };
  const heading = opportunityId === undefined ? 'followUps.contact' : 'followUps.opportunity';
  return (
    <section aria-labelledby={`follow-ups-${opportunityId ?? contactId}`}>
      <h4 id={`follow-ups-${opportunityId ?? contactId}`}>
        <FormattedMessage id={heading} />
      </h4>
      {list.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="followUps.loading" />
        </p>
      ) : list.status === 'error' ? (
        <p className="panel__empty">
          <FormattedMessage id="followUps.error.load" />
        </p>
      ) : list.value.items.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="followUps.none" />
        </p>
      ) : (
        <ul className="customers__notes follow-ups">
          {(opportunityId === undefined ? list.value.items : list.value.items.slice(0, 1)).map(
            (item) => (
              <FollowUpItem
                key={item.id}
                item={item}
                client={client}
                canManage={canManage}
                onChanged={changed}
              />
            ),
          )}
        </ul>
      )}
      {opportunityId === undefined ? <LoadMore read={pages} /> : null}
      {canManage ? (
        adding ? (
          <FollowUpForm
            client={client}
            contactId={contactId}
            {...(opportunityId === undefined ? {} : { opportunityId })}
            onDone={(created) => {
              setAdding(false);
              if (created !== undefined) changed();
            }}
          />
        ) : (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            <FormattedMessage id="followUps.add" />
          </Button>
        )
      ) : null}
    </section>
  );
}

/**
 * Comercial's pending follow-ups: overdue, today and the next days, the person's own or everyone's.
 * Opened with `?view=follow-ups` it scrolls into view; with `?followUp=` that one is marked.
 */
export function FollowUpsSection({
  client,
  canManage,
}: {
  readonly client: FollowUpsClient;
  readonly canManage: boolean;
}) {
  const [mine, setMine] = useState(false);
  const pages = useList(client, { open: true, ...(mine ? { mine: true } : {}) });
  const { list, reload } = pages;
  const [opened] = useState(() => openedWith('followUp'));
  useEffect(() => {
    if (openedWith('view') !== 'follow-ups') return;
    document.getElementById('follow-ups-title')?.scrollIntoView?.();
  }, []);
  const groups: readonly ('overdue' | 'today' | 'upcoming' | 'later')[] = [
    'overdue',
    'today',
    'upcoming',
    'later',
  ];
  return (
    <section className="dept-office__section follow-ups-section" aria-labelledby="follow-ups-title">
      <div className="customers__header">
        <h2 id="follow-ups-title">
          <FormattedMessage id="followUps.title" />
        </h2>
        <div className="customers__tabs" role="tablist">
          {[false, true].map((value) => (
            <button
              key={String(value)}
              type="button"
              role="tab"
              aria-selected={mine === value}
              className="mo-chip customers__tab"
              onClick={() => setMine(value)}
            >
              <FormattedMessage id={value ? 'followUps.mine' : 'followUps.all'} />
            </button>
          ))}
        </div>
      </div>
      {list.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="followUps.loading" />
        </p>
      ) : list.status === 'error' ? (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id="followUps.error.load" />
        </p>
      ) : list.value.items.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="followUps.empty" />
        </p>
      ) : (
        groups.map((when) => {
          const items = list.value.items.filter((i) => i.when === when);
          if (items.length === 0) return null;
          const { counts } = list.value;
          // How many are in the group in all, not only on the pages loaded.
          const all =
            when === 'later'
              ? Math.max(0, counts.open - counts.overdue - counts.today - counts.upcoming)
              : counts[when];
          return (
            <div key={when}>
              <h3>
                <FormattedMessage id={`followUps.group.${when}`} />{' '}
                <span className="customers__count">{all}</span>
              </h3>
              <ul className="customers__notes follow-ups">
                {items.map((item) => (
                  <FollowUpItem
                    key={item.id}
                    item={item}
                    client={client}
                    canManage={canManage}
                    onChanged={reload}
                    highlighted={item.id === opened}
                  />
                ))}
              </ul>
            </div>
          );
        })
      )}
      <LoadMore read={pages} />
    </section>
  );
}
