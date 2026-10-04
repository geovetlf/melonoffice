import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useCallback, useEffect, useState } from 'react';
import {
  AgentRequestError,
  type AgentCapabilitiesView,
  type AgentsClient,
  type AgentView,
} from './agentsClient.js';
import { AgentAutonomy } from './AgentAutonomy.js';
import { AgentHistory } from './AgentHistory.js';
import { AgentProfile } from './AgentProfile.js';
import { AgentMemory, AgentWorkSettings } from './AgentWork.js';
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
  departments = [],
  onMoved,
}: {
  readonly client: AgentsClient;
  readonly agentId: string;
  /** `specialist.manage`: only then can a skill be moved to its newer version. */
  readonly canManage?: boolean;
  /** The organization's departments by id, with their names, for a move (ADR-0141). */
  readonly departments?: readonly { readonly id: string; readonly name: string }[];
  /** After the agent moved to another department: the page it now has. */
  readonly onMoved?: (agent: AgentView) => void;
}) {
  const intl = useIntl();
  const [found, setFound] = useState<AgentCapabilitiesView | 'error' | undefined>();
  const [upgrading, setUpgrading] = useState<string | undefined>();
  const [notice, setNotice] = useState<
    'upgraded' | 'error' | 'added' | 'removed' | 'moved' | 'conflict' | undefined
  >();
  const [adding, setAdding] = useState('');
  const [moving, setMoving] = useState('');
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
    // The Agent Guardian's warning (G-2): the workflows that would lose a tool, said first.
    const warning = breaksOf(view.upgrades?.find((u) => u.skillId === skillId));
    const ask = [
      ...(warning === undefined ? [] : [warning]),
      intl.formatMessage({ id: 'agents.upgrade.confirm' }, { skill: name, version: to }),
    ].join('\n\n');
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
  /** One more skill, or one fewer (ADR-0141): the server derives the tools, after confirming. */
  async function changeSkills(
    view: AgentCapabilitiesView,
    skillId: string,
    change: 'add' | 'remove',
  ) {
    const name = message(`agents.skill.${skillId}.name`, skillId);
    const warning =
      change === 'remove' ? breaksOf(view.removals?.find((r) => r.skillId === skillId)) : undefined;
    const ask = [
      ...(warning === undefined ? [] : [warning]),
      intl.formatMessage({ id: `agents.skills.${change}Confirm` }, { skill: name }),
    ].join('\n\n');
    if (!globalThis.confirm(ask)) return;
    setUpgrading(skillId);
    setNotice(undefined);
    try {
      if (change === 'add') {
        const version = view.addable?.find((a) => a.skillId === skillId)?.version;
        if (client.addSkill === undefined || version === undefined) return;
        await client.addSkill(agentId, { fromVersion: view.version, skillId, version });
        setAdding('');
        setNotice('added');
      } else {
        if (client.removeSkill === undefined) return;
        await client.removeSkill(agentId, { fromVersion: view.version, skillId });
        setNotice('removed');
      }
    } catch (error) {
      setNotice(
        error instanceof AgentRequestError && error.code === 'specialist_concurrency_conflict'
          ? 'conflict'
          : 'error',
      );
    } finally {
      setUpgrading(undefined);
      await load(() => true);
    }
  }
  const departmentNameOf = (id: string) => departments.find((d) => d.id === id)?.name ?? id;
  /** Another department (ADR-0141), after confirming what it leaves behind. */
  async function move(view: AgentCapabilitiesView, departmentId: string) {
    const change = client.change;
    if (change === undefined) return;
    const leaves = view.moveLeaves ?? [];
    const ask = [
      ...(leaves.length === 0
        ? []
        : [
            intl.formatMessage(
              { id: 'agents.move.leaves' },
              { workflows: leaves.map((l) => l.name).join(', ') },
            ),
          ]),
      intl.formatMessage(
        { id: 'agents.move.confirm' },
        { department: departmentNameOf(departmentId) },
      ),
    ].join('\n\n');
    if (!globalThis.confirm(ask)) return;
    setUpgrading('department');
    setNotice(undefined);
    try {
      const moved = await change.call(client, agentId, {
        fromVersion: view.version,
        departmentId,
      });
      setMoving('');
      setNotice('moved');
      onMoved?.(moved);
    } catch (error) {
      setNotice(
        error instanceof AgentRequestError && error.code === 'specialist_concurrency_conflict'
          ? 'conflict'
          : 'error',
      );
    } finally {
      setUpgrading(undefined);
      await load(() => true);
    }
  }
  const message = (id: string, fallback: string) =>
    intl.messages[id] === undefined ? fallback : intl.formatMessage({ id });
  /** What an upgrade breaks, in words, or undefined when it breaks nothing. */
  function breaksOf(
    upgrade:
      | { readonly breaks?: NonNullable<AgentCapabilitiesView['upgrades']>[number]['breaks'] }
      | undefined,
  ): string | undefined {
    const breaks = upgrade?.breaks ?? [];
    if (breaks.length === 0) return undefined;
    const workflows = [...new Set(breaks.map((b) => b.name))].join(', ');
    const tools = [
      ...new Set(
        breaks.map((b) => {
          const id = b.tool.split('@')[0] ?? b.tool;
          return message(`approvals.tool.${id}`, id);
        }),
      ),
    ].join(', ');
    return intl.formatMessage({ id: 'agents.upgrade.breaks' }, { workflows, tools });
  }
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
          <AgentProfile
            client={client}
            agentId={agentId}
            version={found.version}
            purpose={found.purpose ?? null}
            description={found.description ?? null}
            canManage={canManage}
            onChanged={() => void load(() => true)}
          />
          <AgentAutonomy
            key={`${found.version}`}
            client={client}
            agentId={agentId}
            version={found.version}
            level={found.autonomy ?? 'controlled'}
            canManage={canManage}
            onChanged={() => void load(() => true)}
          />
          <AgentWorkSettings
            key={`work-${found.version}`}
            client={client}
            agentId={agentId}
            version={found.version}
            settings={found.work ?? { memory: false, aiVerification: false, collaboration: false }}
            canManage={canManage}
            onChanged={() => void load(() => true)}
          />
          <AgentMemory client={client} agentId={agentId} canManage={canManage} />
          {notice === undefined ? null : (
            <StateMessage kind={notice === 'error' ? 'error' : 'success'}>
              <FormattedMessage
                id={
                  notice === 'upgraded' || notice === 'error'
                    ? `agents.upgrade.${notice}`
                    : `agents.skills.${notice}`
                }
              />
            </StateMessage>
          )}
          <h3 id="agent-capabilities-skills" className="mo-subsection-title">
            <FormattedMessage id="agents.capabilities.skills" />
          </h3>
          {canManage ? (
            <p className="mo-hint">
              <FormattedMessage id="agents.capabilities.versionHint" />
            </p>
          ) : null}
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
                    {canManage &&
                    client.removeSkill !== undefined &&
                    found.removals?.some((r) => r.skillId === s.id) === true ? (
                      <>
                        {' '}
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={upgrading !== undefined}
                          aria-label={intl.formatMessage(
                            { id: 'agents.skills.remove' },
                            { skill: message(`agents.skill.${s.id}.name`, s.id) },
                          )}
                          onClick={() => void changeSkills(found, s.id, 'remove')}
                        >
                          <FormattedMessage id="agents.skills.removeShort" />
                        </Button>
                      </>
                    ) : null}
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
                        {breaksOf(newer) === undefined ? null : (
                          <span className="agent-skills__line" role="note">
                            {breaksOf(newer)}
                          </span>
                        )}
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
          {canManage && client.addSkill !== undefined && (found.addable?.length ?? 0) > 0 ? (
            <form
              className="mo-form agent-skills__add"
              onSubmit={(event) => {
                event.preventDefault();
                if (adding !== '') void changeSkills(found, adding, 'add');
              }}
            >
              <label className="mo-field">
                <span className="mo-label">
                  <FormattedMessage id="agents.skills.add" />
                </span>
                <select value={adding} onChange={(event) => setAdding(event.target.value)}>
                  <option value="">{intl.formatMessage({ id: 'agents.skills.choose' })}</option>
                  {found.addable?.map((a) => (
                    <option key={a.skillId} value={a.skillId}>
                      {message(`agents.skill.${a.skillId}.name`, a.skillId)}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mo-form__actions">
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={adding === '' || upgrading !== undefined}
                >
                  <FormattedMessage id="agents.skills.addAction" />
                </Button>
              </div>
            </form>
          ) : null}
          {canManage && client.change !== undefined && (found.moves?.length ?? 0) > 0 ? (
            <form
              className="mo-form agent-move"
              onSubmit={(event) => {
                event.preventDefault();
                if (moving !== '') void move(found, moving);
              }}
            >
              <label className="mo-field">
                <span className="mo-label">
                  <FormattedMessage id="agents.move.label" />
                </span>
                <select value={moving} onChange={(event) => setMoving(event.target.value)}>
                  <option value="">{intl.formatMessage({ id: 'agents.move.choose' })}</option>
                  {found.moves?.map((m) => (
                    <option
                      key={m.departmentId}
                      value={m.departmentId}
                      disabled={m.blockedBy.length > 0}
                    >
                      {m.blockedBy.length === 0
                        ? departmentNameOf(m.departmentId)
                        : intl.formatMessage(
                            { id: 'agents.move.blocked' },
                            {
                              department: departmentNameOf(m.departmentId),
                              skills: m.blockedBy
                                .map((id) => message(`agents.skill.${id}.name`, id))
                                .join(', '),
                            },
                          )}
                    </option>
                  ))}
                </select>
              </label>
              <p className="mo-hint">
                <FormattedMessage id="agents.move.hint" />
              </p>
              <div className="mo-form__actions">
                <Button
                  type="submit"
                  size="sm"
                  variant="secondary"
                  disabled={moving === '' || upgrading !== undefined}
                >
                  <FormattedMessage id="agents.move.action" />
                </Button>
              </div>
            </form>
          ) : null}
          {found.tools.length === 0 ? (
            <StateMessage kind="empty">
              <FormattedMessage id="agents.capabilities.noTools" />
            </StateMessage>
          ) : null}
          <AgentHistory
            client={client}
            agentId={agentId}
            version={found.version}
            departments={departments}
            canManage={canManage}
            onChanged={() => void load(() => true)}
          />
        </>
      )}
    </section>
  );
}
