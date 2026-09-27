import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useId, useState } from 'react';
import {
  InboxError,
  PRIORITIES,
  type ConversationDetail,
  type ConversationPriority,
  type ConversationRow,
  type ConversationSort,
  type ConversationStatus,
  type DepartmentOption,
  type InboxClient,
  type InboxQuery,
} from './inboxClient.js';
import { ReplyComposer } from './ReplyComposer.js';

export interface ConversationsCenterProps {
  /** The organization's inbox, through the signed-in person's authenticated requests. */
  readonly client: InboxClient;
  /** The signed-in person, for "assign to me". */
  readonly currentUserId: string;
  /** For tests: where new reply keys come from. */
  readonly newKey?: () => string;
}

type Tab = 'all' | 'new' | ConversationStatus;
const TABS: readonly Tab[] = ['all', 'new', 'open', 'pending', 'closed'];
const SORTS: readonly ConversationSort[] = ['last_activity', 'created', 'priority'];

/** The status moves a person can make from each status (the server checks them again). */
const MOVES: Readonly<Record<ConversationStatus, readonly ConversationStatus[]>> = {
  open: ['pending', 'closed'],
  pending: ['open', 'closed'],
  closed: ['open'],
};

/** "New" is not a status: an open conversation nobody has taken yet. */
const queryOf = (tab: Tab, q: string, sort: ConversationSort): InboxQuery => ({
  ...(tab === 'all' ? {} : tab === 'new' ? { status: 'open', unassigned: true } : { status: tab }),
  ...(q.trim() === '' ? {} : { q }),
  sort,
});

const KNOWN_ERRORS = new Set([
  'permission_denied',
  'invalid_transition',
  'conversation_not_found',
  'assignee_not_member',
  'department_not_found',
]);

/**
 * The Conversations Center (CV-3, ADR-0035): who wrote, what they said, and what a person can do
 * about it. Open a conversation, read it, reply (CV-2, through the tool gate), assign it to
 * yourself or a department, tag it, set its priority and close it. Everything is a person's
 * act: nothing is suggested, routed or sent by AI here.
 */
