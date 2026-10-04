import { FormattedMessage } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useState, type FormEvent } from 'react';
import { AgentRequestError, type AgentsClient } from './agentsClient.js';

/** The most a purpose or description may say, as the server allows (ADR-0140). */
export const PROFILE_TEXT_MAX = 500;

type Notice = 'saved' | 'conflict' | 'error';

/**
 * What an agent is for, in a person's words (ADR-0140), on its page. A person with
 * `specialist.manage` rewrites its purpose and description as a new version; the server keeps
 * its skills, tools, permissions and policies as they are, so this form never sends them.
 */
export function AgentProfile({
  client,
  agentId,
  version,
  purpose,
  description,
  canManage,
  onChanged,
}: {
  readonly client: AgentsClient;
  readonly agentId: string;
  readonly version: number;
  readonly purpose: string | null;
  readonly description: string | null;
  readonly canManage: boolean;
  readonly onChanged: () => void;
}) {
  const [draft, setDraft] = useState({ purpose: purpose ?? '', description: description ?? '' });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | undefined>();
  // A new version read from the server is the new starting point; a saved notice stays.
  const [seenVersion, setSeenVersion] = useState(version);
  if (seenVersion !== version) {
    setSeenVersion(version);
    setDraft({ purpose: purpose ?? '', description: description ?? '' });
  }
  const save = client.setProfile;
  const editable = canManage && save !== undefined;
  const changes = {
    ...(draft.purpose.trim() === (purpose ?? '') ? {} : { purpose: draft.purpose.trim() || null }),
    ...(draft.description.trim() === (description ?? '')
      ? {}
      : { description: draft.description.trim() || null }),
  };
  const changed = Object.keys(changes).length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (save === undefined || !changed) return;
    setSaving(true);
    setNotice(undefined);
    try {
      await save.call(client, agentId, { fromVersion: version, ...changes });
      setNotice('saved');
      onChanged();
    } catch (error) {
      setNotice(
        error instanceof AgentRequestError && error.code === 'specialist_concurrency_conflict'
          ? 'conflict'
          : 'error',
      );
    } finally {
      setSaving(false);
    }
  }

  const fields = ['purpose', 'description'] as const;
  return (
    <div className="agent-profile-edit">
      <h3 id="agent-profile-edit" className="mo-subsection-title">
        <FormattedMessage id="agents.profile.title" />
      </h3>
      {editable ? (
        <form className="mo-form" onSubmit={(event) => void submit(event)}>
          {fields.map((field) => (
            <label key={field} className="mo-field">
              <span className="mo-label">
                <FormattedMessage id={`agents.profile.${field}`} />
              </span>
              <textarea
                value={draft[field]}
                maxLength={PROFILE_TEXT_MAX}
                rows={2}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [field]: e.target.value }));
                  setNotice(undefined);
                }}
              />
            </label>
          ))}
          <div className="mo-form__actions">
            <Button type="submit" size="sm" variant="secondary" disabled={saving || !changed}>
              <FormattedMessage id="agents.profile.save" />
            </Button>
          </div>
        </form>
      ) : (
        <dl className="agent-facts">
          {fields.map((field) => {
            const value = field === 'purpose' ? purpose : description;
            return (
              <div key={field} className="agent-facts__row">
                <dt>
                  <FormattedMessage id={`agents.profile.${field}`} />
                </dt>
                <dd className={value === null ? 'agent-facts__none' : undefined}>
                  {value ?? <FormattedMessage id="agents.profile.none" />}
                </dd>
              </div>
            );
          })}
        </dl>
      )}
      {notice === undefined ? null : (
        <StateMessage kind={notice === 'saved' ? 'success' : 'error'}>
          <FormattedMessage id={`agents.profile.${notice}`} />
        </StateMessage>
      )}
    </div>
  );
}
