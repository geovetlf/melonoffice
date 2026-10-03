import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, Button, PageHeader, StateMessage } from '@melonoffice/ui';
import { useEffect, useState, type FormEvent } from 'react';
import { navigate } from '../identity/router.js';
import { readyList, useOfficeData, useSpecialistSaved } from '../office/OfficeData.js';
import { departmentName, officeSlug } from '../office/departments.js';
import type { SpecialistStatus, SpecialistView } from '../office/officeClient.js';
import { paths } from '../shell/routes.js';
import { CapabilityCatalogue } from './CapabilityCatalogue.js';
import {
  AGENT_AUTONOMY_LEVELS,
  AgentRequestError,
  TRANSITIONS,
  type AgentAutonomyLevel,
  type AgentPageView,
  type AgentTemplateView,
  type AgentView,
  type AgentsClient,
  type ReadinessProblemView,
} from './agentsClient.js';
import { ReadinessProblems } from './ReadinessProblems.js';
import { TeamReview } from './TeamReview.js';
import { errorCode } from '../shell/errors.js';

/**
 * Agents (ADR-0025, ADR-0062, AE-4): the organization's agents one page at a time, searched and
 * filtered on the server (name, status, department, skill), so an organization with a thousand
 * agents reads 25 at a time. Creating one starts it as a draft. Activating it is refused, with
 * every missing piece named, until it can work. Pausing, disabling or archiving says first what
 * happens to its work in progress and asks for a reason (required to disable). An agent is a
 * record, not running AI; what it can do is shown on its own page.
 */

const STATUSES: readonly SpecialistStatus[] = ['active', 'draft', 'paused', 'disabled', 'archived'];

/** Errors with their own message; anything else shows the generic one. */
const ERRORS: ReadonlySet<string> = new Set([
  'invalid_specialist',
  'department_not_assignable',
  'permission_denied',
  'organization_inactive',
  'invalid_specialist_transition',
  'specialist_archived',
  'specialist_concurrency_conflict',
  'specialist_not_ready',
]);

const codeOf = (error: unknown) => errorCode(error, AgentRequestError, ERRORS);

/** The filters of the list, as the person set them. */
interface Filters {
  readonly q: string;
  readonly status: SpecialistStatus | '';
  readonly departmentId: string;
  readonly skill: string;
  readonly autonomy: AgentAutonomyLevel | '';
}

const NO_FILTERS: Filters = { q: '', status: '', departmentId: '', skill: '', autonomy: '' };

/** A status change that needs the person to read what it does first. */
type Pending = { readonly agent: AgentView; readonly to: SpecialistStatus };

