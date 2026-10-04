import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import {
  AgentRequestError,
  type AgentChangeView,
  type AgentHistoryEntryView,
  type AgentsClient,
} from './agentsClient.js';

/**
 * An agent's version history (AC-3, ADR-0142), on its page: each version with who made it, when,
 * what kind of change it was and a summary, newest first; its detail shows the state before and
 * after. The server tells every change from the stored versions. A person with
 * `specialist.manage` may bring an earlier version back as a new one (ADR-0143), after
 * confirming; nothing here edits or deletes a version.
 */
export function AgentHistory({
  client,
  agentId,
  version,
  departments,
  canManage = false,
  onChanged,
}: {
  readonly client: AgentsClient;
  readonly agentId: string;
  /** The version the page shows; a newer one reads the history again. */
  readonly version: number;
  readonly departments: readonly { readonly id: string; readonly name: string }[];
  /** `specialist.manage`: may restore an earlier version. */
  readonly canManage?: boolean;
  /** After a restore: the page reads the agent again. */
  readonly onChanged?: () => void;
}) {
  const intl = useIntl();
  const [entries, setEntries] = useState<readonly AgentHistoryEntryView[]>();
  const [next, setNext] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number>();
  const [notice, setNotice] = useState<'restored' | 'conflict' | 'error'>();
  const read = client.history;

  useEffect(() => {
    if (read === undefined) return;
    let live = true;
    read.call(client, agentId).then(
      (page) => {
        if (!live) return;
        setEntries(page.entries);
        setNext(page.nextBefore);
        setFailed(false);
      },
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, read, agentId, version]);

  if (read === undefined) return null;

  async function more() {
    if (read === undefined || next === null) return;
    setBusy(true);
    try {
      const page = await read.call(client, agentId, next);
      setEntries((current) => [...(current ?? []), ...page.entries]);
      setNext(page.nextBefore);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  async function restore(to: number) {
    const bring = client.restore;
    if (bring === undefined) return;
    if (!globalThis.confirm(text('agents.history.restoreConfirm', { version: to }))) return;
    setBusy(true);
    setNotice(undefined);
    try {
      await bring.call(client, agentId, { fromVersion: version, version: to });
      setNotice('restored');
      onChanged?.();
    } catch (error) {
      setNotice(
        error instanceof AgentRequestError && error.code === 'specialist_concurrency_conflict'
          ? 'conflict'
          : 'error',
      );
    } finally {
      setBusy(false);
    }
  }

  const text = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id }, values);
  const department = (id: string) => departments.find((d) => d.id === id)?.name ?? id;
  const skill = (id: string) =>
    intl.messages[`agents.skill.${id}.name`] === undefined ? id : text(`agents.skill.${id}.name`);
  const level = (value: string) =>
    intl.messages[`agents.autonomy.level.${value}`] === undefined
      ? value
      : text(`agents.autonomy.level.${value}`);
  const settings = (value: Readonly<Record<string, boolean>>) =>
    Object.entries(value)
      .filter(([, on]) => on)
      .map(([key]) => text(`agents.work.${key}`))
      .join(', ') || text('agents.history.none');

  /** One line per change, as the list shows it. */
  function summary(change: AgentChangeView): readonly string[] {
    switch (change.kind) {
      case 'created':
        return [text('agents.history.created')];
      case 'department':
        return [`${department(change.before)} → ${department(change.after)}`];
      case 'purpose':
      case 'description':
        return [text(`agents.history.${change.kind}Updated`)];
      case 'skills':
        return [
          ...change.added.map((s) => `+ ${skill(s.id)}`),
          ...change.removed.map((s) => `− ${skill(s.id)}`),
          ...change.updated.map((s) =>
            text('agents.history.skillUpdated', { skill: skill(s.id), from: s.from, to: s.to }),
          ),
        ];
      case 'autonomy':
        return [`${level(change.before)} → ${level(change.after)}`];
      case 'work':
        return [`${settings(change.before)} → ${settings(change.after)}`];
      default:
        return [text('agents.history.otherSummary')];
    }
  }

  /** Before and after, for the detail of a version. */
  function detail(change: AgentChangeView): readonly [string, string] | undefined {
    switch (change.kind) {
      case 'department':
        return [department(change.before), department(change.after)];
      case 'purpose':
      case 'description':
        return [
          change.before ?? text('agents.history.none'),
          change.after ?? text('agents.history.none'),
        ];
      case 'autonomy':
        return [level(change.before), level(change.after)];
      case 'work':
        return [settings(change.before), settings(change.after)];
      default:
        return undefined;
    }
  }

  return (
    <div className="agent-history">
      <h3 id="agent-history" className="mo-subsection-title">
        <FormattedMessage id="agents.history.title" />
      </h3>
      {failed ? (
        <StateMessage kind="warning" inline>
          <FormattedMessage id="agents.history.error" />
        </StateMessage>
      ) : entries === undefined ? (
        <StateMessage kind="loading" inline>
          <FormattedMessage id="agents.loading" />
        </StateMessage>
      ) : (
        <>
          <ol className="agent-history__list" aria-labelledby="agent-history">
            {entries.map((entry) => {
              const shown = open === entry.version;
              const kinds = entry.changes.map((c) => text(`agents.history.kind.${c.kind}`));
              return (
                <li key={entry.version} className="agent-history__item">
                  <strong>
                    {entry.previousVersion === null
                      ? `v${entry.version}`
                      : `v${entry.previousVersion} → v${entry.version}`}
                  </strong>{' '}
                  <span className="mo-hint">
                    {text(`agents.history.actor.${entry.actor}`)} ·{' '}
                    {intl.formatDate(entry.createdAt, { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
                    {kinds.join(', ')}
                  </span>
                  {entry.restoredFrom === null || entry.restoredFrom === undefined ? null : (
                    <span className="agent-skills__line">
                      {text('agents.history.restoredFrom', { version: entry.restoredFrom })}
                    </span>
                  )}
                  <ul className="agent-history__summary">
                    {entry.changes
                      .flatMap((c) => summary(c))
                      .map((line, i) => (
                        <li key={`${i}-${line}`}>{line}</li>
                      ))}
                  </ul>
                  {entry.changes.some((c) => detail(c) !== undefined) ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-expanded={shown}
                      onClick={() => setOpen(shown ? undefined : entry.version)}
                    >
                      <FormattedMessage
                        id={shown ? 'agents.history.hideDetail' : 'agents.history.showDetail'}
                        values={{ version: entry.version }}
                      />
                    </Button>
                  ) : null}
                  {canManage && client.restore !== undefined && entry.version < version ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void restore(entry.version)}
                    >
                      <FormattedMessage
                        id="agents.history.restore"
                        values={{ version: entry.version }}
                      />
                    </Button>
                  ) : null}
                  {shown ? (
                    <dl className="agent-facts agent-history__detail">
                      {entry.changes.flatMap((c, i) => {
                        const pair = detail(c);
                        return pair === undefined
                          ? []
                          : [
                              <div key={i} className="agent-facts__row">
                                <dt>{text(`agents.history.kind.${c.kind}`)}</dt>
                                <dd>
                                  {text('agents.history.beforeAfter', {
                                    before: pair[0],
                                    after: pair[1],
                                  })}
                                </dd>
                              </div>,
                            ];
                      })}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {notice === undefined ? null : (
            <StateMessage kind={notice === 'restored' ? 'success' : 'error'}>
              <FormattedMessage
                id={notice === 'error' ? 'agents.history.restoreError' : `agents.history.${notice}`}
              />
            </StateMessage>
          )}
          {next === null ? null : (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void more()}>
              <FormattedMessage id="agents.history.more" />
            </Button>
          )}
        </>
      )}
    </div>
  );
}
