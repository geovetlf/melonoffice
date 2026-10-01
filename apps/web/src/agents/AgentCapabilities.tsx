import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useCallback, useEffect, useState } from 'react';
import type { AgentCapabilitiesView, AgentsClient } from './agentsClient.js';
import { ReadinessProblems } from './ReadinessProblems.js';

/**
 * What an agent can do now (ADR-0062, ADR-0069, ADR-0083), on its page: its version, then each
 * skill at the version it has, and under it what that skill lets it do: the tools it uses, with
 * their risk and whether each use waits for approval, the actions it may propose and the records
 * it reads. A tool reaches an agent only through a skill, so there is no separate tool list; one
 * no skill grants shows as a problem. Read from the API; nothing is inferred.
 *
 * A skill with a newer version (ADR-0084) says what the newer one adds, and a person with
 * `specialist.manage` may move the agent to it, after confirming; nothing moves by itself.
 */
export function AgentCapabilities({
  client,
  agentId,
  canManage = false,
}: {
  readonly client: AgentsClient;
  readonly agentId: string;
  /** `specialist.manage`: only then can a skill be moved to its newer version. */
  readonly canManage?: boolean;
}) {
  const intl = useIntl();
  const [found, setFound] = useState<AgentCapabilitiesView | 'error' | undefined>();
  const [upgrading, setUpgrading] = useState<string | undefined>();
  const [notice, setNotice] = useState<'upgraded' | 'error' | undefined>();
  const load = useCallback(
    (live: () => boolean) =>
      client.capabilities(agentId).then(
        (value) => live() && setFound(value),
        () => live() && setFound('error'),
      ),
    [client, agentId],
  );
  useEffect(() => {
    let live = true;
    void load(() => live);
    return () => {
      live = false;
    };
  }, [load]);

  async function upgrade(view: AgentCapabilitiesView, skillId: string, to: number) {
    const name =
      intl.messages[`agents.skill.${skillId}.name`] === undefined
        ? skillId
        : intl.formatMessage({ id: `agents.skill.${skillId}.name` });
    const ask = intl.formatMessage({ id: 'agents.upgrade.confirm' }, { skill: name, version: to });
    if (!globalThis.confirm(ask)) return;
    setUpgrading(skillId);
    setNotice(undefined);
    try {
      await client.upgradeSkill(agentId, { fromVersion: view.version, skillId, version: to });
      setNotice('upgraded');
    } catch {
      setNotice('error');
    } finally {
      setUpgrading(undefined);
      await load(() => true);
    }
  }
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
    <section className="mo-panel mo-page-section" aria-labelledby="agent-capabilities">
      <h2 id="agent-capabilities" className="mo-section-title">
        <FormattedMessage id="agents.capabilities.title" />
      </h2>
      {found === undefined ? (
        <StateMessage kind="loading">
          <FormattedMessage id="agents.loading" />
        </StateMessage>
      ) : found === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="agents.capabilities.error" />
        </StateMessage>
      ) : (
        <>
          <p className="mo-hint">
            <FormattedMessage
              id="agents.capabilities.version"
              values={{ version: found.version }}
            />{' '}
            ·{' '}
            <FormattedMessage
              id={found.ready ? 'agents.capabilities.ready' : 'agents.capabilities.notReady'}
            />
          </p>
          <ReadinessProblems problems={found.problems} />
          {notice === undefined ? null : (
            <StateMessage kind={notice === 'error' ? 'error' : 'success'}>
              <FormattedMessage id={`agents.upgrade.${notice}`} />
            </StateMessage>
          )}
          <h3 id="agent-capabilities-skills" className="mo-subsection-title">
            <FormattedMessage id="agents.capabilities.skills" />
          </h3>
          {found.skills.length === 0 ? (
            <StateMessage kind="empty">
              <FormattedMessage id="agents.capabilities.noSkills" />
            </StateMessage>
          ) : (
            <ul className="agent-skills" aria-labelledby="agent-capabilities-skills">
              {found.skills.map((s) => {
                // The agent's own tools that this skill grants, at the versions it was given.
                const tools = found.tools.filter((t) => s.tools.includes(t.id));
                const newer = found.upgrades?.find((u) => u.skillId === s.id);
                return (
                  <li key={`${s.id}@${s.version}`} className="agent-skills__item">
                    <strong>{message(`agents.skill.${s.id}.name`, s.id)}</strong>{' '}
                    <span className="mo-hint">
                      <FormattedMessage
                        id="agents.capabilities.skillVersion"
                        values={{ version: s.version }}
                      />
                    </span>
                    {newer === undefined ? null : (
                      <span className="agent-skills__upgrade">
                        <span className="agent-skills__line">
                          {message(
                            `agents.upgrade.${s.id}.${newer.to}`,
                            intl.formatMessage(
                              { id: 'agents.upgrade.available' },
                              { version: newer.to },
                            ),
                          )}
                        </span>
                        {canManage ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            disabled={upgrading !== undefined}
                            onClick={() => void upgrade(found, s.id, newer.to)}
                          >
                            <FormattedMessage
                              id={
                                upgrading === s.id
                                  ? 'agents.upgrade.working'
                                  : 'agents.upgrade.action'
                              }
                              values={{ version: newer.to }}
                            />
                          </Button>
                        ) : null}
                      </span>
                    )}
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
            <StateMessage kind="empty">
              <FormattedMessage id="agents.capabilities.noTools" />
            </StateMessage>
          ) : null}
        </>
      )}
    </section>
  );
}
