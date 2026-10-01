import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { StateMessage } from '@melonoffice/ui';
import { useState } from 'react';
import {
  AGENT_AUTONOMY_LEVELS,
  type AgentAutonomyLevel,
  type AgentsClient,
} from './agentsClient.js';

/**
 * How far an agent acts on its own (AE-4.4, ADR-0116), on its page: its level in plain words and,
 * for a person with `specialist.manage`, the three levels to choose from. Whatever the level,
 * sensitive actions wait for a person; the server decides every action, never this screen.
 */
export function AgentAutonomy({
  client,
  agentId,
  version,
  level,
  canManage,
  onChanged,
}: {
  readonly client: AgentsClient;
  readonly agentId: string;
  readonly version: number;
  readonly level: AgentAutonomyLevel;
  readonly canManage: boolean;
  readonly onChanged: () => void;
}) {
  const intl = useIntl();
  const [chosen, setChosen] = useState<AgentAutonomyLevel>(level);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'error' | undefined>();

  async function save() {
    setSaving(true);
    setNotice(undefined);
    try {
      await client.setAutonomy(agentId, { fromVersion: version, autonomy: chosen });
      setNotice('saved');
      onChanged();
    } catch {
      setNotice('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="agent-autonomy">
      <h3 id="agent-autonomy" className="mo-subsection-title">
        <FormattedMessage id="agents.autonomy.title" />
      </h3>
      {canManage ? (
        <fieldset className="mo-field" aria-labelledby="agent-autonomy">
          {AGENT_AUTONOMY_LEVELS.map((option) => (
            <label key={option} className="agent-autonomy__option">
              <input
                type="radio"
                name={`autonomy-${agentId}`}
                value={option}
                checked={chosen === option}
                onChange={() => setChosen(option)}
              />{' '}
              <strong>{intl.formatMessage({ id: `agents.autonomy.level.${option}` })}</strong>
              <span className="mo-hint">
                {' '}
                {intl.formatMessage({ id: `agents.autonomy.effect.${option}` })}
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p>
          <strong>
            <FormattedMessage id={`agents.autonomy.level.${level}`} />
          </strong>{' '}
          <span className="mo-hint">
            <FormattedMessage id={`agents.autonomy.effect.${level}`} />
          </span>
        </p>
      )}
      <p className="mo-hint">
        <FormattedMessage id="agents.autonomy.sensitive" />
      </p>
      {notice === undefined ? null : (
        <StateMessage kind={notice === 'error' ? 'error' : 'success'}>
          <FormattedMessage id={`agents.autonomy.${notice}`} />
        </StateMessage>
      )}
      {canManage ? (
        <div className="mo-form__actions">
          <button
            type="button"
            className="mo-button mo-button--secondary mo-button--sm"
            disabled={saving || chosen === level}
            onClick={() => void save()}
          >
            <FormattedMessage id="agents.autonomy.save" />
          </button>
        </div>
      ) : null}
    </div>
  );
}
