import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { navigate } from '../identity/router.js';
import { readyList, useOfficeData, useSpecialistSaved } from '../office/OfficeData.js';
import { departmentName, officeSlug } from '../office/departments.js';
import type { SpecialistStatus, SpecialistView } from '../office/officeClient.js';
import { paths } from '../shell/routes.js';
import {
  AgentRequestError,
  TRANSITIONS,
  type AgentTemplateView,
  type AgentsClient,
} from './agentsClient.js';

/**
 * Agents (ADR-0025, ADR-0062): every agent of the organization by status, creating one from a
 * template, and moving its status (activate, pause, disable, archive). An agent is a record, not
 * running AI: creating one starts it as a draft, and only an active agent takes new work. What an
 * agent can do is shown on its own page.
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
]);

const codeOf = (error: unknown) => {
  const code = error instanceof AgentRequestError ? (error.code ?? 'generic') : 'generic';
  return ERRORS.has(code) ? code : 'generic';
};

export function AgentsPage({
  client,
  canManage,
}: {
  readonly client: AgentsClient;
  readonly canManage: boolean;
}) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const saved = useSpecialistSaved();
  const depts = readyList(departments);
  const agents = readyList(specialists);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | undefined>();
  const [notice, setNotice] = useState<{ code: string; name?: string } | undefined>();

  const move = async (agent: SpecialistView, to: SpecialistStatus) => {
    if (
      to === 'archived' &&
      !globalThis.confirm(
        intl.formatMessage({ id: 'agents.archive.confirm' }, { name: agent.displayName }),
      )
    ) {
      return;
    }
    setBusy(agent.id);
    setNotice(undefined);
    try {
      const updated = await client.setStatus(agent.id, agent.status, to);
      saved(updated);
      setNotice({ code: `moved.${to}`, name: updated.displayName });
    } catch (error) {
      setNotice({ code: codeOf(error) });
    } finally {
      setBusy(undefined);
    }
  };

  const open = (agent: SpecialistView) => {
    const department = depts.find((d) => d.id === agent.departmentId);
    if (department !== undefined) navigate(paths.agent(officeSlug(department), agent.id));
  };

  return (
    <article className="dept-office agents-page">
      <h1 className="dept-office__title">
        <FormattedMessage id="agents.title" />
      </h1>
      <p className="documents__lead">
        <FormattedMessage id="agents.lead" />
      </p>
      {canManage ? (
        creating ? (
          <CreateAgent
            client={client}
            onCancel={() => setCreating(false)}
            onCreated={(agent) => {
              saved(agent);
              setCreating(false);
              setNotice({ code: 'created', name: agent.displayName });
            }}
          />
        ) : (
          <button type="button" className="customers__tab" onClick={() => setCreating(true)}>
            <FormattedMessage id="agents.create" />
          </button>
        )
      ) : null}
      {notice === undefined ? null : (
        <p
          className="panel__empty"
          role={notice.code === 'created' || notice.code.startsWith('moved.') ? 'status' : 'alert'}
        >
          <FormattedMessage
            id={`agents.notice.${notice.code}`}
            values={{ name: notice.name ?? '' }}
          />
        </p>
      )}
      {specialists.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="agents.loading" />
        </p>
      ) : specialists.status !== 'ready' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="agents.error" />
        </p>
      ) : agents.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="agents.none" />
        </p>
      ) : (
        STATUSES.map((status) => {
          const inStatus = agents
            .filter((a) => a.status === status)
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
          if (inStatus.length === 0) return null;
          const titleId = `agents-${status}`;
          return (
            <section key={status} className="dept-office__section" aria-labelledby={titleId}>
              <h2 id={titleId}>
                <FormattedMessage id={`agents.status.${status}`} />{' '}
                <span className="customers__count">{inStatus.length}</span>
              </h2>
              <ul className="documents__list">
                {inStatus.map((agent) => {
                  const department = depts.find((d) => d.id === agent.departmentId);
                  return (
                    <li key={agent.id} className="approval-card">
                      <div className="documents__main">
                        <button
                          type="button"
                          className="ai-usage__row documents__name"
                          onClick={() => open(agent)}
                          disabled={department === undefined || agent.status === 'archived'}
                        >
                          {agent.displayName}
                        </button>
                        <span className="documents__meta">
                          {department === undefined
                            ? agent.departmentId
                            : departmentName(intl, department, 'name')}
                          {agent.purpose ? ` · ${agent.purpose}` : ''}
                        </span>
                      </div>
                      {canManage && TRANSITIONS[agent.status].length > 0 ? (
                        <div className="customers__actions">
                          {TRANSITIONS[agent.status].map((to) => (
                            <button
                              key={to}
                              type="button"
                              className="customers__tab"
                              disabled={busy !== undefined}
                              onClick={() => void move(agent, to)}
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
            </section>
          );
        })
      )}
    </article>
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
    <form className="dept-office__section agents__create" onSubmit={(e) => void submit(e)}>
      <h2>
        <FormattedMessage id="agents.create.title" />
      </h2>
      {templates === undefined ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="agents.loading" />
        </p>
      ) : templates === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="agents.create.templatesError" />
        </p>
      ) : (
        <>
          <label className="documents__picker">
            <span>
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
            <div className="documents__hint">
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
          <label className="documents__picker">
            <span>
              <FormattedMessage id="agents.create.name" />
            </span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </label>
          <label className="documents__picker">
            <span>
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
          <p className="documents__hint">
            <FormattedMessage id="agents.create.draft" />
          </p>
          {error === undefined ? null : (
            <p className="panel__empty" role="alert">
              <FormattedMessage id={`agents.notice.${error}`} values={{ name: '' }} />
            </p>
          )}
          <div className="customers__actions">
            <button
              type="submit"
              className="customers__tab"
              disabled={sending || chosen === undefined || name.trim() === ''}
            >
              <FormattedMessage id={sending ? 'agents.create.sending' : 'agents.create.submit'} />
            </button>
            <button type="button" className="customers__tab" onClick={onCancel}>
              <FormattedMessage id="agents.create.cancel" />
            </button>
          </div>
        </>
      )}
    </form>
  );
}
