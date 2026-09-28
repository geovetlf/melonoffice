import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { formatMoney, minorDigits, toMinor } from '../opportunities/OpportunitiesSection.js';
import { useRead } from '../shell/useRead.js';
import {
  KNOWLEDGE_DOMAINS,
  MemoryRequestError,
  keyFor,
  type KnowledgeConflict,
  type KnowledgeDomain,
  type KnowledgeItem,
  type KnowledgeSummary,
  type KnowledgeValue,
  type KnowledgeVersion,
  type MemoryClient,
} from './memoryClient.js';

/**
 * The company's memory (ADR-0056): where a person reads, completes and corrects what Company
 * Brain (ADR-0051) knows about the business. It is the same knowledge GIA reads and proposes to,
 * so a fact GIA proposed from a chat is confirmed or corrected here, and a fact typed here is
 * what GIA answers with. Every change goes through Company Brain's own service: its origin,
 * state, date, versions, audit and permissions are the service's, never the screen's.
 */

type Intl = ReturnType<typeof useIntl>;

/** How many of the latest changes the history of changes shows. */
const RECENT_CHANGES = 30;

const errorKey = (error: unknown): string =>
  error instanceof MemoryRequestError && error.code !== undefined
    ? `memory.error.${error.code}`
    : 'memory.error.generic';

