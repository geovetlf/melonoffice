import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, ListItem, StateMessage } from '@melonoffice/ui';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import {
  AgentTaskError,
  followUpOfTask,
  isOpenTask,
  type AgentTaskTraceView,
  type AgentTaskView,
  type AgentTasksClient,
  type TaskFollowUpView,
} from './agentTasksClient.js';

/**
 * An agent's tasks in its place (ADR-0063): the owner asks the agent for something, and reads
 * what it answered. The answer is the agent's, shown only once the task completed and passed its
 * verification; while it runs the screen says so and reads it again, and a task that failed says
 * it failed. Nothing here claims the agent did anything beyond answering.
 *
 * What the agent proposed (ADR-0084) is shown with it: a follow-up, with where it stands and, while
 * it waits, Approve and Reject for a person with `approval.approve`; and how many facts it proposed
 * for the company memory, where the owner confirms them.
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
export const statusKey = (task: AgentTaskView) => {
  const state = followUpOfTask(task)?.state;
  // Only the follow-up it proposed, or asked for with its tool, waits, or was turned down.
  if (state === 'waiting_approval') return 'agentTasks.status.waitingApproval';
  if (task.status === 'failed' && (state === 'rejected' || state === 'expired')) {
    // It had answered: that stands. It had not (its tool's call was turned down): it stopped.
    return task.answer === null ? 'agentTasks.status.cancelled' : 'agentTasks.status.completed';
  }
  return STATUS_KEYS[task.status] ?? 'agentTasks.status.running';
};

/**
 * What the agent is doing, in one plain sentence (ADR-0117): working, needs your approval,
 * finished, needs information, blocked because it needs access, stopped, or could not finish.
 */
export function sentenceKey(task: AgentTaskView): string {
  const follow = followUpOfTask(task)?.state;
  if (follow === 'waiting_approval' || task.status === 'waiting_approval') {
    return 'agentTasks.sentence.approval';
  }
  if (isOpenTask(task)) return 'agentTasks.sentence.working';
  const reason = task.handoff?.reason;
  if (task.status === 'completed') {
    return reason === 'missing_information'
      ? 'agentTasks.sentence.needsInfo'
      : 'agentTasks.sentence.finished';
  }
  if (task.status === 'cancelled') return 'agentTasks.sentence.stopped';
  if (task.status === 'failed') {
    if (follow === 'rejected' || follow === 'expired') {
      return task.answer === null ? 'agentTasks.sentence.stopped' : 'agentTasks.sentence.finished';
    }
    if (reason === 'policy') return 'agentTasks.sentence.stopped';
    if (reason === 'authorization_required') return 'agentTasks.sentence.blocked';
    return 'agentTasks.sentence.failed';
  }
  return 'agentTasks.sentence.unknown';
}

