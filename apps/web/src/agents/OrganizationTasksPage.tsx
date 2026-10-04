import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, Button, PageHeader, StateMessage, Toolbar } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import {
  OrganizationTasksRequestError,
  type OrganizationTaskView,
  type OrganizationTasksClient,
  type OrganizationTasksPageView,
  type OrganizationTasksQuery,
} from './organizationTasksClient.js';

/**
 * Every agent's work in the organization (ADR-0148, ADR-0149): tasks people asked agents for and
 * plan steps agents run, each marked by where it comes from, newest first, a page at a time.
 * A step stays a step of its plan: its details are the plan engine's, and its plan is acted on
 * in Automations. Read only:
 * nothing here stops, retries, reassigns or changes a task or an agent. Filters are sent as asked
 * and checked again by the API, which reads only the person's own organization.
 */

type IntlShape = ReturnType<typeof useIntl>;

/** A code turned into words when no label exists: `step_failed` → "step failed". */
const words = (code: string) => code.replaceAll(/[_.]/g, ' ');

const labelOf = (intl: IntlShape, prefix: string, code: string) => {
  const id = `${prefix}.${code}`;
  return intl.messages[id] === undefined ? words(code) : intl.formatMessage({ id });
};

const TONES: Readonly<Record<string, 'success' | 'warning' | 'danger'>> = {
  completed: 'success',
  waiting_approval: 'warning',
  paused: 'warning',
  failed: 'danger',
  cancelled: 'danger',
};

function errorOf(error: unknown): string {
  if (!(error instanceof OrganizationTasksRequestError)) return 'generic';
  if (error.status === 403) return 'permission';
  if (error.status === 400 && error.field === 'period') return 'period';
  return 'generic';
}