/** A fact's name: its own label, the catalogue's name for its key, or the key made readable. */
export function factName(
  intl: Intl,
  item: Pick<KnowledgeItem, 'domain' | 'key' | 'label'>,
): string {
  if (item.label !== null) return item.label;
  const id = `memory.key.${item.domain}.${item.key}`;
  if (Object.hasOwn(intl.messages, id)) return intl.formatMessage({ id });
  const words = item.key.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatValue(intl: Intl, value: KnowledgeValue | undefined): string {
  if (value === undefined) return intl.formatMessage({ id: 'memory.value.hidden' });
  switch (value.type) {
    case 'text':
      return value.text;
    case 'number':
      return `${intl.formatNumber(value.number)}${value.unit === undefined ? '' : ` ${value.unit}`}`;
    case 'money':
      return formatMoney(intl, value);
    case 'boolean':
      return intl.formatMessage({ id: value.value ? 'memory.value.yes' : 'memory.value.no' });
    case 'list':
      return value.items.join(' · ');
    case 'date':
      return intl.formatDate(`${value.date}T12:00:00Z`, { dateStyle: 'medium' } as never);
  }
}

const when = (intl: Intl, iso: string) =>
  intl.formatDate(iso, { dateStyle: 'short', timeStyle: 'short' } as never);

/** What only another place changes: the business profile's own fields, and calculated totals. */
const managedElsewhere = (item: KnowledgeItem): 'profile' | 'calculated' | undefined =>
  item.source.id === 'business_profile'
    ? 'profile'
    : item.verification === 'calculated'
      ? 'calculated'
      : undefined;

export function MemoryPage({
  client,
  can,
  business,
}: {
  readonly client: MemoryClient;
  readonly can: (permission: string) => boolean;
  /** The business profile form (ADR-0048), for a member who may read it. */
  readonly business?: ReactNode;
}) {
  const readsKnowledge = can('knowledge.read');
  const canPropose = can('knowledge.propose');
  const canManage = can('knowledge.manage');
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  const [adding, setAdding] = useState<{ domain: KnowledgeDomain; key?: string } | undefined>();

  return (
    <div className="memory">
      <header className="connections__header">
        <div>
          <h1 id="memory-title">
            <FormattedMessage id="memory.title" />
          </h1>
          <p>
            <FormattedMessage id="memory.intro" />
          </p>
        </div>
        {readsKnowledge && canPropose && adding === undefined ? (
          <Button onClick={() => setAdding({ domain: 'business_model' })}>
            <FormattedMessage id="memory.add" />
          </Button>
        ) : null}
      </header>
      {adding === undefined ? null : (
        <AddKnowledge
          key={`${adding.domain}.${adding.key ?? ''}`}
          client={client}
          start={adding}
          onDone={(saved) => {
            setAdding(undefined);
            if (saved) reload();
          }}
        />
      )}
      {readsKnowledge ? (
        <Review
          client={client}
          version={version}
          canManage={canManage}
          canPropose={canPropose}
          onChanged={reload}
          onAnswer={(domain, key) => setAdding({ domain, key })}
        />
      ) : null}
      {business}
      {readsKnowledge ? (
        <Knowledge
          client={client}
          version={version}
          canManage={canManage}
          canPropose={canPropose}
          onChanged={reload}
        />
      ) : null}
    </div>
  );
}

/** What waits on a person: disagreements, facts to confirm and what GIA still does not know. */
function Review({
  client,
  version,
  canManage,
  canPropose,
  onChanged,
  onAnswer,
}: {
  readonly client: MemoryClient;
  readonly version: number;
  readonly canManage: boolean;
  readonly canPropose: boolean;
  readonly onChanged: () => void;
  readonly onAnswer: (domain: KnowledgeDomain, key: string) => void;
}) {
  const intl = useIntl();
  const summary = useRead<KnowledgeSummary>(`summary:${version}`, () => client.summary());
  const conflicts = useRead<readonly KnowledgeConflict[]>(`conflicts:${version}`, () =>
    client.conflicts(),
  );
  const [error, setError] = useState<string | undefined>();
  async function act(work: () => Promise<unknown>) {
    setError(undefined);
    try {
      await work();
    } catch (failure) {
      setError(errorKey(failure));
    }
    onChanged();
  }
  if (summary.status !== 'ready') return null;
  const { toConfirm, questions } = summary.value.gaps;
  const open = conflicts.status === 'ready' ? conflicts.value : [];
  if (toConfirm.length === 0 && questions.length === 0 && open.length === 0) return null;
  return (
    <section className="connections memory__review" aria-labelledby="memory-review">
      <h2 id="memory-review">
        <FormattedMessage id="memory.review" />
      </h2>
      {error === undefined ? null : (
        <p className="notice notice--danger" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
      {open.length === 0 ? null : (
        <ul className="memory__list">
          {open.map((c) => (
            <li key={c.id} className="memory__item" aria-label={factName(intl, c)}>
              <p className="memory__name">{factName(intl, c)}</p>
              <p>
                <FormattedMessage id="memory.conflict.current" />{' '}
                <strong>{formatValue(intl, c.current.value)}</strong> (
                <FormattedMessage id={`memory.recorder.${c.current.recordedBy}`} />)
              </p>
              <p>
                <FormattedMessage id="memory.conflict.candidate" />{' '}
                <strong>{formatValue(intl, c.candidate.value)}</strong> (
                <FormattedMessage id={`memory.recorder.${c.candidate.recordedBy}`} />)
              </p>
              {canManage ? (
                <div className="memory__actions">
                  <Button
                    variant="secondary"
                    onClick={() => void act(() => client.resolve(c.id, 'kept_current'))}
                  >
                    <FormattedMessage id="memory.conflict.keep" />
                  </Button>
                  <Button onClick={() => void act(() => client.resolve(c.id, 'took_candidate'))}>
                    <FormattedMessage id="memory.conflict.take" />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {toConfirm.length === 0 ? null : (
        <>
          <h3>
            <FormattedMessage id="memory.toConfirm" />
          </h3>
          <ul className="memory__list">
            {toConfirm.map((item) => (
              <li key={item.id} className="memory__item" aria-label={factName(intl, item)}>
                <p className="memory__name">{factName(intl, item)}</p>
                <p>{formatValue(intl, item.value)}</p>
                <Origin item={item} />
                {canManage ? (
                  <div className="memory__actions">
                    <Button onClick={() => void act(() => client.confirm(item.id, item.revision))}>
                      <FormattedMessage id="memory.confirm" />
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void act(() => client.archive(item.id, item.revision))}
                    >
                      <FormattedMessage id="memory.discard" />
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {questions.length === 0 ? null : (
        <>
          <h3>
            <FormattedMessage id="memory.questions" />
          </h3>
          <ul className="memory__list">
            {questions.map((q) => (
              <li key={q.id} className="memory__item memory__item--question">
                <span>
                  <FormattedMessage id={`memory.question.${q.id}`} />
                </span>
                {canPropose ? (
                  <Button variant="secondary" onClick={() => onAnswer(q.domain, q.key)}>
                    <FormattedMessage id="memory.answer" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Where a fact came from, how far it can be trusted, when and which version. */
function Origin({ item }: { readonly item: KnowledgeItem }) {
  const intl = useIntl();
  return (
    <p className="memory__origin">
      <span className={`memory__badge memory__badge--${item.verification}`}>
        <FormattedMessage id={`memory.verification.${item.verification}`} />
      </span>
      {item.status === 'active' ? null : (
        <span className="memory__badge memory__badge--inactive">
          <FormattedMessage id={`memory.status.${item.status}`} />
        </span>
      )}{' '}
      <FormattedMessage id={`memory.source.${item.source.type}`} /> ·{' '}
      <FormattedMessage id={`memory.recorder.${item.source.recordedBy}`} /> ·{' '}
      {when(intl, item.updatedAt)} ·{' '}
      <FormattedMessage id="memory.version" values={{ revision: item.revision }} />
    </p>
  );
}

function Knowledge({
  client,
  version,
  canManage,
  canPropose,
  onChanged,
}: {
  readonly client: MemoryClient;
  readonly version: number;
  readonly canManage: boolean;
  readonly canPropose: boolean;
  readonly onChanged: () => void;
}) {
  const intl = useIntl();
  // A category, everything, or the history of changes (the latest changes first, whatever
  // their state; each fact's versions tell the rest).
  const [view, setView] = useState<KnowledgeDomain | 'all' | 'recent'>('all');
  const [inactiveChosen, setInactive] = useState(false);
  const recent = view === 'recent';
  const domain = view === 'all' || recent ? undefined : view;
  const inactive = recent || inactiveChosen;
  const summary = useRead<KnowledgeSummary>(`counts:${version}`, () => client.summary());
  const read = useRead<readonly KnowledgeItem[]>(
    `items:${domain ?? ''}:${String(inactive)}:${version}`,
    () => client.list({ ...(domain === undefined ? {} : { domain }), inactive }),
  );
  const items: typeof read =
    recent && read.status === 'ready'
      ? {
          status: 'ready',
          value: read.value
            .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, RECENT_CHANGES),
        }
      : read;
  const counts = summary.status === 'ready' ? summary.value.byDomain : {};
  return (
    <section className="connections" aria-labelledby="memory-knowledge">
      <h2 id="memory-knowledge">
        <FormattedMessage id="memory.knowledge" />
      </h2>
      <div
        className="memory__domains"
        role="tablist"
        aria-label={intl.formatMessage({ id: 'memory.domains' })}
      >
        <button
          type="button"
          role="tab"
          className="customers__tab"
          aria-selected={view === 'all'}
          onClick={() => setView('all')}
        >
          <FormattedMessage id="memory.domain.all" />
        </button>
        {KNOWLEDGE_DOMAINS.map((d) => (
          <button
            key={d}
            type="button"
            role="tab"
            className="customers__tab"
            aria-selected={view === d}
            onClick={() => setView(d)}
          >
            <FormattedMessage id={`memory.domain.${d}`} />
            {counts[d] === undefined ? null : <span className="customers__count">{counts[d]}</span>}
          </button>
        ))}
        <button
          type="button"
          role="tab"
          className="customers__tab"
          aria-selected={recent}
          onClick={() => setView('recent')}
        >
          <FormattedMessage id="memory.domain.recent" />
        </button>
      </div>
      {recent ? (
        <p className="panel__empty">
          <FormattedMessage id="memory.recent.help" />
        </p>
      ) : (
        <label className="business-form__check">
          <input
            type="checkbox"
            checked={inactiveChosen}
            onChange={(e) => setInactive(e.target.checked)}
          />
          <FormattedMessage id="memory.showInactive" />
        </label>
      )}
      {items.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="memory.loading" />
        </p>
      ) : items.status === 'error' ? (
        <p className="notice notice--danger" role="alert">
          <FormattedMessage id="memory.error.load" />
        </p>
      ) : items.value.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id={domain === undefined ? 'memory.empty' : 'memory.empty.domain'} />
        </p>
      ) : (
        <ul className="memory__list">
          {items.value.map((item) => (
            <FactRow
              key={`${item.id}:${item.revision}`}
              client={client}
              item={item}
              showDomain={domain === undefined}
              canManage={canManage}
              canPropose={canPropose}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function FactRow({
  client,
  item,
  showDomain,
  canManage,
  canPropose,
  onChanged,
}: {
  readonly client: MemoryClient;
  readonly item: KnowledgeItem;
  readonly showDomain: boolean;
  readonly canManage: boolean;
  readonly canPropose: boolean;
  readonly onChanged: () => void;
}) {
  const intl = useIntl();
  const [editing, setEditing] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const elsewhere = managedElsewhere(item);
  const active = item.status === 'active';
  async function act(work: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try {
      await work();
      setEditing(false);
      onChanged();
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(false);
    }
  }
  const name = factName(intl, item);
  return (
    <li className="memory__item" aria-label={name}>
      <p className="memory__name">
        {name}
        {showDomain ? (
          <span className="memory__domain">
            {' · '}
            <FormattedMessage id={`memory.domain.${item.domain}`} />
          </span>
        ) : null}
      </p>
      {editing && item.value !== undefined ? (
        <ValueEditor
          value={item.value}
          pending={pending}
          onCancel={() => setEditing(false)}
          onSave={(value) =>
            void act(() =>
              client.propose({
                domain: item.domain,
                key: item.key,
                ...(item.subject === null ? {} : { subject: item.subject }),
                ...(item.label === null ? {} : { label: item.label }),
                value,
              }),
            )
          }
        />
      ) : (
        <p className="memory__value">{formatValue(intl, item.value)}</p>
      )}
      <Origin item={item} />
      {elsewhere === undefined ? null : (
        <p className="panel__empty">
          <FormattedMessage id={`memory.elsewhere.${elsewhere}`} />
        </p>
      )}
      {error === undefined ? null : (
        <p className="notice notice--danger" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
      {editing ? null : (
        <div className="memory__actions">
          {canPropose && elsewhere === undefined && item.value !== undefined ? (
            <Button variant="secondary" disabled={pending} onClick={() => setEditing(true)}>
              <FormattedMessage id="memory.edit" />
            </Button>
          ) : null}
          {canManage && active && item.verification !== 'confirmed' && item.value !== undefined ? (
            <Button
              disabled={pending}
              onClick={() => void act(() => client.confirm(item.id, item.revision))}
            >
              <FormattedMessage id="memory.confirm" />
            </Button>
          ) : null}
          {canManage && active && elsewhere === undefined ? (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => void act(() => client.invalidate(item.id, item.revision))}
            >
              <FormattedMessage id="memory.outdated" />
            </Button>
          ) : null}
          {canManage && item.status !== 'archived' && elsewhere === undefined ? (
            <Button
              variant="secondary"
              disabled={pending}
              onClick={() => void act(() => client.archive(item.id, item.revision))}
            >
              <FormattedMessage id="memory.archive" />
            </Button>
          ) : null}
          <Button variant="secondary" onClick={() => setShowVersions((v) => !v)}>
            <FormattedMessage id={showVersions ? 'memory.versions.hide' : 'memory.versions.show'} />
          </Button>
        </div>
      )}
      {showVersions ? <Versions client={client} itemId={item.id} /> : null}
    </li>
  );
}

function Versions({ client, itemId }: { readonly client: MemoryClient; readonly itemId: string }) {
  const intl = useIntl();
  const versions = useRead<readonly KnowledgeVersion[]>(itemId, () => client.versions(itemId));
  if (versions.status === 'loading') {
    return (
      <p className="panel__empty" role="status">
        <FormattedMessage id="memory.loading" />
      </p>
    );
  }
  if (versions.status === 'error') {
    return (
      <p className="notice notice--danger" role="alert">
        <FormattedMessage id="memory.error.load" />
      </p>
    );
  }
  return (
    <ol className="memory__versions" aria-label={intl.formatMessage({ id: 'memory.versions' })}>
      {versions.value.map((v) => (
        <li key={v.revision}>
          <FormattedMessage id="memory.version" values={{ revision: v.revision }} /> ·{' '}
          <FormattedMessage id={`memory.operation.${v.operation}`} /> · {formatValue(intl, v.value)}{' '}
          · <FormattedMessage id={`memory.recorder.${v.changedBy}`} /> · {when(intl, v.changedAt)}
        </li>
      ))}
    </ol>
  );
}

/** Edits a value in its own kind: text, a list (one per line), a number, a date, yes/no, money. */
function ValueEditor({
  value,
  pending,
  onSave,
  onCancel,
}: {
  readonly value: KnowledgeValue;
  readonly pending: boolean;
  readonly onSave: (value: KnowledgeValue) => void;
  readonly onCancel: () => void;
}) {
  const intl = useIntl();
  const [text, setText] = useState(() => {
    switch (value.type) {
      case 'text':
        return value.text;
      case 'list':
        return value.items.join('\n');
      case 'number':
        return String(value.number);
      case 'date':
        return value.date;
      case 'boolean':
        return String(value.value);
      case 'money': {
        const digits = minorDigits(value.currency);
        return (value.amountMinor / 10 ** digits).toFixed(digits);
      }
    }
  });
  const parsed = ((): KnowledgeValue | undefined => {
    const trimmed = text.trim();
    switch (value.type) {
      case 'text':
        return trimmed === '' ? undefined : { type: 'text', text: trimmed };
      case 'list': {
        const items = trimmed
          .split('\n')
          .map((i) => i.trim())
          .filter((i) => i !== '');
        return items.length === 0 ? undefined : { type: 'list', items };
      }
      case 'number': {
        const number = Number(trimmed.replace(',', '.'));
        return trimmed === '' || !Number.isFinite(number)
          ? undefined
          : { type: 'number', number, ...(value.unit === undefined ? {} : { unit: value.unit }) };
      }
      case 'date':
        return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? { type: 'date', date: trimmed } : undefined;
      case 'boolean':
        return { type: 'boolean', value: trimmed === 'true' };
      case 'money': {
        const amountMinor = toMinor(trimmed, value.currency);
        return amountMinor === undefined
          ? undefined
          : { type: 'money', amountMinor, currency: value.currency };
      }
    }
  })();
  const label = intl.formatMessage({ id: 'memory.field.value' });
  return (
    <form
      className="memory__edit"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (parsed !== undefined) onSave(parsed);
      }}
    >
      {value.type === 'text' || value.type === 'list' ? (
        <textarea
          className="gia-chat__input"
          aria-label={label}
          rows={value.type === 'list' ? 4 : 2}
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : value.type === 'boolean' ? (
        <select
          className="gia-chat__input"
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
        >
          <option value="true">{intl.formatMessage({ id: 'memory.value.yes' })}</option>
          <option value="false">{intl.formatMessage({ id: 'memory.value.no' })}</option>
        </select>
      ) : (
        <input
          className="gia-chat__input"
          aria-label={value.type === 'money' ? `${label} (${value.currency})` : label}
          type={value.type === 'date' ? 'date' : 'text'}
          inputMode={value.type === 'date' ? undefined : 'decimal'}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {value.type === 'list' ? (
        <p className="panel__empty">
          <FormattedMessage id="memory.field.listHelp" />
        </p>
      ) : null}
      <div className="memory__actions">
        <Button type="submit" disabled={pending || parsed === undefined}>
          <FormattedMessage id="memory.save" />
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          <FormattedMessage id="memory.cancel" />
        </Button>
      </div>
    </form>
  );
}

/**
 * "Add information": a fact in a category, in the person's own words, or a document's text. What
 * a person adds directly is theirs, so Company Brain records it as confirmed; a document's facts
 * wait for a person to confirm them.
 */
function AddKnowledge({
  client,
  start,
  onDone,
}: {
  readonly client: MemoryClient;
  readonly start: { readonly domain: KnowledgeDomain; readonly key?: string };
  readonly onDone: (saved: boolean) => void;
}) {
  const intl = useIntl();
  const answering = start.key !== undefined;
  const [kind, setKind] = useState<'fact' | 'document'>('fact');
  const [domain, setDomain] = useState<KnowledgeDomain>(start.domain);
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [asList, setAsList] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    const body = text.trim();
    if (body === '') {
      setError('memory.error.needValue');
      return;
    }
    setPending(true);
    try {
      if (kind === 'document') {
        if (label.trim() === '') {
          setError('memory.error.needName');
          return;
        }
        const answer = (await client.addDocument(label.trim(), body)) as { extraction?: string };
        if (answer.extraction === 'duplicate') {
          setNotice('memory.document.duplicate');
          return;
        }
        onDone(true);
        return;
      }
      const key = start.key ?? keyFor(label);
      if (key === undefined) {
        setError('memory.error.needName');
        return;
      }
      const items = body
        .split('\n')
        .map((i) => i.trim())
        .filter((i) => i !== '');
      const outcome = await client.propose({
        domain,
        key,
        ...(answering || label.trim() === '' ? {} : { label: label.trim() }),
        value: asList ? { type: 'list', items } : { type: 'text', text: body },
      });
      if (outcome.outcome === 'conflict') {
        setNotice('memory.added.conflict');
        return;
      }
      onDone(true);
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(false);
    }
  }

  const title = intl.formatMessage({ id: 'memory.add' });
  return (
    <form className="connection-form memory__add" onSubmit={submit} aria-label={title}>
      <h2>{title}</h2>
      {answering ? null : (
        <fieldset className="business-form__channels">
          <legend>
            <FormattedMessage id="memory.add.kind" />
          </legend>
          {(['fact', 'document'] as const).map((k) => (
            <label key={k} className="business-form__check">
              <input
                type="radio"
                name="memory-kind"
                checked={kind === k}
                onChange={() => setKind(k)}
              />
              <FormattedMessage id={`memory.add.kind.${k}`} />
            </label>
          ))}
        </fieldset>
      )}
      {kind === 'fact' && !answering ? (
        <label>
          <FormattedMessage id="memory.field.domain" />
          <select
            className="gia-chat__input"
            value={domain}
            onChange={(e) => setDomain(e.target.value as KnowledgeDomain)}
          >
            {KNOWLEDGE_DOMAINS.map((d) => (
              <option key={d} value={d}>
                {intl.formatMessage({ id: `memory.domain.${d}` })}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {answering ? (
        <p className="memory__name">
          {factName(intl, { domain, key: start.key as string, label: null })}
        </p>
      ) : (
        <label>
          <FormattedMessage
            id={kind === 'document' ? 'memory.field.documentName' : 'memory.field.label'}
          />
          <input
            className="gia-chat__input"
            value={label}
            maxLength={kind === 'document' ? 200 : 100}
            placeholder={
              kind === 'fact' ? intl.formatMessage({ id: 'memory.field.labelExample' }) : undefined
            }
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
      )}
      <label>
        <FormattedMessage
          id={kind === 'document' ? 'memory.field.documentText' : 'memory.field.value'}
        />
        <textarea
          className="gia-chat__input"
          rows={kind === 'document' ? 8 : 3}
          maxLength={kind === 'document' ? 60000 : 1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      {kind === 'fact' ? (
        <label className="business-form__check">
          <input type="checkbox" checked={asList} onChange={(e) => setAsList(e.target.checked)} />
          <FormattedMessage id="memory.field.asList" />
        </label>
      ) : (
        <p className="panel__empty">
          <FormattedMessage id="memory.document.help" />
        </p>
      )}
      {error === undefined ? null : (
        <p className="notice notice--danger" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
      {notice === undefined ? null : (
        <p className="notice" role="status">
          <FormattedMessage id={notice} />
        </p>
      )}
      <div className="memory__actions">
        {notice === undefined ? (
          <Button type="submit" disabled={pending}>
            <FormattedMessage id="memory.save" />
          </Button>
        ) : null}
        <Button variant="secondary" onClick={() => onDone(notice !== undefined)}>
          <FormattedMessage id={notice === undefined ? 'memory.cancel' : 'memory.close'} />
        </Button>
      </div>
    </form>
  );
}
