import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AgentTaskError,
  isOpenTask,
  type AgentTaskView,
  type AgentTasksClient,
} from './agentTasksClient.js';

/**
 * An agent's tasks in its place (ADR-0063): the owner asks the agent for something, and reads
 * what it answered. The answer is the agent's, shown only once the task completed and passed its
 * verification; while it runs the screen says so and reads it again, and a task that failed says
 * it failed. Nothing here claims the agent did anything beyond answering.
 */

/** How often an open task is read again, and for how long at most. */
export const TASK_REFRESH_MS = 4_000;
export const TASK_REFRESH_LIMIT = 45;
export const MAX_REQUEST = 2_000;

export const newRequestKey = (): string => `web-${globalThis.crypto.randomUUID()}`;

/** A refused or failed request, as one message the person can act on. */
export function errorKey(error: unknown): string {
  if (!(error instanceof AgentTaskError)) return 'agentTasks.error.unavailable';
  switch (error.code) {
    case 'permission_denied':
      return 'agentTasks.error.permission';
    case 'specialist_not_available':
    case 'specialist_not_eligible':
      return 'agentTasks.error.notAvailable';
    case 'invalid_task':
      return 'agentTasks.error.invalid';
    default:
      return 'agentTasks.error.unavailable';
  }
}

const STATUS_KEYS: Readonly<Record<string, string>> = {
  completed: 'agentTasks.status.completed',
  failed: 'agentTasks.status.failed',
  cancelled: 'agentTasks.status.cancelled',
  unknown: 'agentTasks.status.unknown',
};
const statusKey = (task: AgentTaskView) => STATUS_KEYS[task.status] ?? 'agentTasks.status.running';

