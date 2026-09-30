import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CustomersClient, CustomerView } from '../customers/customersClient.js';
import { navigate } from '../identity/router.js';
import { RecordFollowUps } from '../followUps/FollowUps.js';
import type { FollowUpsClient } from '../followUps/followUpsClient.js';
import { openedWith, paths } from '../shell/routes.js';
import { useRead } from '../shell/useRead.js';
import { LoadMore, usePagedRead } from '../lists/usePagedRead.js';
import {
  LOST_REASONS,
  OpportunityRequestError,
  type LostReason,
  type Money,
  type OpportunitiesClient,
  type OpportunityChange,
  type OpportunityDetail,
  type OpportunityList,
  type OpportunityStatus,
  type PipelineView,
  type StageInput,
  type StageView,
} from './opportunitiesClient.js';
import { errorMessage } from '../shell/errors.js';

type IntlShape = ReturnType<typeof useIntl>;

/** The contacts the new opportunity form offers, per stage. */
const CONTACT_PICKER_LIMIT = 200;
/** How many minor units a currency's major unit has (2 for soles, 0 for yen). */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** An amount typed in major units ("1500.50") as minor units, or undefined when it is not one. */
export function toMinor(text: string, currency: string): number | undefined {
  const digits = minorDigits(currency);
  const clean = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(clean)) return undefined;
  const [whole = '0', fraction = ''] = clean.split('.');
  if (fraction.length > digits) return undefined;
  return Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0') || '0');
}

export const formatMoney = (intl: IntlShape, money: Money) =>
  intl.formatNumber(money.amountMinor / 10 ** minorDigits(money.currency), {
    style: 'currency',
    currency: money.currency,
  });

export const stageName = (intl: IntlShape, stage: Pick<StageView, 'name' | 'nameKey' | 'id'>) =>
  stage.name ?? (stage.nameKey === null ? stage.id : intl.formatMessage({ id: stage.nameKey }));

const errorKey = (error: unknown): string =>
  errorMessage(error, OpportunityRequestError, 'opportunities');

/**
 * Opportunities and pipeline (C2, ADR-0054), in the Comercial office: the organization's own
 * stages with what is at each and its value, each opportunity's card (value, probability,
 * expected close, responsible, next action, the contact's conversations and its history), won and
 * lost, and the stage editor. Nothing here is an example: without data it says so.
 */
