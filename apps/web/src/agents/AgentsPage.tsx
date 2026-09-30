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
  AgentRequestError,
  TRANSITIONS,
  type AgentTemplateView,
  type AgentsClient,
} from './agentsClient.js';
import { errorCode } from '../shell/errors.js';

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

const codeOf = (error: unknown) => errorCode(error, AgentRequestError, ERRORS);

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
      {specialists.status === 'loading' ? (
        <StateMessage kind="loading">
          <FormattedMessage id="agents.loading" />
        </StateMessage>
      ) : specialists.status !== 'ready' ? (
        <StateMessage kind="error">
          <FormattedMessage id="agents.error" />
        </StateMessage>
      ) : agents.length === 0 ? (
        <StateMessage kind="empty">
          <FormattedMessage id="agents.none" />
        </StateMessage>
      ) : (
        STATUSES.map((status) => {
          const inStatus = agents
            .filter((a) => a.status === status)
            .sort((a, b) => a.displayName.localeCompare(b.displayName));
          if (inStatus.length === 0) return null;
          const titleId = `agents-${status}`;
          return (
            <section key={status} className="mo-panel mo-page-section" aria-labelledby={titleId}>
              <h2 id={titleId} className="mo-section-title">
                <FormattedMessage id={`agents.status.${status}`} /> <Badge>{inStatus.length}</Badge>
              </h2>
              <ul className="mo-list">
                {inStatus.map((agent) => {
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
                        </button>
                        <span className="mo-list-item__meta">
                          {department === undefined
                            ? agent.departmentId
                            : departmentName(intl, department, 'name')}
                          {agent.purpose ? ` · ${agent.purpose}` : ''}
                        </span>
                      </div>
                      {canManage && TRANSITIONS[agent.status].length > 0 ? (
                        <div className="mo-list-item__actions">
                          {TRANSITIONS[agent.status].map((to) => (
                            <button
                              key={to}
                              type="button"
                              className="mo-button mo-button--secondary mo-button--sm"
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
      <CapabilityCatalogue client={client} canReadTools={canReadTools} />
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
