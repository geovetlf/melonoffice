import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AGENT_WORK_SETTINGS,
  type AgentMemoryNoteView,
  type AgentsClient,
  type AgentWorkSettingsView,
} from './agentsClient.js';

/**
 * What else an agent's work uses (ADR-0117), on its page: its own memory, an AI check of its
 * answers and collaboration with other departments' agents. Each is off until a person with
 * `specialist.manage` switches it on, as a new version of the agent; the server decides.
 */
export function AgentWorkSettings({
  client,
  agentId,
  version,
  settings,
  canManage,
  onChanged,
}: {
  readonly client: AgentsClient;
  readonly agentId: string;
  readonly version: number;
  readonly settings: AgentWorkSettingsView;
  readonly canManage: boolean;
  readonly onChanged: () => void;
}) {
  const intl = useIntl();
  const [chosen, setChosen] = useState<AgentWorkSettingsView>(settings);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'error' | undefined>();
  const changed = AGENT_WORK_SETTINGS.filter((k) => chosen[k] !== settings[k]);
  const save = client.setWorkSettings;

  async function submit() {
    if (save === undefined || changed.length === 0) return;
    setSaving(true);
    setNotice(undefined);
    try {
      await save.call(client, agentId, {
        fromVersion: version,
        ...Object.fromEntries(changed.map((k) => [k, chosen[k]])),
      });
      setNotice('saved');
      onChanged();
    } catch {
      setNotice('error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="agent-work-settings">
      <h3 id="agent-work-settings" className="mo-subsection-title">
        <FormattedMessage id="agents.work.title" />
      </h3>
      <ul className="agent-work__list" aria-labelledby="agent-work-settings">
        {AGENT_WORK_SETTINGS.map((key) => (
          <li key={key}>
            <label>
              <input
                type="checkbox"
                checked={chosen[key]}
                disabled={!canManage || save === undefined}
                onChange={(event) => setChosen((c) => ({ ...c, [key]: event.target.checked }))}
              />{' '}
              <strong>{intl.formatMessage({ id: `agents.work.${key}` })}</strong>
              <span className="mo-hint">
                {' '}
                {intl.formatMessage({ id: `agents.work.${key}.effect` })}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {notice === undefined ? null : (
        <StateMessage kind={notice === 'error' ? 'error' : 'success'}>
          <FormattedMessage id={`agents.work.${notice}`} />
        </StateMessage>
      )}
      {canManage && save !== undefined ? (
        <div className="mo-form__actions">
          <Button
            size="sm"
            variant="secondary"
            disabled={saving || changed.length === 0}
            onClick={() => void submit()}
          >
            <FormattedMessage id="agents.work.save" />
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** The most a person's note may say, as the server allows (ADR-0117). */
export const MEMORY_TEXT_MAX = 300;

/**
 * An agent's own memory (ADR-0117): what it noted from its tasks and what a person told it. Never
 * Company Brain's. A person with `specialist.manage` adds a note, deletes one or all of them.
 */
export function AgentMemory({
  client,
  agentId,
  canManage,
}: {
  readonly client: AgentsClient;
  readonly agentId: string;
  readonly canManage: boolean;
}) {
  const intl = useIntl();
  const [found, setFound] = useState<
    { readonly enabled: boolean; readonly items: readonly AgentMemoryNoteView[] } | 'error'
  >();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const read = client.memories;

  const load = useCallback(() => {
    if (read === undefined) return () => undefined;
    let live = true;
    read.call(client, agentId).then(
      (m) => live && setFound(m),
      () => live && setFound('error'),
    );
    return () => {
      live = false;
    };
  }, [client, read, agentId]);

  useEffect(load, [load]);

  if (read === undefined) return null;

  async function act(work: () => Promise<unknown>, failure: string) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
      load();
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    const note = text.trim();
    const remember = client.remember;
    if (note === '' || remember === undefined) return;
    await act(async () => {
      await remember.call(client, agentId, note);
      setText('');
    }, 'agents.memory.error.add');
  }

  return (
    <div className="agent-memory">
      <h3 id="agent-memory" className="mo-subsection-title">
        <FormattedMessage id="agents.memory.title" />
      </h3>
      <p className="mo-hint">
        <FormattedMessage id="agents.memory.hint" />
      </p>
      {found === undefined ? (
        <StateMessage kind="loading" inline>
          <FormattedMessage id="agents.loading" />
        </StateMessage>
      ) : found === 'error' ? (
        <StateMessage kind="warning" inline>
          <FormattedMessage id="agents.memory.error" />
        </StateMessage>
      ) : (
        <>
          {found.enabled ? null : (
            <p className="mo-hint">
              <FormattedMessage id="agents.memory.off" />
            </p>
          )}
          {found.items.length === 0 ? (
            <StateMessage kind="empty" inline>
              <FormattedMessage id="agents.memory.none" />
            </StateMessage>
          ) : (
            <ul className="agent-memory__list" aria-labelledby="agent-memory">
              {found.items.map((note) => (
                <li key={note.id}>
                  <span>{note.text}</span>{' '}
                  <span className="mo-hint">
                    <FormattedMessage
                      id={`agents.memory.source.${note.source}`}
                      values={{
                        date: intl.formatDate(note.createdAt, { dateStyle: 'medium' }),
                      }}
                    />
                  </span>
                  {canManage && client.forget !== undefined ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        const forget = client.forget;
                        if (forget === undefined) return;
                        void act(
                          () => forget.call(client, agentId, note.id),
                          'agents.memory.error.forget',
                        );
                      }}
                    >
                      <FormattedMessage id="agents.memory.forget" />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canManage && client.remember !== undefined ? (
            <form className="mo-form" onSubmit={(event) => void add(event)}>
              <label className="mo-field">
                <span className="mo-label">
                  <FormattedMessage id="agents.memory.add" />
                </span>
                <input
                  type="text"
                  value={text}
                  maxLength={MEMORY_TEXT_MAX}
                  onChange={(event) => {
                    setText(event.target.value);
                    setError(undefined);
                  }}
                />
              </label>
              <div className="mo-form__actions">
                <Button type="submit" size="sm" disabled={busy || text.trim() === ''}>
                  <FormattedMessage id="agents.memory.save" />
                </Button>
                {found.items.length === 0 || client.clearMemory === undefined ? null : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => {
                      const clear = client.clearMemory;
                      if (clear === undefined) return;
                      if (
                        !globalThis.confirm(
                          intl.formatMessage({ id: 'agents.memory.clearConfirm' }),
                        )
                      ) {
                        return;
                      }
                      void act(() => clear.call(client, agentId), 'agents.memory.error.forget');
                    }}
                  >
                    <FormattedMessage id="agents.memory.clear" />
                  </Button>
                )}
              </div>
            </form>
          ) : null}
        </>
      )}
      {error === undefined ? null : (
        <StateMessage kind="error">
          <FormattedMessage id={error} />
        </StateMessage>
      )}
    </div>
  );
}