export function OrganizationTasksPage({ client }: { readonly client: OrganizationTasksClient }) {
  const intl = useIntl();
  const [draft, setDraft] = useState({ origin: '', agent: '', status: '', from: '', to: '' });
  const [query, setQuery] = useState<OrganizationTasksQuery>({});
  const [tasks, setTasks] = useState<readonly OrganizationTaskView[] | undefined>();
  const [options, setOptions] = useState<
    | Pick<
        OrganizationTasksPageView,
        'agents' | 'statuses' | 'origins' | 'sources' | 'planStepsWindowed'
      >
    | undefined
  >();
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    client.page(query).then(
      (page) => {
        if (!live) return;
        setTasks(page.tasks);
        setOptions({
          agents: page.agents,
          statuses: page.statuses,
          origins: page.origins,
          sources: page.sources,
          planStepsWindowed: page.planStepsWindowed,
        });
        setNext(page.nextCursor);
      },
      (failure: unknown) => live && setError(errorOf(failure)),
    );
    return () => {
      live = false;
    };
  }, [client, query]);

  const more = async () => {
    if (next === null) return;
    setLoadingMore(true);
    try {
      const page = await client.page({ ...query, cursor: next });
      setTasks((current) => [
        ...(current ?? []),
        ...page.tasks.filter((t) => !(current ?? []).some((c) => c.id === t.id)),
      ]);
      setNext(page.nextCursor);
    } catch (failure) {
      setError(errorOf(failure));
    } finally {
      setLoadingMore(false);
    }
  };

  const apply = () => {
    // A new question: the old answer and its error go, and the list reloads.
    setTasks(undefined);
    setError(undefined);
    setQuery(Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== '')));
  };

  const time = (at: string | null) =>
    at === null ? '—' : intl.formatDate(new Date(at), { dateStyle: 'medium', timeStyle: 'short' });
  const agentName = (task: OrganizationTaskView) =>
    task.agent.name ?? intl.formatMessage({ id: 'orgTasks.anAgent' });

  return (
    <article className="mo-page org-tasks-page">
      <PageHeader
        title={<FormattedMessage id="orgTasks.title" />}
        description={<FormattedMessage id="orgTasks.lead" />}
        actions={
          <Button size="sm" variant="secondary" onClick={() => navigate(paths.agents())}>
            <FormattedMessage id="orgTasks.back" />
          </Button>
        }
      />
      <Toolbar label={intl.formatMessage({ id: 'orgTasks.filters' })}>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="orgTasks.filter.origin" />
          </span>
          <select
            value={draft.origin}
            onChange={(e) => setDraft({ ...draft, origin: e.target.value })}
          >
            {(options?.origins ?? ['all']).map((o) => (
              <option key={o} value={o === 'all' ? '' : o}>
                {intl.formatMessage({ id: `orgTasks.origin.filter.${o}` })}
              </option>
            ))}
          </select>
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="orgTasks.filter.agent" />
          </span>
          <select
            value={draft.agent}
            onChange={(e) => setDraft({ ...draft, agent: e.target.value })}
          >
            <option value="">{intl.formatMessage({ id: 'orgTasks.filter.all' })}</option>
            {(options?.agents ?? []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="orgTasks.filter.status" />
          </span>
          <select
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value })}
          >
            <option value="">{intl.formatMessage({ id: 'orgTasks.filter.all' })}</option>
            {(options?.statuses ?? []).map((s) => (
              <option key={s} value={s}>
                {labelOf(intl, 'orgTasks.status', s)}
              </option>
            ))}
          </select>
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="orgTasks.filter.from" />
          </span>
          <input
            type="date"
            value={draft.from}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="orgTasks.filter.to" />
          </span>
          <input
            type="date"
            value={draft.to}
            onChange={(e) => setDraft({ ...draft, to: e.target.value })}
          />
        </label>
        <Button size="sm" onClick={apply}>
          <FormattedMessage id="orgTasks.filter.apply" />
        </Button>
      </Toolbar>
      {options?.sources.plan_step === 'unavailable' ? (
        <StateMessage kind="warning">
          <FormattedMessage id="orgTasks.steps.unavailable" />
        </StateMessage>
      ) : null}
      {options?.sources.plan_step === 'not_permitted' ? (
        <p className="mo-hint">
          <FormattedMessage id="orgTasks.steps.notPermitted" />
        </p>
      ) : null}
      {options?.planStepsWindowed === true ? (
        <p className="mo-hint">
          <FormattedMessage id="orgTasks.steps.windowed" />
        </p>
      ) : null}
      {error === undefined ? null : (
        <StateMessage kind="error">
          <FormattedMessage id={`orgTasks.error.${error}`} />
        </StateMessage>
      )}
      {tasks === undefined ? (
        error === undefined ? (
          <StateMessage kind="loading">
            <FormattedMessage id="orgTasks.loading" />
          </StateMessage>
        ) : null
      ) : tasks.length === 0 ? (
        <StateMessage kind="empty">
          <FormattedMessage id={next === null ? 'orgTasks.empty' : 'orgTasks.emptyYet'} />
        </StateMessage>
      ) : (
        <ul className="mo-list" aria-label={intl.formatMessage({ id: 'orgTasks.title' })}>
          {tasks.map((task) => {
            const shown = open === task.id;
            return (
              <li key={task.id} className="mo-list-item">
                <div className="mo-list-item__main">
                  <span className="mo-list-item__title">
                    {task.request}{' '}
                    <Badge
                      {...(TONES[task.status] === undefined ? {} : { tone: TONES[task.status] })}
                    >
                      {labelOf(intl, 'orgTasks.status', task.status)}
                    </Badge>
                  </span>
                  <span className="mo-list-item__meta">
                    <FormattedMessage id={`orgTasks.origin.${task.origin}`} /> · {agentName(task)} ·{' '}
                    <time dateTime={task.createdAt}>{time(task.createdAt)}</time>
                    {task.progress.total === 0 ? null : (
                      <>
                        {' · '}
                        <FormattedMessage
                          id="orgTasks.progress"
                          values={{ done: task.progress.done, total: task.progress.total }}
                        />
                      </>
                    )}
                  </span>
                  {task.plan?.step === undefined ? null : (
                    <span className="mo-list-item__meta">
                      <FormattedMessage
                        id="orgTasks.stepInPlan"
                        values={{
                          state: labelOf(intl, 'orgTasks.stepState', task.plan.step.state),
                        }}
                      />
                    </span>
                  )}
                  {task.result === null ? null : (
                    <p className="org-tasks__summary">
                      {task.result.summary}
                      {task.result.truncated ? '…' : ''}
                    </p>
                  )}
                  {task.failure === null ? null : (
                    <span className="mo-list-item__meta">
                      <FormattedMessage
                        id="orgTasks.failure"
                        values={{ reason: labelOf(intl, 'orgTasks.reason', task.failure) }}
                      />
                    </span>
                  )}
                  {shown ? <TaskDetail task={task} intl={intl} time={time} /> : null}
                </div>
                <div className="mo-list-item__actions">
                  <button
                    type="button"
                    className="mo-button mo-button--ghost mo-button--sm"
                    aria-expanded={shown}
                    onClick={() => setOpen(shown ? undefined : task.id)}
                  >
                    <FormattedMessage
                      id={shown ? 'orgTasks.detail.hide' : 'orgTasks.detail.show'}
                    />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {tasks !== undefined && next !== null ? (
        <Button size="sm" variant="secondary" disabled={loadingMore} onClick={() => void more()}>
          <FormattedMessage id={loadingMore ? 'orgTasks.loading' : 'orgTasks.more'} />
        </Button>
      ) : null}
    </article>
  );
}

/** One task opened: its state, dates, steps and how it relates to a plan or another task. */
function TaskDetail({
  task,
  intl,
  time,
}: {
  readonly task: OrganizationTaskView;
  readonly intl: IntlShape;
  readonly time: (at: string | null) => string;
}) {
  return (
    <dl className="agent-facts">
      <dt>
        <FormattedMessage id="orgTasks.detail.agent" />
      </dt>
      <dd>{task.agent.name ?? intl.formatMessage({ id: 'orgTasks.anAgent' })}</dd>
      <dt>
        <FormattedMessage id="orgTasks.detail.status" />
      </dt>
      <dd>{labelOf(intl, 'orgTasks.status', task.status)}</dd>
      <dt>
        <FormattedMessage id="orgTasks.detail.created" />
      </dt>
      <dd>{time(task.createdAt)}</dd>
      <dt>
        <FormattedMessage id="orgTasks.detail.updated" />
      </dt>
      <dd>{time(task.updatedAt)}</dd>
      <dt>
        <FormattedMessage id="orgTasks.detail.completed" />
      </dt>
      <dd>{time(task.completedAt)}</dd>
      {task.plan === null ? null : (
        <>
          <dt>
            <FormattedMessage id="orgTasks.detail.plan" />
          </dt>
          <dd>
            {task.plan.status === undefined ? null : (
              <>{labelOf(intl, 'orgTasks.planStatus', task.plan.status)} · </>
            )}
            <a
              className="mo-link"
              href={paths.automations()}
              onClick={(event) => {
                event.preventDefault();
                navigate(paths.automations());
              }}
            >
              <FormattedMessage id="orgTasks.detail.openPlan" />
            </a>
          </dd>
        </>
      )}
      {task.plan?.step === undefined ? null : (
        <>
          <dt>
            <FormattedMessage id="orgTasks.detail.stepState" />
          </dt>
          <dd>{labelOf(intl, 'orgTasks.stepState', task.plan.step.state)}</dd>
        </>
      )}
      {task.dependsOn.length === 0 ? null : (
        <>
          <dt>
            <FormattedMessage id="orgTasks.detail.dependsOn" />
          </dt>
          <dd>
            {task.dependsOn
              .map((d) => `${d.label} (${labelOf(intl, 'orgTasks.stepState', d.state)})`)
              .join(', ')}
          </dd>
        </>
      )}
      {task.approval === null ? null : (
        <>
          <dt>
            <FormattedMessage id="orgTasks.detail.approval" />
          </dt>
          <dd>{labelOf(intl, 'orgTasks.approval', task.approval.state)}</dd>
        </>
      )}
      {task.handedFrom === null ? null : (
        <>
          <dt>
            <FormattedMessage id="orgTasks.detail.handed" />
          </dt>
          <dd>
            <FormattedMessage id="orgTasks.detail.handedYes" />
          </dd>
        </>
      )}
      {task.result === null || task.result.missing === 0 ? null : (
        <>
          <dt>
            <FormattedMessage id="orgTasks.detail.missing" />
          </dt>
          <dd>
            <FormattedMessage
              id="orgTasks.detail.missingCount"
              values={{ count: task.result.missing }}
            />
          </dd>
        </>
      )}
      <dt>
        <FormattedMessage id="orgTasks.detail.steps" />
      </dt>
      <dd>
        {task.steps.length === 0 ? (
          '—'
        ) : (
          <ol className="org-tasks__steps">
            {task.steps.map((step, index) => (
              <li key={index}>
                {labelOf(intl, 'orgTasks.step', step.type)}:{' '}
                {labelOf(intl, 'orgTasks.stepStatus', step.status)}
                {step.completedAt === null ? null : <> · {time(step.completedAt)}</>}
                {step.failure === null ? null : (
                  <> · {labelOf(intl, 'orgTasks.reason', step.failure)}</>
                )}
              </li>
            ))}
          </ol>
        )}
      </dd>
    </dl>
  );
}
