import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import type { AgentCapabilitiesView, AgentsClient } from './agentsClient.js';

/**
 * What an agent can do now (ADR-0062, ADR-0069), on its page: its version, its skills, the tools
 * those skills use with their risk and whether they need approval, and whether it is ready to
 * take work, with what stops it when it is not. Read from the API; nothing is inferred.
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
          <h3>
            <FormattedMessage id="agents.capabilities.skills" />
          </h3>
          {found.skills.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="agents.capabilities.noSkills" />
            </p>
          ) : (
            <ul className="coming">
              {found.skills.map((s) => (
                <li key={s.id} className="coming__item">
                  <strong>{message(`agents.skill.${s.id}.name`, s.id)}</strong>
                  {intl.messages[`agents.skill.${s.id}.description`] === undefined
                    ? null
                    : ` · ${intl.formatMessage({ id: `agents.skill.${s.id}.description` })}`}
                </li>
              ))}
            </ul>
          )}
          <h3>
            <FormattedMessage id="agents.capabilities.tools" />
          </h3>
          {found.tools.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="agents.capabilities.noTools" />
            </p>
          ) : (
            <ul className="coming">
              {found.tools.map((t) => (
                <li key={t.id} className="coming__item">
                  {message(`approvals.tool.${t.id}`, t.id)}
                  {t.riskLevel === null
                    ? ''
                    : ` · ${intl.formatMessage(
                        { id: 'approvals.risk' },
                        { level: message(`approvals.riskLevel.${t.riskLevel}`, t.riskLevel) },
                      )}`}
                  {t.approval === null
                    ? ''
                    : ` · ${message(`agents.approval.${t.approval}`, t.approval)}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