export function OpportunitiesSection({
  client,
  customers,
  canManage,
  canManagePipeline,
  currentUserId,
  today,
  followUps,
}: {
  readonly client: OpportunitiesClient;
  readonly customers?: CustomersClient;
  readonly canManage: boolean;
  readonly canManagePipeline: boolean;
  readonly currentUserId: string;
  readonly today: string;
  /** An opportunity's next follow-up (C5), for a role that may read them. */
  readonly followUps?: { readonly client: FollowUpsClient; readonly canManage: boolean };
}) {
  const intl = useIntl();
  const [status, setStatus] = useState<OpportunityStatus>('open');
  const [version, setVersion] = useState(0);
  // An opportunity or the pipeline opened from elsewhere (GIA's links, C4) starts in view.
  const [selected, setSelected] = useState<string | undefined>(() => openedWith('opportunity'));
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (openedWith('opportunity') !== undefined || openedWith('view') === 'pipeline') {
      section.current?.scrollIntoView?.({ block: 'start' });
    }
  }, []);
  const [mode, setMode] = useState<'none' | 'create' | 'stages'>('none');
  const reload = () => setVersion((v) => v + 1);
  const pipeline = useRead(`pipeline:${version}`, () => client.pipeline());
  // The pages of this tab and version (ADR-0061): a new tab or a change starts from the first.
  const pages = usePagedRead(`list:${status}:${version}`, (cursor?: string) =>
    client.list(status, cursor === undefined ? {} : { cursor }),
  );
  const list = pages.list;

  const ready = pipeline.status === 'ready' ? pipeline.value : undefined;
  const summary = list.status === 'ready' ? list.value.summary : undefined;
  const openStages = ready?.stages.filter((s) => s.kind === 'open') ?? [];
  return (
    <section
      ref={section}
      className="dept-office__section customers"
      aria-labelledby="opportunities-title"
    >
      <div className="customers__header">
        <h2 id="opportunities-title">
          <FormattedMessage id="opportunities.title" />
        </h2>
        <div className="customers__actions">
          {canManage && ready !== undefined && customers !== undefined ? (
            <Button
              variant="secondary"
              onClick={() => setMode(mode === 'create' ? 'none' : 'create')}
            >
              <FormattedMessage id="opportunities.add" />
            </Button>
          ) : null}
          {canManagePipeline && ready !== undefined ? (
            <Button
              variant="secondary"
              onClick={() => setMode(mode === 'stages' ? 'none' : 'stages')}
            >
              <FormattedMessage id="opportunities.stages.edit" />
            </Button>
          ) : null}
        </div>
      </div>
      {summary === undefined ? null : (
        <p className="customers__meta">
          <FormattedMessage
            id="opportunities.summary.open"
            values={{ count: summary.open.count }}
          />
          {summary.currency === null
            ? null
            : ` · ${formatMoney(intl, { amountMinor: summary.open.valueMinor, currency: summary.currency })}`}
          {' · '}
          <FormattedMessage id="opportunities.summary.won" values={{ count: summary.won }} />
          {' · '}
          <FormattedMessage id="opportunities.summary.lost" values={{ count: summary.lost }} />
        </p>
      )}
      {ready !== undefined && !ready.stored ? (
        <p className="panel__empty">
          <FormattedMessage id="opportunities.stages.proposed" />
        </p>
      ) : null}
      {mode === 'create' && ready !== undefined && customers !== undefined ? (
        <CreateOpportunity
          client={client}
          customers={customers}
          stages={openStages}
          currency={summary?.currency ?? undefined}
          onDone={(id) => {
            setMode('none');
            if (id !== undefined) {
              setStatus('open');
              setSelected(id);
              reload();
            }
          }}
        />
      ) : null}
      {mode === 'stages' && ready !== undefined ? (
        <StageEditor
          client={client}
          pipeline={ready}
          onDone={(saved) => {
            setMode('none');
            if (saved) reload();
          }}
        />
      ) : null}
      <div className="customers__tabs" role="tablist">
        {(['open', 'won', 'lost'] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === status}
            className="mo-chip customers__tab"
            onClick={() => setStatus(s)}
          >
            <FormattedMessage id={`opportunities.status.${s}`} />
          </button>
        ))}
      </div>
      {pipeline.status === 'error' || list.status === 'error' ? (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id="opportunities.error.load" />
        </p>
      ) : ready === undefined || list.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="opportunities.loading" />
        </p>
      ) : list.value.items.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id={`opportunities.empty.${status}`} />
        </p>
      ) : status === 'open' ? (
        <div className="pipeline-board">
          {openStages.map((stage) => {
            const here = list.value.items.filter((o) => o.stageId === stage.id);
            const total = summary?.stages[stage.id];
            return (
              <section
                key={stage.id}
                className="pipeline-board__column"
                aria-label={stageName(intl, stage)}
              >
                <h3 className="pipeline-board__title">
                  {stageName(intl, stage)}{' '}
                  {/* How many are at the stage in all, not only on the pages loaded. */}
                  <span className="customers__count">{total?.count ?? 0}</span>
                </h3>
                {summary?.currency != null && total !== undefined ? (
                  <p className="customers__meta">
                    {formatMoney(intl, {
                      amountMinor: total.valueMinor,
                      currency: summary.currency,
                    })}
                  </p>
                ) : null}
                <OpportunityRows
                  list={list.value}
                  ids={here.map((o) => o.id)}
                  selected={selected}
                  onSelect={setSelected}
                  today={today}
                />
              </section>
            );
          })}
        </div>
      ) : (
        <OpportunityRows
          list={list.value}
          ids={list.value.items.map((o) => o.id)}
          selected={selected}
          onSelect={setSelected}
          today={today}
        />
      )}
      {pipeline.status === 'error' ? null : <LoadMore read={pages} />}
      {selected === undefined || ready === undefined ? null : (
        <OpportunityCard
          key={`${selected}:${version}`}
          client={client}
          id={selected}
          pipeline={ready}
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

function OpportunityRows({
  list,
  ids,
  selected,
  onSelect,
  today,
}: {
  readonly list: OpportunityList;
  readonly ids: readonly string[];
  readonly selected: string | undefined;
  readonly onSelect: (id: string | undefined) => void;
  readonly today: string;
}) {
  const intl = useIntl();
  const rows = list.items.filter((o) => ids.includes(o.id));
  return (
    <ul className="customers__list">
      {rows.map((o) => {
        const late = o.nextAction !== null && o.nextAction.dueOn < today;
        return (
          <li key={o.id}>
            <button
              type="button"
              className="customers__row"
              aria-current={o.id === selected ? 'true' : undefined}
              onClick={() => onSelect(o.id === selected ? undefined : o.id)}
            >
              <span className="customers__name">{o.title}</span>
              <span className="customers__meta">
                {o.contactName ?? ''}
                {o.value === null ? '' : ` · ${formatMoney(intl, o.value)}`}
                {o.status === 'open' ? ` · ${o.probability}%` : ''}
              </span>
              {o.nextAction === null ? null : (
                <span className={`customers__next${late ? ' customers__next--late' : ''}`}>
                  {late ? <FormattedMessage id="customers.next.overdue" /> : null}{' '}
                  {o.nextAction.text} · {o.nextAction.dueOn}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function CreateOpportunity({
  client,
  customers,
  stages,
  currency,
  onDone,
}: {
  readonly client: OpportunitiesClient;
  readonly customers: CustomersClient;
  readonly stages: readonly StageView[];
  /** The business's currency, when known: amounts are typed in it. */
  readonly currency: string | undefined;
  readonly onDone: (id?: string) => void;
}) {
  const intl = useIntl();
  const contacts = useRead('contacts', async () => {
    const [leads, clients] = await Promise.all([
      // As many as a list ever showed; a search replaces this picker when lists grow.
      customers.list('lead', { limit: CONTACT_PICKER_LIMIT }),
      customers.list('customer', { limit: CONTACT_PICKER_LIMIT }),
    ]);
    return [...leads.items, ...clients.items];
  });
  const [contactId, setContactId] = useState('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [stageId, setStageId] = useState(stages[0]?.id ?? '');
  const [closeOn, setCloseOn] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (contactId === '' || title.trim() === '') {
      setError('opportunities.error.needContact');
      return;
    }
    const amountMinor = amount.trim() === '' ? undefined : toMinor(amount, currency ?? 'PEN');
    if (amount.trim() !== '' && amountMinor === undefined) {
      setError('opportunities.error.amount');
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const created = await client.create({
        contactId,
        title: title.trim(),
        ...(stageId === '' ? {} : { stageId }),
        ...(amountMinor === undefined ? {} : { value: { amountMinor } }),
        ...(closeOn === '' ? {} : { expectedCloseOn: closeOn }),
      });
      onDone(created.id);
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(false);
    }
  }
  const label = (key: string) => intl.formatMessage({ id: key });
  const people: readonly CustomerView[] = contacts.status === 'ready' ? contacts.value : [];
  return (
    <form className="customers__form" onSubmit={submit} aria-label={label('opportunities.add')}>
      {contacts.status === 'ready' && people.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="opportunities.noContacts" />
        </p>
      ) : null}
      <label>
        <FormattedMessage id="opportunities.field.contact" />
        <select
          className="gia-chat__input"
          value={contactId}
          onChange={(e) => setContactId(e.target.value)}
        >
          <option value="">{label('opportunities.field.contact.choose')}</option>
          {people.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName ?? c.phone ?? c.email}
            </option>
          ))}
        </select>
      </label>
      <label>
        <FormattedMessage id="opportunities.field.title" />
        <input
          className="gia-chat__input"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        <FormattedMessage id="opportunities.field.value" values={{ currency: currency ?? '' }} />
        <input
          className="gia-chat__input"
          value={amount}
          inputMode="decimal"
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label>
        <FormattedMessage id="opportunities.field.stage" />
        <select
          className="gia-chat__input"
          value={stageId}
          onChange={(e) => setStageId(e.target.value)}
        >
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {stageName(intl, s)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <FormattedMessage id="opportunities.field.expectedClose" />
        <input
          className="gia-chat__input"
          type="date"
          value={closeOn}
          onChange={(e) => setCloseOn(e.target.value)}
        />
      </label>
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
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

function OpportunityCard({
  client,
  id,
  pipeline,
  canManage,
  currentUserId,
  today,
  onChanged,
  followUps,
}: {
  readonly client: OpportunitiesClient;
  readonly id: string;
  readonly pipeline: PipelineView;
  readonly canManage: boolean;
  readonly currentUserId: string;
  readonly today: string;
  readonly onChanged: () => void;
  readonly followUps?: { readonly client: FollowUpsClient; readonly canManage: boolean };
}) {
  const intl = useIntl();
  const detail = useRead(`opportunity:${id}`, () => client.get(id));
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  const [lostReason, setLostReason] = useState<LostReason | ''>('');
  const [draft, setDraft] = useState<Record<string, string>>({});

  if (detail.status === 'loading') {
    return (
      <p className="panel__empty" role="status">
        <FormattedMessage id="opportunities.loading" />
      </p>
    );
  }
  if (detail.status === 'error') {
    return (
      <p className="gia-chat__error" role="alert">
        <FormattedMessage id="opportunities.error.load" />
      </p>
    );
  }
  const o: OpportunityDetail = detail.value;
  const open = o.status === 'open';
  const field = (name: string, fallback: string) => draft[name] ?? fallback;
  const setField = (name: string, value: string) => setDraft((d) => ({ ...d, [name]: value }));
  const label = (key: string) => intl.formatMessage({ id: key });
  const currency = o.value?.currency;

  async function change(patch: Omit<OpportunityChange, 'revision'>) {
    setPending(true);
    setError(undefined);
    try {
      await client.update(id, { revision: o.revision, ...patch });
      onChanged();
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(false);
    }
  }

  function saveDetails() {
    const patch: Record<string, unknown> = {};
    const amount = field('amount', '');
    if (amount !== '') {
      const minor = toMinor(amount, currency ?? 'PEN');
      if (minor === undefined) {
        setError('opportunities.error.amount');
        return;
      }
      patch.value = { amountMinor: minor };
    }
    const probability = field('probability', '');
    if (probability !== '') patch.probability = Number(probability);
    const closeOn = field('closeOn', o.expectedCloseOn ?? '');
    if (closeOn !== (o.expectedCloseOn ?? ''))
      patch.expectedCloseOn = closeOn === '' ? null : closeOn;
    const text = field('nextText', o.nextAction?.text ?? '').trim();
    const due = field('nextDue', o.nextAction?.dueOn ?? '');
    if (text !== (o.nextAction?.text ?? '') || due !== (o.nextAction?.dueOn ?? '')) {
      patch.nextAction = text === '' || due === '' ? null : { text, dueOn: due };
    }
    if (Object.keys(patch).length > 0) void change(patch as Omit<OpportunityChange, 'revision'>);
  }

  const lateNext = o.nextAction !== null && o.nextAction.dueOn < today;
  return (
    <article className="customers__card" aria-labelledby="opportunity-name">
      <h3 id="opportunity-name">{o.title}</h3>
      <dl className="agent-facts">
        <Fact term="opportunities.field.contact" value={o.contact.displayName ?? '—'} />
        <Fact
          term="opportunities.field.stage"
          value={stageName(
            intl,
            pipeline.stages.find((s) => s.id === o.stageId) ?? {
              id: o.stageId,
              name: null,
              nameKey: null,
            },
          )}
        />
        <Fact
          term="opportunities.field.valueShort"
          value={o.value === null ? '—' : formatMoney(intl, o.value)}
        />
        <Fact term="opportunities.field.probability" value={`${o.probability}%`} />
        <Fact term="customers.field.owner" value={label(`customers.owner.${o.owner ?? 'none'}`)} />
        {o.lostReason === null ? null : (
          <Fact
            term="opportunities.field.lostReason"
            value={label(`opportunities.lost.${o.lostReason}`)}
          />
        )}
      </dl>
      {lateNext ? (
        <p className="customers__next customers__next--late">
          <FormattedMessage id="customers.next.overdue" />: {o.nextAction?.text}
        </p>
      ) : null}
      <fieldset className="customers__edit" disabled={!canManage || pending}>
        <label>
          <FormattedMessage id="opportunities.move" />
          <select
            className="gia-chat__input"
            value={o.stageId}
            onChange={(e) => {
              const target = pipeline.stages.find((s) => s.id === e.target.value);
              if (target === undefined) return;
              if (target.kind === 'lost') {
                setField('moveToLost', target.id);
                return;
              }
              void change({ stageId: target.id });
            }}
          >
            {pipeline.stages.map((s) => (
              <option key={s.id} value={s.id}>
                {stageName(intl, s)}
              </option>
            ))}
          </select>
        </label>
        {draft.moveToLost === undefined ? null : (
          <div className="customers__actions">
            <label>
              <FormattedMessage id="opportunities.field.lostReason" />
              <select
                className="gia-chat__input"
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value as LostReason)}
              >
                <option value="">{label('opportunities.lost.choose')}</option>
                {LOST_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {label(`opportunities.lost.${r}`)}
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="secondary"
              disabled={lostReason === ''}
              onClick={() =>
                lostReason === ''
                  ? undefined
                  : void change({ stageId: draft.moveToLost as string, lostReason })
              }
            >
              <FormattedMessage id="opportunities.lost.confirm" />
            </Button>
          </div>
        )}
        {open ? (
          <>
            <div className="customers__actions">
              {o.owner === 'you' ? (
                <Button variant="secondary" onClick={() => void change({ ownerId: null })}>
                  <FormattedMessage id="customers.owner.release" />
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => void change({ ownerId: currentUserId })}>
                  <FormattedMessage id="customers.owner.take" />
                </Button>
              )}
            </div>
            <label>
              <FormattedMessage
                id="opportunities.field.value"
                values={{ currency: currency ?? '' }}
              />
              <input
                className="gia-chat__input"
                inputMode="decimal"
                value={field('amount', '')}
                placeholder={o.value === null ? '' : formatMoney(intl, o.value)}
                onChange={(e) => setField('amount', e.target.value)}
              />
            </label>
            <label>
              <FormattedMessage id="opportunities.field.probability" />
              <input
                className="gia-chat__input"
                type="number"
                min={0}
                max={100}
                value={field('probability', '')}
                placeholder={String(o.probability)}
                onChange={(e) => setField('probability', e.target.value)}
              />
            </label>
            <label>
              <FormattedMessage id="opportunities.field.expectedClose" />
              <input
                className="gia-chat__input"
                type="date"
                value={field('closeOn', o.expectedCloseOn ?? '')}
                onChange={(e) => setField('closeOn', e.target.value)}
              />
            </label>
            <label>
              <FormattedMessage id="customers.field.nextAction" />
              <input
                className="gia-chat__input"
                maxLength={200}
                // The earliest open follow-up's (ADR-0058): it changes only through them.
                disabled={o.nextAction?.followUpId !== undefined}
                value={field('nextText', o.nextAction?.text ?? '')}
                onChange={(e) => setField('nextText', e.target.value)}
              />
            </label>
            <label>
              <FormattedMessage id="customers.field.dueOn" />
              <input
                className="gia-chat__input"
                type="date"
                disabled={o.nextAction?.followUpId !== undefined}
                value={field('nextDue', o.nextAction?.dueOn ?? '')}
                onChange={(e) => setField('nextDue', e.target.value)}
              />
            </label>
            <div className="customers__actions">
              <Button onClick={saveDetails}>
                <FormattedMessage id="customers.save" />
              </Button>
            </div>
          </>
        ) : null}
      </fieldset>
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
      {followUps === undefined ? null : (
        <RecordFollowUps
          client={followUps.client}
          contactId={o.contact.id}
          opportunityId={o.id}
          canManage={followUps.canManage && o.status === 'open'}
          onChanged={onChanged}
        />
      )}
      <h4>
        <FormattedMessage id="opportunities.conversations" />
      </h4>
      {o.conversations === null ? (
        <p className="panel__empty">
          <FormattedMessage id="opportunities.conversations.hidden" />
        </p>
      ) : o.conversations.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="opportunities.conversations.none" />
        </p>
      ) : (
        <ul className="customers__notes">
          {o.conversations.map((c) => (
            <li key={c.id}>
              <a
                className="customers__link"
                href={paths.conversation(c.id)}
                onClick={(event) => {
                  event.preventDefault();
                  navigate(paths.conversation(c.id));
                }}
              >
                {c.channel} ·{' '}
                {intl.formatDate(c.lastMessageAt, {
                  dateStyle: 'short',
                  timeStyle: 'short',
                } as never)}
              </a>
            </li>
          ))}
        </ul>
      )}
      <h4>
        <FormattedMessage id="opportunities.history" />
      </h4>
      <ul className="customers__notes">
        {o.history.map((h) => (
          <li key={h.id}>
            <p>
              <FormattedMessage id={`opportunities.history.${h.action}`} />
              {h.transition === null ? null : (
                <>
                  {' '}
                  ({historyStage(intl, pipeline, h.transition.from)} →{' '}
                  {historyStage(intl, pipeline, h.transition.to)})
                </>
              )}
            </p>
            <span className="customers__meta">
              <FormattedMessage id={`opportunities.actor.${h.actor}`} /> ·{' '}
              {intl.formatDate(h.at, { dateStyle: 'short', timeStyle: 'short' } as never)}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

function historyStage(intl: IntlShape, pipeline: PipelineView, id: string): string {
  if (id === 'none') return '—';
  const stage = pipeline.stages.find((s) => s.id === id);
  return stage === undefined ? id : stageName(intl, stage);
}

function StageEditor({
  client,
  pipeline,
  onDone,
}: {
  readonly client: OpportunitiesClient;
  readonly pipeline: PipelineView;
  readonly onDone: (saved: boolean) => void;
}) {
  const intl = useIntl();
  type Row = { key: string; id?: string; name: string; probability: string; original: string };
  const [rows, setRows] = useState<Row[]>(() =>
    pipeline.stages
      .filter((s) => s.kind === 'open')
      .map((s) => {
        const name = stageName(intl, s);
        return { key: s.id, id: s.id, name, probability: String(s.probability), original: name };
      }),
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const move = (index: number, by: number) =>
    setRows((r) => {
      const next = [...r];
      const [row] = next.splice(index, 1);
      if (row !== undefined) next.splice(index + by, 0, row);
      return next;
    });
  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    const stages: StageInput[] = [
      ...rows.map((r) => ({
        ...(r.id === undefined ? {} : { id: r.id }),
        ...(r.id === undefined || r.name.trim() !== r.original ? { name: r.name.trim() } : {}),
        probability: Number(r.probability),
      })),
      { id: 'won' },
      { id: 'lost' },
    ];
    try {
      await client.savePipeline(pipeline.revision, stages);
      onDone(true);
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(false);
    }
  }
  const label = (key: string) => intl.formatMessage({ id: key });
  return (
    <form
      className="customers__form"
      onSubmit={save}
      aria-label={label('opportunities.stages.edit')}
    >
      <p className="panel__empty">
        <FormattedMessage id="opportunities.stages.help" />
      </p>
      <ol className="customers__list">
        {rows.map((row, index) => (
          <li key={row.key} className="stage-row">
            <input
              className="gia-chat__input"
              aria-label={label('opportunities.stages.name')}
              value={row.name}
              maxLength={40}
              onChange={(e) =>
                setRows((r) =>
                  r.map((x) => (x.key === row.key ? { ...x, name: e.target.value } : x)),
                )
              }
            />
            <input
              className="gia-chat__input stage-row__probability"
              aria-label={label('opportunities.field.probability')}
              type="number"
              min={0}
              max={100}
              value={row.probability}
              onChange={(e) =>
                setRows((r) =>
                  r.map((x) => (x.key === row.key ? { ...x, probability: e.target.value } : x)),
                )
              }
            />
            <Button
              variant="secondary"
              disabled={index === 0}
              onClick={() => move(index, -1)}
              aria-label={label('opportunities.stages.up')}
            >
              ↑
            </Button>
            <Button
              variant="secondary"
              disabled={index === rows.length - 1}
              onClick={() => move(index, 1)}
              aria-label={label('opportunities.stages.down')}
            >
              ↓
            </Button>
            <Button
              variant="secondary"
              disabled={rows.length === 1}
              onClick={() => setRows((r) => r.filter((x) => x.key !== row.key))}
              aria-label={label('opportunities.stages.remove')}
            >
              ✕
            </Button>
          </li>
        ))}
      </ol>
      <div className="customers__actions">
        <Button
          variant="secondary"
          disabled={rows.length >= 12}
          onClick={() =>
            setRows((r) => [
              ...r,
              { key: `new-${r.length}-${Date.now()}`, name: '', probability: '50', original: '' },
            ])
          }
        >
          <FormattedMessage id="opportunities.stages.add" />
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
      <div className="customers__actions">
        <Button type="submit" disabled={pending}>
          <FormattedMessage id="customers.save" />
        </Button>
        <Button variant="secondary" onClick={() => onDone(false)}>
          <FormattedMessage id="customers.cancel" />
        </Button>
      </div>
    </form>
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