/** An internal link that stays in the app. */
function Link({ to, children }: { readonly to: string; readonly children: ReactNode }) {
  return (
    <a
      className="mo-link"
      href={to}
      onClick={(event) => {
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function ProposedFollowUp({
  followUp,
  onDecide,
  busy,
}: {
  readonly followUp: TaskFollowUpView;
  readonly onDecide?: ((decision: 'approve' | 'reject') => void) | undefined;
  readonly busy: boolean;
}) {
  const intl = useIntl();
  const type =
    intl.messages[`followUps.type.${followUp.type}`] === undefined
      ? followUp.type
      : intl.formatMessage({ id: `followUps.type.${followUp.type}` });
  const when = intl.formatDate(new Date(`${followUp.date}T${followUp.time}:00`), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  return (
    <div
      className="agent-task__proposal"
      role="group"
      aria-label={intl.formatMessage({ id: 'agentTasks.followUp.title' })}
    >
      <p className="mo-list-item__meta">
        <FormattedMessage id="agentTasks.followUp.title" />
      </p>
      <p>
        <strong>{followUp.title}</strong>
      </p>
      <p className="mo-list-item__meta">
        {type} ·{' '}
        {followUp.contactId === null ? (
          <FormattedMessage id="agentTasks.followUp.contactGone" />
        ) : (
          <Link to={paths.customer(followUp.contactId)}>{followUp.contactName}</Link>
        )}{' '}
        · {when}
      </p>
      <p className="mo-list-item__meta agent-task__state">
        <FormattedMessage id={`agentTasks.followUp.state.${followUp.state}`} />
      </p>
      {followUp.state === 'waiting_approval' && followUp.approvalId !== null ? (
        onDecide === undefined ? (
          <p className="mo-list-item__meta">
            <Link to={paths.approvals()}>
              <FormattedMessage id="agentTasks.followUp.review" />
            </Link>
          </p>
        ) : (
          <div className="mo-form__actions">
            <Button size="sm" disabled={busy} onClick={() => onDecide('approve')}>
              <FormattedMessage id="agentTasks.followUp.approve" />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => onDecide('reject')}
            >
              <FormattedMessage id="agentTasks.followUp.reject" />
            </Button>
          </div>
        )
      ) : null}
    </div>
  );
}

function departmentName(intl: ReturnType<typeof useIntl>, type: string): string {
  const key = `department.${type}.short`;
  return Object.hasOwn(intl.messages, key) ? intl.formatMessage({ id: key }) : type;
}

/** What the agent proposed to hand to another department's agent (ADR-0117); a person decides. */
function HandoffPanel({
  task,
  agentName,
  onDecide,
  busy,
}: {
  readonly task: AgentTaskView;
  readonly agentName: string;
  readonly onDecide?: ((decision: 'accept' | 'decline') => void) | undefined;
  readonly busy: boolean;
}) {
  const intl = useIntl();
  const handoff = task.agentHandoff;
  if (handoff === null || handoff === undefined) return null;
  const department = departmentName(intl, handoff.department);
  return (
    <div
      className="agent-task__proposal agent-task__handoff"
      role="group"
      aria-label={intl.formatMessage({ id: 'agentTasks.handoff.title' })}
    >
      <p className="mo-list-item__meta">
        <FormattedMessage
          id={`agentTasks.handoff.state.${handoff.state}`}
          values={{ name: agentName, department }}
        />
      </p>
      <p>{handoff.request}</p>
      {handoff.state === 'refused' && handoff.refusal !== null ? (
        <p className="mo-list-item__meta">
          <FormattedMessage id={`agentTasks.handoff.refusal.${handoff.refusal}`} />
        </p>
      ) : null}
      {handoff.state === 'proposed' ? (
        onDecide === undefined ? (
          <p className="mo-hint">
            <FormattedMessage id="agentTasks.handoff.ownerDecides" />
          </p>
        ) : (
          <>
            <p className="mo-hint">
              <FormattedMessage id="agentTasks.handoff.hint" values={{ department }} />
            </p>
            <div className="mo-form__actions">
              <Button size="sm" disabled={busy} onClick={() => onDecide('accept')}>
                <FormattedMessage id="agentTasks.handoff.accept" />
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() => onDecide('decline')}
              >
                <FormattedMessage id="agentTasks.handoff.decline" />
              </Button>
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

/** "Ver detalles" (ADR-0117): the task's steps, tools, approvals, models, credits and errors. */
function TaskDetails({
  taskId,
  trace,
}: {
  readonly taskId: string;
  readonly trace: (taskId: string) => Promise<AgentTaskTraceView>;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<AgentTaskTraceView | 'error' | undefined>();
  useEffect(() => {
    if (!open) return;
    let live = true;
    trace(taskId).then(
      (t) => live && setFound(t),
      () => live && setFound('error'),
    );
    return () => {
      live = false;
    };
  }, [open, taskId, trace]);
  const label = (prefix: string, code: string) => {
    const key = `${prefix}.${code}`;
    return Object.hasOwn(intl.messages, key) ? intl.formatMessage({ id: key }) : code;
  };
  return (
    <div className="agent-task__details">
      <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)}>
        <FormattedMessage id={open ? 'agentTasks.details.hide' : 'agentTasks.details.show'} />
      </Button>
      {!open ? null : found === undefined ? (
        <StateMessage kind="loading" inline>
          <FormattedMessage id="agentTasks.details.loading" />
        </StateMessage>
      ) : found === 'error' ? (
        <StateMessage kind="warning" inline>
          <FormattedMessage id="agentTasks.details.error" />
        </StateMessage>
      ) : (
        <div className="agent-task__trace">
          <p className="mo-list-item__meta">
            <FormattedMessage
              id="agentTasks.details.credits"
              values={{ total: found.credits.total, task: found.credits.task }}
            />
            {found.credits.budget === null ? null : (
              <>
                {' '}
                <FormattedMessage
                  id="agentTasks.details.budget"
                  values={{ budget: found.credits.budget }}
                />
              </>
            )}
          </p>
          <ol className="agent-task__steps">
            {found.steps.map((step) => (
              <li key={step.nodeId}>
                <FormattedMessage
                  id={`agentTasks.details.step.${step.type === 'tool' ? 'tool' : 'agent'}`}
                  values={{ tool: step.tool?.id ?? '' }}
                />{' '}
                · {label('agentTasks.details.status', step.status)}
                {step.model === null ? null : (
                  <>
                    {' '}
                    ·{' '}
                    <FormattedMessage
                      id="agentTasks.details.model"
                      values={{ model: step.model.model, credits: step.model.credits }}
                    />
                  </>
                )}
                {step.approvalId === null ? null : (
                  <>
                    {' '}
                    · <FormattedMessage id="agentTasks.details.approval" />
                  </>
                )}
                {step.error === null ? null : (
                  <>
                    {' '}
                    ·{' '}
                    <FormattedMessage
                      id="agentTasks.details.error.code"
                      values={{ code: step.error }}
                    />
                  </>
                )}
              </li>
            ))}
          </ol>
          {found.review === null ? null : (
            <p className="mo-list-item__meta">
              <FormattedMessage
                id={`agentTasks.details.review.${found.review.verdict}`}
                values={{ credits: found.credits.review }}
              />
            </p>
          )}
          {found.subtasks.length === 0 ? null : (
            <p className="mo-list-item__meta">
              <FormattedMessage
                id="agentTasks.details.subtasks"
                values={{ count: found.subtasks.length, credits: found.credits.subtasks }}
              />
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TaskItem({
  task,
  agentName,
  onStop,
  onDecide,
  onHandoff,
  trace,
  busy = false,
}: {
  readonly task: AgentTaskView;
  readonly agentName: string;
  /** Accepts or declines the handoff the task proposed; absent, only the owner decides. */
  readonly onHandoff?: ((decision: 'accept' | 'decline') => void) | undefined;
  /** Reads what happened in the task, for "Ver detalles". */
  readonly trace?: ((taskId: string) => Promise<AgentTaskTraceView>) | undefined;
  /** Stops an open task; absent, it has no stop. */
  readonly onStop?: (() => void) | undefined;
  /** Decides the follow-up it proposed; absent, the person is sent to the approvals. */
  readonly onDecide?: ((decision: 'approve' | 'reject') => void) | undefined;
  readonly busy?: boolean;
}) {
  const intl = useIntl();
  const followUp = followUpOfTask(task);
  const facts = task.answer?.facts ?? 0;
  // Turned down by a person: the task stopped there, and its answer stands.
  const declined =
    followUp !== null && (followUp.state === 'rejected' || followUp.state === 'expired');
  return (
    <ListItem
      className={`agent-task agent-task--${isOpenTask(task) ? 'open' : task.status}`}
      title={<span className="agent-task__request">{task.request}</span>}
      meta={
        <>
          <span className="agent-task__status">
            <FormattedMessage id={statusKey(task)} />
          </span>{' '}
          · {intl.formatDate(task.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
        </>
      }
      actions={
        onStop !== undefined && isOpenTask(task) ? (
          <Button size="sm" variant="secondary" onClick={onStop}>
            <FormattedMessage id="agentTasks.stop" />
          </Button>
        ) : null
      }
    >
      <p className="agent-task__sentence">
        <FormattedMessage id={sentenceKey(task)} values={{ name: agentName }} />
      </p>
      {task.answer === null ? null : (
        <div className="agent-task__answer">
          <p>{task.answer.answer}</p>
          {task.answer.missing.length === 0 ? null : (
            <>
              <p className="mo-list-item__meta">
                <FormattedMessage id="agentTasks.missing" />
              </p>
              <ul>
                {task.answer.missing.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          )}
          {followUp === null ? null : (
            <ProposedFollowUp followUp={followUp} onDecide={onDecide} busy={busy} />
          )}
          {facts === 0 ? null : (
            <p className="mo-list-item__meta">
              <FormattedMessage id="agentTasks.facts" values={{ count: facts }} />{' '}
              <Link to={paths.memory()}>
                <FormattedMessage id="agentTasks.facts.review" />
              </Link>
            </p>
          )}
        </div>
      )}
      {task.answer === null && followUp !== null ? (
        // Asked for with the agent's tool before it answered (ADR-0104): a person decides first.
        <div className="agent-task__answer">
          <ProposedFollowUp followUp={followUp} onDecide={onDecide} busy={busy} />
        </div>
      ) : null}
      {task.status === 'completed' && task.answer === null ? (
        <StateMessage kind="empty" inline>
          <FormattedMessage id="agentTasks.noAnswer" />
        </StateMessage>
      ) : null}
      {task.status === 'failed' && !declined ? (
        <StateMessage kind="warning" inline>
          <FormattedMessage id="agentTasks.failed" />
        </StateMessage>
      ) : null}
      <HandoffPanel task={task} agentName={agentName} onDecide={onHandoff} busy={busy} />
      {trace === undefined ? null : <TaskDetails taskId={task.id} trace={trace} />}
    </ListItem>
  );
}

export function AgentTasks({
  client,
  agentId,
  agentName,
  canAsk,
  agentActive,
  stop,
  decide,
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
  /** Decides the follow-up an agent proposed (ADR-0084), with `approval.approve`. */
  readonly decide?:
    ((approvalId: string, decision: 'approve' | 'reject') => Promise<void>) | undefined;
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

  const [deciding, setDeciding] = useState<string>();

  async function decideFollowUp(task: AgentTaskView, decision: 'approve' | 'reject') {
    const approvalId = followUpOfTask(task)?.approvalId;
    if (decide === undefined || approvalId === null || approvalId === undefined) return;
    if (decision === 'reject') {
      if (!globalThis.confirm(intl.formatMessage({ id: 'agentTasks.followUp.rejectConfirm' }))) {
        return;
      }
    }
    setDeciding(task.id);
    setError(undefined);
    try {
      await decide(approvalId, decision);
    } catch {
      // Decided elsewhere or expired meanwhile: reading it again says how it stands.
      setError('agentTasks.followUp.error');
    } finally {
      setDeciding(undefined);
    }
    refreshes.current = 0;
    const fresh = await client.get(task.id).catch(() => undefined);
    if (fresh !== undefined)
      setTasks((current) => current.map((t) => (t.id === fresh.id ? fresh : t)));
  }

  const traceOf = useMemo(() => {
    const read = client.trace;
    return read === undefined ? undefined : (taskId: string) => read.call(client, taskId);
  }, [client]);

  async function decideHandoff(task: AgentTaskView, decision: 'accept' | 'decline') {
    const act = decision === 'accept' ? client.acceptHandoff : client.declineHandoff;
    if (act === undefined) return;
    setDeciding(task.id);
    setError(undefined);
    try {
      await act(task.id);
    } catch (failure) {
      // Refused (no agent free, no budget left) or decided elsewhere: reading it again says so.
      setError(
        failure instanceof AgentTaskError && failure.code === 'budget_exhausted'
          ? 'agentTasks.handoff.error.budget'
          : failure instanceof AgentTaskError && failure.code === 'no_agent_available'
            ? 'agentTasks.handoff.error.noAgent'
            : 'agentTasks.handoff.error',
      );
    } finally {
      setDeciding(undefined);
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
    <section className="mo-panel mo-page-section agent-tasks" aria-labelledby="agent-tasks-title">
      <h2 id="agent-tasks-title" className="mo-section-title">
        <FormattedMessage id="agentTasks.title" />
      </h2>
      {!canAsk ? null : agentActive ? (
        <form className="mo-form" onSubmit={submit}>
          <label className="mo-field">
            <span className="mo-label">
              <FormattedMessage id="agentTasks.ask" values={{ name: agentName }} />
            </span>
            <textarea
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
          <p className="mo-hint">
            <FormattedMessage id="agentTasks.hint" />
          </p>
          <div className="mo-form__actions">
            <Button type="submit" disabled={pending || text.trim() === ''}>
              <FormattedMessage id={pending ? 'agentTasks.sending' : 'agentTasks.send'} />
            </Button>
          </div>
        </form>
      ) : (
        <p className="mo-hint">
          <FormattedMessage id="agentTasks.inactive" />
        </p>
      )}
      {error === undefined ? null : (
        <StateMessage kind="error">
          <FormattedMessage id={error} />
        </StateMessage>
      )}
      {state === 'loading' ? (
        <StateMessage kind="loading">
          <FormattedMessage id="agentTasks.loading" />
        </StateMessage>
      ) : state === 'unavailable' ? (
        <StateMessage kind="warning">
          <FormattedMessage id="agentTasks.error.unavailable" />
        </StateMessage>
      ) : tasks.length === 0 ? (
        <StateMessage kind="empty">
          <FormattedMessage id="agentTasks.none" />
        </StateMessage>
      ) : (
        <ul className="mo-list">
          {tasks.map((task) => (
            <TaskItem
              key={task.id}
              task={task}
              agentName={agentName}
              onHandoff={
                canAsk && client.acceptHandoff !== undefined
                  ? (decision) => void decideHandoff(task, decision)
                  : undefined
              }
              trace={traceOf}
              onStop={stop === undefined ? undefined : () => void stopTask(task)}
              onDecide={
                decide === undefined ? undefined : (decision) => void decideFollowUp(task, decision)
              }
              busy={deciding === task.id}
            />
          ))}
        </ul>
      )}
      {nextCursor === null ? null : (
        <Button variant="secondary" className="mo-page-section__more" onClick={loadMore}>
          <FormattedMessage id="agentTasks.more" />
        </Button>
      )}
    </section>
  );
}