export function AgentsPage({
  client,
  canManage,
  canReadTools = false,
}: {
  readonly client: AgentsClient;
  readonly canManage: boolean;
  /** `tool.read`: the tools catalogue next to the skills. */
  readonly canReadTools?: boolean;
}) {
  const intl = useIntl();
  const { departments } = useOfficeData();
  const saved = useSpecialistSaved();
  const depts = readyList(departments);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [notice, setNotice] = useState<
    | {
        readonly code: string;
        readonly name?: string;
        readonly problems?: readonly ReadinessProblemView[];
      }
    | undefined
  >();
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [search, setSearch] = useState('');
  // The cursors of the pages already seen: the last one is the current page's.
  const [cursors, setCursors] = useState<readonly (string | undefined)[]>([undefined]);
  const [reload, setReload] = useState(0);
  const [skills, setSkills] = useState<readonly string[]>([]);
  const [pending, setPending] = useState<Pending | undefined>();
  const cursor = cursors[cursors.length - 1];
  // The page asked for: until its answer arrives, the list is loading.
  const request = JSON.stringify([cursor, filters, reload]);
  const [loaded, setLoaded] = useState<
    { readonly request: string; readonly page: AgentPageView | 'error' } | undefined
  >();
  const page = loaded?.request === request ? loaded.page : 'loading';

  useEffect(() => {
    let live = true;
    client.skills().then(
      (list) => live && setSkills([...new Set(list.map((s) => s.id))]),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    let live = true;
    const asked = JSON.stringify([cursor, filters, reload]);
    client
      .page({
        ...(cursor === undefined ? {} : { cursor }),
        ...(filters.q === '' ? {} : { q: filters.q }),
        ...(filters.status === '' ? {} : { status: filters.status }),
        ...(filters.departmentId === '' ? {} : { departmentId: filters.departmentId }),
        ...(filters.skill === '' ? {} : { skill: filters.skill }),
        ...(filters.autonomy === '' ? {} : { autonomy: filters.autonomy }),
      })
      .then(
        (found) => live && setLoaded({ request: asked, page: found }),
        () => live && setLoaded({ request: asked, page: 'error' }),
      );
    return () => {
      live = false;
    };
  }, [client, cursor, filters, reload]);

  const filter = (next: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...next }));
    setCursors([undefined]);
  };

  const apply = async (agent: AgentView, to: SpecialistStatus, reason?: string) => {
    setBusy(agent.id);
    setNotice(undefined);
    try {
      const updated = await client.setStatus(agent.id, agent.status, to, reason);
      saved(updated);
      setPending(undefined);
      const stopped = to === 'paused' || to === 'disabled';
      setNotice({ code: `moved.${to}${stopped ? '.stopped' : ''}`, name: updated.displayName });
      setReload((n) => n + 1);
    } catch (error) {
      const code = codeOf(error);
      setNotice({
        code: code === 'invalid_specialist' && to === 'disabled' ? 'invalid_reason' : code,
        name: agent.displayName,
        ...(error instanceof AgentRequestError ? { problems: error.problems } : {}),
      });
    } finally {
      setBusy(undefined);
    }
  };

  const move = (agent: AgentView, to: SpecialistStatus) => {
    // Activating needs no explanation: the server says what is missing, if anything.
    if (to === 'active') return void apply(agent, to);
    setNotice(undefined);
    setPending({ agent, to });
  };

  const open = (agent: AgentView) => {
    const department = depts.find((d) => d.id === agent.departmentId);
    if (department !== undefined) navigate(paths.agent(officeSlug(department), agent.id));
  };

  const skillName = (id: string) => {
    const key = `agents.skill.${id}.name`;
    return intl.messages[key] === undefined ? id : intl.formatMessage({ id: key });
  };
  const filtered =
    filters.q !== '' ||
    filters.status !== '' ||
    filters.departmentId !== '' ||
    filters.skill !== '' ||
    filters.autonomy !== '';

  return (
    <article className="mo-page agents-page">
      <PageHeader
        title={<FormattedMessage id="agents.title" />}
        description={<FormattedMessage id="agents.lead" />}
        actions={
          canManage && !creating ? (
            <Button className="agents__create" onClick={() => setCreating(true)}>
              <FormattedMessage id="agents.create" />
            </Button>
          ) : null
        }
      />
      {canManage && creating ? (
        <CreateAgent
          client={client}
          onCancel={() => setCreating(false)}
          onCreated={(agent) => {
            saved(agent);
            setCreating(false);
            setNotice({ code: 'created', name: agent.displayName });
            setReload((n) => n + 1);
          }}
        />
      ) : null}
      {notice === undefined ? null : (
        <StateMessage
          kind={notice.code === 'created' || notice.code.startsWith('moved.') ? 'success' : 'error'}
        >
          <FormattedMessage
            id={`agents.notice.${notice.code}`}
            values={{ name: notice.name ?? '' }}
          />
        </StateMessage>
      )}
      {notice?.problems === undefined ? null : <ReadinessProblems problems={notice.problems} />}
      {pending === undefined ? null : (
        <StatusChange
          pending={pending}
          busy={busy !== undefined}
          onCancel={() => setPending(undefined)}
          onConfirm={(reason) => void apply(pending.agent, pending.to, reason)}
        />
      )}
      <form
        className="mo-panel mo-page-section agents__filters"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          filter({ q: search.trim() });
        }}
      >
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="agents.filters.search" />
          </span>
          <input
            type="search"
            value={search}
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
            onBlur={() => search.trim() !== filters.q && filter({ q: search.trim() })}
          />
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="agents.filters.status" />
          </span>
          <select
            value={filters.status}
            onChange={(e) => filter({ status: e.target.value as Filters['status'] })}
          >
            <option value="">{intl.formatMessage({ id: 'agents.filters.all' })}</option>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {intl.formatMessage({ id: `agents.statusOne.${status}` })}
              </option>
            ))}
          </select>
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="agents.filters.department" />
          </span>
          <select
            value={filters.departmentId}
            onChange={(e) => filter({ departmentId: e.target.value })}
          >
            <option value="">{intl.formatMessage({ id: 'agents.filters.all' })}</option>
            {depts.map((d) => (
              <option key={d.id} value={d.id}>
                {departmentName(intl, d, 'name')}
              </option>
            ))}
          </select>
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="agents.filters.skill" />
          </span>
          <select value={filters.skill} onChange={(e) => filter({ skill: e.target.value })}>
            <option value="">{intl.formatMessage({ id: 'agents.filters.all' })}</option>
            {skills.map((id) => (
              <option key={id} value={id}>
                {skillName(id)}
              </option>
            ))}
          </select>
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="agents.filters.autonomy" />
          </span>
          <select
            value={filters.autonomy}
            onChange={(e) => filter({ autonomy: e.target.value as Filters['autonomy'] })}
          >
            <option value="">{intl.formatMessage({ id: 'agents.filters.all' })}</option>
            {AGENT_AUTONOMY_LEVELS.map((level) => (
              <option key={level} value={level}>
                {intl.formatMessage({ id: `agents.autonomy.level.${level}` })}
              </option>
            ))}
          </select>
        </label>
      </form>
      {page === 'loading' ? (
        <StateMessage kind="loading">
          <FormattedMessage id="agents.loading" />
        </StateMessage>
      ) : page === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="agents.error" />
        </StateMessage>
      ) : page.specialists.length === 0 && cursors.length === 1 ? (
        <StateMessage kind="empty">
          <FormattedMessage id={filtered ? 'agents.filters.none' : 'agents.none'} />
        </StateMessage>
      ) : (
        <section
          className="mo-panel mo-page-section"
          aria-label={intl.formatMessage({ id: 'agents.title' })}
        >
          <ul className="mo-list">
            {page.specialists.map((agent) => {
              const department = depts.find((d) => d.id === agent.departmentId);
              return (
                <li key={agent.id} className="mo-list-item">
                  <div className="mo-list-item__main">
                    <button
                      type="button"
                      className="mo-link-button mo-list-item__title"
                      onClick={() => open(agent)}
                      disabled={department === undefined || agent.status === 'archived'}
                    >
                      {agent.displayName}
                    </button>{' '}
                    <Badge>
                      <FormattedMessage id={`agents.statusOne.${agent.status}`} />
                    </Badge>
                    <span className="mo-list-item__meta">
                      {department === undefined
                        ? agent.departmentId
                        : departmentName(intl, department, 'name')}
                      {agent.purpose ? ` · ${agent.purpose}` : ''}
                    </span>
                    {agent.lastStatusChange?.reason ? (
                      <span className="mo-list-item__meta">
                        <FormattedMessage
                          id="agents.lastChange.reason"
                          values={{ reason: agent.lastStatusChange.reason }}
                        />
                      </span>
                    ) : null}
                  </div>
                  {canManage && TRANSITIONS[agent.status].length > 0 ? (
                    <div className="mo-list-item__actions">
                      {TRANSITIONS[agent.status].map((to) => (
                        <button
                          key={to}
                          type="button"
                          className="mo-button mo-button--secondary mo-button--sm"
                          disabled={busy !== undefined}
                          onClick={() => move(agent, to)}
                        >
                          <FormattedMessage id={`agents.to.${to}`} />
                        </button>
                      ))}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <nav
            className="mo-form__actions"
            aria-label={intl.formatMessage({ id: 'agents.page.label' }, { page: cursors.length })}
          >
            <button
              type="button"
              className="mo-button mo-button--ghost mo-button--sm"
              disabled={cursors.length === 1}
              onClick={() => setCursors((list) => list.slice(0, -1))}
            >
              <FormattedMessage id="agents.page.previous" />
            </button>
            <span className="mo-hint">
              <FormattedMessage id="agents.page.label" values={{ page: cursors.length }} />
            </span>
            <button
              type="button"
              className="mo-button mo-button--ghost mo-button--sm"
              disabled={page.nextCursor === null}
              onClick={() => {
                const next = page.nextCursor;
                if (next !== null) setCursors((list) => [...list, next]);
              }}
            >
              <FormattedMessage id="agents.page.next" />
            </button>
          </nav>
        </section>
      )}
      <TeamReview client={client} />
      <CapabilityCatalogue client={client} canReadTools={canReadTools} />
    </article>
  );
}

/**
 * Pausing, disabling or archiving an agent (AE-4): what happens to its work in progress, in
 * words, and the reason, which disabling requires. Nothing changes until the person confirms.
 */
function StatusChange({
  pending,
  busy,
  onCancel,
  onConfirm,
}: {
  readonly pending: Pending;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const required = pending.to === 'disabled';
  const name = pending.agent.displayName;
  return (
    <form
      className="mo-panel mo-page-section"
      aria-labelledby="agent-status-change"
      onSubmit={(e) => {
        e.preventDefault();
        if (required && reason.trim() === '') return;
        onConfirm(reason);
      }}
    >
      <h2 id="agent-status-change" className="mo-section-title">
        <FormattedMessage id={`agents.change.title.${pending.to}`} values={{ name }} />
      </h2>
      <p className="mo-hint">
        <FormattedMessage id={`agents.change.effect.${pending.to}`} />
      </p>
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage
            id={required ? 'agents.change.reason' : 'agents.change.reasonOptional'}
          />
        </span>
        <textarea
          value={reason}
          maxLength={500}
          rows={2}
          required={required}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className="mo-form__actions">
        <button
          type="submit"
          className="mo-button mo-button--primary"
          disabled={busy || (required && reason.trim() === '')}
        >
          <FormattedMessage id="agents.change.confirm" />
        </button>
        <button type="button" className="mo-button mo-button--ghost" onClick={onCancel}>
          <FormattedMessage id="agents.change.cancel" />
        </button>
      </div>
    </form>
  );
}

function CreateAgent({
  client,
  onCancel,
  onCreated,
}: {
  readonly client: AgentsClient;
  readonly onCancel: () => void;
  readonly onCreated: (agent: SpecialistView) => void;
}) {
  const intl = useIntl();
  const { departments } = useOfficeData();
  const depts = readyList(departments);
  const [templates, setTemplates] = useState<readonly AgentTemplateView[] | 'error' | undefined>();
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [locale, setLocale] = useState<'es' | 'en'>(intl.locale.startsWith('en') ? 'en' : 'es');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    client.templates().then(
      (list) => live && setTemplates(list),
      () => live && setTemplates('error'),
    );
    return () => {
      live = false;
    };
  }, [client]);

  const chosen = Array.isArray(templates) ? templates.find((t) => t.id === templateId) : undefined;
  const department = depts.find((d) => d.typeId === chosen?.departmentTypeId);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (chosen === undefined || name.trim() === '') return;
    setSending(true);
    setError(undefined);
    try {
      onCreated(await client.create({ templateId: chosen.id, displayName: name.trim(), locale }));
    } catch (failure) {
      setError(codeOf(failure));
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="mo-panel mo-page-section" onSubmit={(e) => void submit(e)}>
      <h2 className="mo-section-title">
        <FormattedMessage id="agents.create.title" />
      </h2>
      {templates === undefined ? (
        <StateMessage kind="loading" inline>
          <FormattedMessage id="agents.loading" />
        </StateMessage>
      ) : templates === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="agents.create.templatesError" />
        </StateMessage>
      ) : (
        <>
          <label className="mo-field">
            <span className="mo-label">
              <FormattedMessage id="agents.create.template" />
            </span>
            <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} required>
              <option value="">{intl.formatMessage({ id: 'agents.create.choose' })}</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {intl.messages[t.nameKey] === undefined
                    ? t.id
                    : intl.formatMessage({ id: t.nameKey })}
                </option>
              ))}
            </select>
          </label>
          {chosen === undefined ? null : (
            <div className="mo-hint agents__template">
              <p>
                <FormattedMessage
                  id="agents.create.department"
                  values={{
                    department:
                      department === undefined
                        ? chosen.departmentTypeId
                        : departmentName(intl, department, 'name'),
                  }}
                />
              </p>
              <p>{chosen.purpose[locale] ?? ''}</p>
              <p>
                <FormattedMessage id="agents.create.skills" />{' '}
                {chosen.skills
                  .map((s: { readonly id: string }) => {
                    const key = `agents.skill.${s.id}.name`;
                    return intl.messages[key] === undefined
                      ? s.id
                      : intl.formatMessage({ id: key });
                  })
                  .join(', ')}
              </p>
            </div>
          )}
          <label className="mo-field">
            <span className="mo-label">
              <FormattedMessage id="agents.create.name" />
            </span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </label>
          <label className="mo-field">
            <span className="mo-label">
              <FormattedMessage id="agents.create.locale" />
            </span>
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value === 'en' ? 'en' : 'es')}
            >
              <option value="es">Español</option>
              <option value="en">English</option>
            </select>
          </label>
          <p className="mo-hint">
            <FormattedMessage id="agents.create.draft" />
          </p>
          {error === undefined ? null : (
            <StateMessage kind="error">
              <FormattedMessage id={`agents.notice.${error}`} values={{ name: '' }} />
            </StateMessage>
          )}
          <div className="mo-form__actions">
            <button
              type="submit"
              className="mo-button mo-button--primary"
              disabled={sending || chosen === undefined || name.trim() === ''}
            >
              <FormattedMessage id={sending ? 'agents.create.sending' : 'agents.create.submit'} />
            </button>
            <button type="button" className="mo-button mo-button--ghost" onClick={onCancel}>
              <FormattedMessage id="agents.create.cancel" />
            </button>
          </div>
        </>
      )}
    </form>
  );
}
