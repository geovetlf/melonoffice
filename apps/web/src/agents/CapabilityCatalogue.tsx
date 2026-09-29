import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import type { AgentsClient, AgentTemplateView, SkillView, ToolView } from './agentsClient.js';

/**
 * The skills and tools catalogue (ADR-0026, ADR-0069), as the API gives it: what each skill lets
 * an agent do and read, which kinds of agent have it, and each tool's versions with their risk
 * and approval policy. Read only: skills and tools are catalogue data, changed in code.
 */

type Load<T> = T | 'loading' | 'error';

function useLoad<T>(load: (() => Promise<T>) | undefined): Load<T> | undefined {
  const [value, setValue] = useState<Load<T> | undefined>(
    load === undefined ? undefined : 'loading',
  );
  useEffect(() => {
    if (load === undefined) return;
    let live = true;
    load().then(
      (v) => live && setValue(v),
      () => live && setValue('error'),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return value;
}

export function CapabilityCatalogue({
  client,
  canReadTools,
}: {
  readonly client: AgentsClient;
  readonly canReadTools: boolean;
}) {
  const intl = useIntl();
  const skills = useLoad(client.skills);
  const templates = useLoad(client.templates);
  const tools = useLoad(canReadTools ? client.tools : undefined);

  const message = (id: string, fallback: string): string =>
    intl.messages[id] === undefined ? fallback : intl.formatMessage({ id });
  const toolName = (id: string) => message(`approvals.tool.${id}`, id);
  const readName = (permission: string) => {
    const resource = permission.split('.')[0] ?? permission;
    return message(`capabilities.reads.${resource}`, resource);
  };
  const agentsWith = (skill: SkillView): string[] =>
    Array.isArray(templates)
      ? (templates as readonly AgentTemplateView[])
          .filter((t) => t.skills.some((s) => s.id === skill.id && s.version === skill.version))
          .map((t) => message(t.nameKey, t.id))
      : [];

  return (
    <section className="dept-office__section" aria-labelledby="capabilities-title">
      <h2 id="capabilities-title">
        <FormattedMessage id="capabilities.title" />
      </h2>
      <p className="customers__meta">
        <FormattedMessage id="capabilities.lead" />
      </p>
      <h3 id="capabilities-skills">
        <FormattedMessage id="capabilities.skills" />
      </h3>
      {skills === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="agents.loading" />
        </p>
      ) : skills === 'error' || skills === undefined ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="capabilities.error" />
        </p>
      ) : skills.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="capabilities.noSkills" />
        </p>
      ) : (
        <ul className="documents__list" aria-labelledby="capabilities-skills">
          {skills.map((skill) => {
            const agents = agentsWith(skill);
            return (
              <li key={`${skill.id}@${skill.version}`} className="approval-card">
                <div className="documents__main">
                  <strong>{message(skill.nameKey, skill.id)}</strong>
                  <span className="documents__meta">{message(skill.descriptionKey, '')}</span>
                  <span className="documents__meta">
                    {skill.tools.length === 0 ? (
                      <FormattedMessage id="capabilities.noTools" />
                    ) : (
                      <FormattedMessage
                        id="capabilities.uses"
                        values={{ tools: skill.tools.map((t) => toolName(t.id)).join(', ') }}
                      />
                    )}
                  </span>
                  {skill.reads.length === 0 ? null : (
                    <span className="documents__meta">
                      <FormattedMessage
                        id="capabilities.reads"
                        values={{ records: [...new Set(skill.reads.map(readName))].join(', ') }}
                      />
                    </span>
                  )}
                  {agents.length === 0 ? null : (
                    <span className="documents__meta">
                      <FormattedMessage
                        id="capabilities.agents"
                        values={{ agents: agents.join(', ') }}
                      />
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {tools === undefined ? null : (
        <>
          <h3 id="capabilities-tools">
            <FormattedMessage id="capabilities.tools" />
          </h3>
          {tools === 'loading' ? (
            <p className="panel__empty" role="status">
              <FormattedMessage id="agents.loading" />
            </p>
          ) : tools === 'error' ? (
            <p className="panel__empty" role="alert">
              <FormattedMessage id="capabilities.error" />
            </p>
          ) : tools.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="capabilities.noToolsAtAll" />
            </p>
          ) : (
            <ul className="documents__list" aria-labelledby="capabilities-tools">
              {tools.map((tool: ToolView) => (
                <li key={tool.id} className="approval-card">
                  <div className="documents__main">
                    <strong>{toolName(tool.id)}</strong>
                    <span className="documents__meta">
                      {message(`capabilities.toolDescription.${tool.id}`, '')}
                    </span>
                    <span className="documents__meta">
                      <FormattedMessage id={`capabilities.toolStatus.${statusOf(tool.status)}`} />
                    </span>
                    <ul className="capabilities__versions">
                      {tool.versions.map((v) => (
                        <li key={v.version} className="documents__meta">
                          <FormattedMessage
                            id="capabilities.version"
                            values={{ version: v.version }}
                          />
                          {' · '}
                          <FormattedMessage
                            id={v.mutating ? 'capabilities.changes' : 'capabilities.readsOnly'}
                          />
                          {' · '}
                          {intl.formatMessage(
                            { id: 'approvals.risk' },
                            { level: message(`approvals.riskLevel.${v.riskLevel}`, v.riskLevel) },
                          )}
                          {' · '}
                          {message(`agents.approval.${v.approvalPolicy}`, v.approvalPolicy)}
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

const TOOL_STATUSES = new Set(['draft', 'active', 'paused', 'disabled', 'archived']);
const statusOf = (status: string): string => (TOOL_STATUSES.has(status) ? status : 'other');