function TaskItem({
  task,
  onStop,
}: {
  readonly task: AgentTaskView;
  /** Stops an open task; absent, it has no stop. */
  readonly onStop?: (() => void) | undefined;
}) {
  const intl = useIntl();
  return (
    <li className={`agent-task agent-task--${isOpenTask(task) ? 'open' : task.status}`}>
      <p className="agent-task__request">{task.request}</p>
      <p className="customers__meta">
        <span className="agent-task__status">
          <FormattedMessage id={statusKey(task)} />
        </span>{' '}
        · {intl.formatDate(task.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
      </p>
      {task.answer === null ? null : (
        <div className="agent-task__answer">
          <p>{task.answer.answer}</p>
          {task.answer.missing.length === 0 ? null : (
            <>
              <p className="customers__meta">
                <FormattedMessage id="agentTasks.missing" />
              </p>
              <ul>
                {task.answer.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {task.status === 'completed' && task.answer === null ? (
        <p className="panel__empty">
          <FormattedMessage id="agentTasks.noAnswer" />
        </p>
      ) : null}
      {task.status === 'failed' ? (
        <p className="panel__empty">
          <FormattedMessage id="agentTasks.failed" />
        </p>
      ) : null}
      {onStop !== undefined && isOpenTask(task) ? (
        <div className="customers__actions">
          <Button variant="secondary" onClick={onStop}>
            <FormattedMessage id="agentTasks.stop" />
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function AgentTasks({
  client,
  agentId,
  agentName,
  canAsk,
  agentActive,
  stop,
  refreshMs = TASK_REFRESH_MS,
}: {
  readonly client: AgentTasksClient;
  readonly agentId: string;
  readonly agentName: string;
  /** `specialist.task`: only then is the form shown (the API checks it again). */
  readonly canAsk: boolean;
  /** Only an active agent takes new work. */
  readonly agentActive: boolean;
  /** Stops a task that is still working (ADR-0029), with `execution.cancel`. */
  readonly stop?: ((taskId: string) => Promise<void>) | undefined;
  readonly refreshMs?: number;
}) {
  const intl = useIntl();
  const [tasks, setTasks] = useState<readonly AgentTaskView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  // One key per request typed: a retry after a network failure is the same task.
  const requestKey = useRef(newRequestKey());
  const refreshes = useRef(0);

  useEffect(() => {
    // Mounted once per agent (keyed by it), so it starts `loading`.
    let live = true;
    client.list(agentId).then(
      (page) => {
        if (!live) return;
        setTasks(page.tasks);
        setNextCursor(page.nextCursor);
        setState('ready');
      },
      () => live && setState('unavailable'),
    );
    return () => {
      live = false;
    };
  }, [client, agentId]);

  const open = tasks.filter(isOpenTask).map((t) => t.id);
  const openKey = open.join(',');
  useEffect(() => {
    if (openKey === '' || refreshes.current >= TASK_REFRESH_LIMIT) return;
    const timer = setTimeout(() => {
      refreshes.current += 1;
      void Promise.all(
        openKey.split(',').map((id) =>
          client.get(id).then(
            (t) => t,
            () => undefined,
          ),
        ),
      ).then((fresh) => {
        const byId = new Map(
          fresh.filter((t): t is AgentTaskView => t !== undefined).map((t) => [t.id, t]),
        );
        setTasks((current) => current.map((t) => byId.get(t.id) ?? t));
      });
    }, refreshMs);
    return () => clearTimeout(timer);
  }, [client, openKey, refreshMs, tasks]);

  const loadMore = useCallback(() => {
    if (nextCursor === null) return;
    client.list(agentId, nextCursor).then(
      (page) => {
        setTasks((current) => [
          ...current,
          ...page.tasks.filter((t) => !current.some((c) => c.id === t.id)),
        ]);
        setNextCursor(page.nextCursor);
      },
      () => setError('agentTasks.error.unavailable'),
    );
  }, [client, agentId, nextCursor]);

  async function stopTask(task: AgentTaskView) {
    if (stop === undefined) return;
    if (!globalThis.confirm(intl.formatMessage({ id: 'agentTasks.stop.confirm' }))) return;
    setError(undefined);
    try {
      await stop(task.id);
    } catch {
      // It may have ended meanwhile: reading it again says how it stands.
      setError('agentTasks.stop.error');
    }
    const fresh = await client.get(task.id).catch(() => undefined);
    if (fresh !== undefined)
      setTasks((current) => current.map((t) => (t.id === fresh.id ? fresh : t)));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const request = text.trim();
    if (request === '' || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const task = await client.assign(agentId, request, requestKey.current);
      setTasks((current) => [task, ...current.filter((t) => t.id !== task.id)]);
      setText('');
      requestKey.current = newRequestKey();
      refreshes.current = 0;
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="dept-office__section agent-tasks" aria-labelledby="agent-tasks-title">
      <h2 id="agent-tasks-title">
        <FormattedMessage id="agentTasks.title" />
      </h2>
      {!canAsk ? null : agentActive ? (
        <form className="agent-tasks__form" onSubmit={submit}>
          <label>
            <FormattedMessage id="agentTasks.ask" values={{ name: agentName }} />
            <textarea
              className="gia-chat__input"
              value={text}
              maxLength={MAX_REQUEST}
              rows={3}
              placeholder={intl.formatMessage({ id: 'agentTasks.placeholder' })}
              onChange={(e) => {
                setText(e.target.value);
                setError(undefined);
              }}
            />
          </label>
          <p className="customers__meta">
            <FormattedMessage id="agentTasks.hint" />
          </p>
          <div className="customers__actions">
            <Button type="submit" disabled={pending || text.trim() === ''}>
              <FormattedMessage id={pending ? 'agentTasks.sending' : 'agentTasks.send'} />
            </Button>
          </div>
        </form>
      ) : (
        <p className="panel__empty">
          <FormattedMessage id="agentTasks.inactive" />
        </p>
      )}
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
      {state === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="agentTasks.loading" />
        </p>
      ) : state === 'unavailable' ? (
        <p className="panel__empty">
          <FormattedMessage id="agentTasks.error.unavailable" />
        </p>
      ) : tasks.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="agentTasks.none" />
        </p>
      ) : (
        <ul className="agent-tasks__list">
          {tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              onStop={stop === undefined ? undefined : () => void stopTask(task)}
            />
          ))}
        </ul>
      )}
      {nextCursor === null ? null : (
        <Button variant="secondary" onClick={loadMore}>
          <FormattedMessage id="agentTasks.more" />
        </Button>
      )}
    </section>
  );
}