export function ConversationsCenter({ client, currentUserId, newKey }: ConversationsCenterProps) {
  const intl = useIntl();
  const searchId = useId();
  const sortId = useId();
  const tagId = useId();
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ConversationSort>('last_activity');
  const [rows, setRows] = useState<readonly ConversationRow[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [detail, setDetail] = useState<ConversationDetail | undefined>();
  const [departments, setDepartments] = useState<readonly DepartmentOption[]>([]);
  const [newTag, setNewTag] = useState('');
  const [error, setError] = useState<string | undefined>();

  const fail = (e: unknown) => {
    const code = e instanceof InboxError && KNOWN_ERRORS.has(e.code) ? e.code : 'generic';
    setError(code);
  };

  // Bumped after every change, so the list and the open conversation are read again.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    client.list(queryOf(tab, search, sort)).then(
      (next) => live && setRows(next),
      (e: unknown) => live && fail(e),
    );
    return () => {
      live = false;
    };
  }, [client, tab, search, sort, version]);

  useEffect(() => {
    client.departments().then(setDepartments, () => setDepartments([]));
  }, [client]);

  useEffect(() => {
    if (selected === undefined) return;
    let live = true;
    client.detail(selected).then(
      (next) => live && setDetail(next),
      (e: unknown) => live && fail(e),
    );
    return () => {
      live = false;
    };
  }, [client, selected, version]);

  /** Runs one change on the open conversation, then shows both as they are now. */
  async function act(work: (id: string) => Promise<unknown>) {
    if (detail === undefined) return;
    setError(undefined);
    try {
      await work(detail.conversation.id);
    } catch (e) {
      fail(e);
    }
    setVersion((v) => v + 1);
  }

  const departmentName = (id: string | null): string => {
    const department = departments.find((d) => d.id === id);
    if (department === undefined) return '';
    return department.nameKey === null
      ? (department.name ?? '')
      : intl.formatMessage({ id: department.nameKey });
  };
  const when = (iso: string) =>
    intl.formatDate(iso, { dateStyle: 'short', timeStyle: 'short' } as never);
  const who = (row: ConversationRow) =>
    row.contact?.displayName ??
    row.contact?.phone ??
    intl.formatMessage({ id: 'conversations.contact.unknown' });

  const conversation = detail?.conversation;
  return (
    <section className="inbox" aria-labelledby={`${searchId}-title`}>
      <h1 id={`${searchId}-title`}>
        <FormattedMessage id="conversations.center.title" />
      </h1>
      <div className="inbox__tools">
        <label htmlFor={searchId}>
          <FormattedMessage id="conversations.search.label" />
        </label>
        <input
          id={searchId}
          type="search"
          value={search}
          maxLength={100}
          placeholder={intl.formatMessage({ id: 'conversations.search.placeholder' })}
          onChange={(event) => setSearch(event.target.value)}
        />
        <label htmlFor={sortId}>
          <FormattedMessage id="conversations.sort.label" />
        </label>
        <select
          id={sortId}
          value={sort}
          onChange={(event) => setSort(event.target.value as ConversationSort)}
        >
          {SORTS.map((option) => (
            <option key={option} value={option}>
              {intl.formatMessage({ id: `conversations.sort.${option}` })}
            </option>
          ))}
        </select>
      </div>
      <div className="inbox__tabs" role="tablist">
        {TABS.map((option) => (
          <Button
            key={option}
            role="tab"
            variant="secondary"
            aria-selected={option === tab}
            onClick={() => setTab(option)}
          >
            <FormattedMessage id={`conversations.tab.${option}`} />
          </Button>
        ))}
      </div>
      {error === undefined ? null : (
        <p role="alert">
          <FormattedMessage id={`conversations.error.${error}`} />
        </p>
      )}
      <div className="inbox__panes">
        <ul className="inbox__list" aria-label={intl.formatMessage({ id: 'conversations.list' })}>
          {rows.length === 0 ? (
            <li>
              <FormattedMessage id="conversations.empty" />
            </li>
          ) : null}
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                className="inbox__row"
                aria-current={row.id === selected}
                onClick={() => {
                  setError(undefined);
                  setSelected(row.id);
                }}
              >
                <strong>{who(row)}</strong>
                <span>
                  <FormattedMessage id={`conversations.channel.${row.channel}`} />
                  {' · '}
                  <FormattedMessage id={`conversations.status.${row.status}`} />
                  {row.priority === 'normal' ? null : (
                    <>
                      {' · '}
                      <FormattedMessage id={`conversations.priority.${row.priority}`} />
                    </>
                  )}
                </span>
                <span>{row.lastMessage?.preview ?? ''}</span>
                <span>{when(row.lastMessageAt)}</span>
                <span>
                  {row.tags.map((tag) => (
                    <span key={tag} className="inbox__tag">
                      {tag}
                    </span>
                  ))}
                </span>
                <span>
                  <FormattedMessage
                    id={
                      row.assigneeId === null
                        ? 'conversations.assignment.none'
                        : row.assigneeId === currentUserId
                          ? 'conversations.assignment.me'
                          : 'conversations.assignment.other'
                    }
                  />
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="inbox__detail">
          {detail === undefined || conversation === undefined ? (
            <p>
              <FormattedMessage id="conversations.select" />
            </p>
          ) : (
            <article aria-label={who({ ...conversation, contact: detail.contact })}>
              <h2>{who({ ...conversation, contact: detail.contact })}</h2>
              <dl className="inbox__contact">
                <dt>
                  <FormattedMessage id="conversations.contact.channel" />
                </dt>
                <dd>
                  <FormattedMessage id={`conversations.channel.${detail.identity.channel}`} />
                  {' · '}
                  {detail.identity.externalId}
                </dd>
                {detail.contact.phone === null ? null : (
                  <>
                    <dt>
                      <FormattedMessage id="conversations.contact.phone" />
                    </dt>
                    <dd>{detail.contact.phone}</dd>
                  </>
                )}
                {detail.contact.email === null ? null : (
                  <>
                    <dt>
                      <FormattedMessage id="conversations.contact.email" />
                    </dt>
                    <dd>{detail.contact.email}</dd>
                  </>
                )}
                <dt>
                  <FormattedMessage id="conversations.contact.since" />
                </dt>
                <dd>{when(detail.contact.createdAt)}</dd>
                <dt>
                  <FormattedMessage id="conversations.contact.lastActivity" />
                </dt>
                <dd>{when(conversation.lastMessageAt)}</dd>
              </dl>

              <div className="inbox__actions">
                <span>
                  <FormattedMessage id={`conversations.status.${conversation.status}`} />
                </span>
                {MOVES[conversation.status].map((to) => (
                  <Button
                    key={to}
                    variant="secondary"
                    onClick={() => void act((id) => client.setStatus(id, to))}
                  >
                    <FormattedMessage id={`conversations.move.${to}`} />
                  </Button>
                ))}
                <label>
                  <FormattedMessage id="conversations.priority.label" />
                  <select
                    value={conversation.priority}
                    onChange={(event) => {
                      const priority = event.target.value as ConversationPriority;
                      void act((id) => client.setPriority(id, priority));
                    }}
                  >
                    {PRIORITIES.map((option) => (
                      <option key={option} value={option}>
                        {intl.formatMessage({ id: `conversations.priority.${option}` })}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="inbox__actions">
                <span>
                  <FormattedMessage
                    id={
                      conversation.assigneeId === null
                        ? 'conversations.assignment.none'
                        : conversation.assigneeId === currentUserId
                          ? 'conversations.assignment.me'
                          : 'conversations.assignment.other'
                    }
                  />
                </span>
                {conversation.assigneeId === currentUserId ? null : (
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void act((id) => client.assign(id, { assigneeId: currentUserId }))
                    }
                  >
                    <FormattedMessage id="conversations.assign.me" />
                  </Button>
                )}
                {conversation.assigneeId === null ? null : (
                  <Button
                    variant="secondary"
                    onClick={() => void act((id) => client.assign(id, { assigneeId: null }))}
                  >
                    <FormattedMessage id="conversations.assign.clear" />
                  </Button>
                )}
                <label>
                  <FormattedMessage id="conversations.department.label" />
                  <select
                    value={conversation.departmentId ?? ''}
                    onChange={(event) => {
                      const departmentId = event.target.value === '' ? null : event.target.value;
                      void act((id) => client.assign(id, { departmentId }));
                    }}
                  >
                    <option value="">
                      {intl.formatMessage({ id: 'conversations.department.none' })}
                    </option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {departmentName(d.id)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="inbox__actions">
                <span>
                  <FormattedMessage id="conversations.tags.label" />
                </span>
                {conversation.tags.map((tag) => (
                  <Button
                    key={tag}
                    variant="secondary"
                    aria-label={`${intl.formatMessage({ id: 'conversations.tags.remove' })}: ${tag}`}
                    onClick={() => void act((id) => client.changeTags(id, { remove: [tag] }))}
                  >
                    {tag}
                  </Button>
                ))}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const tag = newTag.trim().toLowerCase();
                    if (tag === '') return;
                    setNewTag('');
                    void act((id) => client.changeTags(id, { add: [tag] }));
                  }}
                >
                  <label htmlFor={tagId}>
                    <FormattedMessage id="conversations.tags.new" />
                  </label>
                  <input
                    id={tagId}
                    value={newTag}
                    maxLength={32}
                    onChange={(event) => setNewTag(event.target.value)}
                  />
                  <Button type="submit" variant="secondary">
                    <FormattedMessage id="conversations.tags.add" />
                  </Button>
                </form>
              </div>

              <ol
                className="inbox__messages"
                aria-label={intl.formatMessage({ id: 'conversations.history' })}
              >
                {detail.messages.map((message) => (
                  <li key={message.id} className={`inbox__message--${message.direction}`}>
                    <span>
                      <FormattedMessage id={`conversations.from.${message.direction}`} />
                      {' · '}
                      {when(message.sentAt)}
                    </span>
                    <p>{message.text ?? ''}</p>
                  </li>
                ))}
              </ol>

              <ReplyComposer
                key={conversation.id}
                {...(newKey === undefined ? {} : { newKey })}
                onSend={async (reply) => {
                  const outcome = await client.reply(conversation.id, reply);
                  setVersion((v) => v + 1);
                  return outcome;
                }}
              />
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
