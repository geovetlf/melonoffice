import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import type { AgentCapabilitiesView, AgentsClient } from './agentsClient.js';

/**
 * What an agent can do now (ADR-0062, ADR-0069, ADR-0083), on its page: its version, then each
 * skill at the version it has, and under it what that skill lets it do: the tools it uses, with
 * their risk and whether each use waits for approval, the actions it may propose and the records
 * it reads. A tool reaches an agent only through a skill, so there is no separate tool list; one
 * no skill grants shows as a problem. Read from the API; nothing is inferred.
 */
export function AgentCapabilities({
  client,
  agentId,
}: {
  readonly client: AgentsClient;
  readonly agentId: string;
}) {
  const intl = useIntl();
  const [found, setFound] = useState<AgentCapabilitiesView | 'error' | undefined>();
  useEffect(() => {
    let live = true;
    client.capabilities(agentId).then(
      (value) => live && setFound(value),
      () => live && setFound('error'),
    );
    return () => {
      live = false;
    };
  }, [client, agentId]);
  const message = (id: string, fallback: string) =>
    intl.messages[id] === undefined ? fallback : intl.formatMessage({ id });
  const readName = (permission: string) => {
    const resource = permission.split('.')[0] ?? permission;
    return message(`capabilities.reads.${resource}`, resource);
  };
  // What a tool is, how risky it is and whether each use waits for a person's approval.
  const toolLine = (t: AgentCapabilitiesView['tools'][number]) =>
    [
      message(`approvals.tool.${t.id}`, t.id),
      t.riskLevel === null
        ? null
        : intl.formatMessage(
            { id: 'approvals.risk' },
            { level: message(`approvals.riskLevel.${t.riskLevel}`, t.riskLevel) },
          ),
      t.approval === null ? null : message(`agents.approval.${t.approval}`, t.approval),
    ]
      .filter((part) => part !== null)
      .join(' · ');
  return (
    <section className="dept-office__section" aria-labelledby="agent-capabilities">
      <h2 id="agent-capabilities">
        <FormattedMessage id="agents.capabilities.title" />
      </h2>
      {found === undefined ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="agents.loading" />
        </p>
      ) : found === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="agents.capabilities.error" />
        </p>
      ) : (
        <>
          <p className="documents__meta">
            <FormattedMessage
              id="agents.capabilities.version"
              values={{ version: found.version }}
            />{' '}
            ·{' '}
            <FormattedMessage
              id={found.ready ? 'agents.capabilities.ready' : 'agents.capabilities.notReady'}
            />
          </p>
          {found.problems.length === 0 ? null : (
            <ul className="coming">
              {[...new Set(found.problems.map((p) => p.kind))].map((kind) => (
                <li key={kind} className="coming__item">
                  {message(`agents.problem.${kind}`, kind)}
                </li>
              ))}
            </ul>
          )}
          <h3 id="agent-capabilities-skills">
            <FormattedMessage id="agents.capabilities.skills" />
          </h3>
          {found.skills.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="agents.capabilities.noSkills" />
            </p>
          ) : (
            <ul className="agent-skills" aria-labelledby="agent-capabilities-skills">
              {found.skills.map((s) => {
                // The agent's own tools that this skill grants, at the versions it was given.
                const tools = found.tools.filter((t) => s.tools.includes(t.id));
                return (
                  <li key={`${s.id}@${s.version}`} className="agent-skills__item">
                    <strong>{message(`agents.skill.${s.id}.name`, s.id)}</strong>{' '}
                    <span className="documents__meta">
                      <FormattedMessage
                        id="agents.capabilities.skillVersion"
                        values={{ version: s.version }}
                      />
                    </span>
                    {intl.messages[`agents.skill.${s.id}.description`] === undefined ? null : (
                      <span className="agent-skills__line">
                        {intl.formatMessage({ id: `agents.skill.${s.id}.description` })}
                      </span>
                    )}
                    <ul className="agent-skills__grants">
                      {tools.length === 0 ? (
                        <li>
                          <FormattedMessage id="agents.capabilities.skillNoTools" />
                        </li>
                      ) : (
                        tools.map((t) => <li key={`${t.id}@${t.version}`}>{toolLine(t)}</li>)
                      )}
                      {s.actions.length === 0 ? null : (
                        <li>
                          <FormattedMessage
                            id="agents.capabilities.proposes"
                            values={{
                              actions: s.actions
                                .map((a) => message(`agents.action.${a}`, a))
                                .join(', '),
                            }}
                          />
                        </li>
                      )}
                      {s.reads.length === 0 ? null : (
                        <li>
                          <FormattedMessage
                            id="capabilities.reads"
                            values={{ records: [...new Set(s.reads.map(readName))].join(', ') }}
                          />
                        </li>
                      )}
                    </ul>
                  </li>
                );
              })}
            </ul>
          )}
          {found.tools.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="agents.capabilities.noTools" />
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
