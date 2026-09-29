import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { newRequestKey } from '../office/AgentTasks.js';
import {
  AutomationsError,
  isRunningPlan,
  type AutomationsClient,
  type PlanDetail,
  type PlanStepProgress,
  type PlanView,
  type WorkflowView,
} from './automationsClient.js';

/**
 * Automations (WF-3, ADR-0071): the organization's workflows and the plans made from them or by
 * the planner. A person plans an active workflow, reads the plan it gave, and approves or rejects
 * that exact version; approving starts it on the server (ADR-0070), and each step's agent answer
 * is shown once the step completed. The screen runs nothing and shows only what the API gave.
 */

/** The permissions this page needs; the API checks each one again. */
export interface AutomationsPermissions {
  readonly readWorkflows: boolean;
  readonly readPlans: boolean;
  readonly planWorkflows: boolean;
  readonly decidePlans: boolean;
}

type Load<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error' };

/** A refused or failed request, as one message the person can act on. */
function errorKey(error: unknown): string {
  if (!(error instanceof AutomationsError)) return 'automations.error.generic';
  switch (error.code) {
    case 'permission_denied':
      return 'automations.error.permission';
    case 'workflow_not_active':
      return 'automations.error.notActive';
    case 'assignee_unavailable':
      return 'automations.error.assignee';
    case 'plan_not_runnable':
      return 'automations.error.notRunnable';
    case 'plan_version_mismatch':
    case 'invalid_plan_transition':
      return 'automations.error.changed';
    default:
      return 'automations.error.generic';
  }
}

const newestFirst = (a: PlanView, b: PlanView) => (a.createdAt < b.createdAt ? 1 : -1);

export function AutomationsPage({
  client,
  permissions,
}: {
  readonly client: AutomationsClient;
  readonly permissions: AutomationsPermissions;
}) {
  const [workflows, setWorkflows] = useState<Load<readonly WorkflowView[]>>({ status: 'loading' });
  const [plans, setPlans] = useState<Load<readonly PlanView[]>>({ status: 'loading' });
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const [pending, setPending] = useState<string>();
  // One key per workflow and press: a retry after a network failure is the same plan.
  const keys = useRef(new Map<string, string>());

  const loadPlans = useCallback(() => {
    if (!permissions.readPlans) return;
    client.plans().then(
      (value) => setPlans({ status: 'ready', value: [...value].sort(newestFirst) }),
      () => setPlans({ status: 'error' }),
    );
  }, [client, permissions.readPlans]);

  useEffect(() => {
    let live = true;
    if (permissions.readWorkflows) {
      client.workflows().then(
        (value) => live && setWorkflows({ status: 'ready', value }),
        () => live && setWorkflows({ status: 'error' }),
      );
    }
    loadPlans();
    return () => {
      live = false;
    };
  }, [client, permissions.readWorkflows, loadPlans]);

  async function plan(workflow: WorkflowView) {
    if (pending !== undefined) return;
    const key = keys.current.get(workflow.id) ?? newRequestKey();
    keys.current.set(workflow.id, key);
    setPending(workflow.id);
    setError(undefined);
    setRefused(undefined);
    try {
      const outcome = await client.planWorkflow(workflow.id, key);
      keys.current.delete(workflow.id);
      if (outcome.status === 'refused') {
        setRefused(outcome.reason);
        return;
      }
      setSelected(outcome.plan.id);
      loadPlans();
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(undefined);
    }
  }

  return (
    <div className="automations">
      <h1>
        <FormattedMessage id="nav.automations" />
      </h1>
      <p className="panel__empty">
        <FormattedMessage id="automations.intro" />
      </p>
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
      {refused === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id="automations.refused" values={{ reason: refused }} />
        </p>
      )}
      {permissions.readWorkflows ? (
        <section className="dept-office__section" aria-labelledby="automations-workflows">
          <h2 id="automations-workflows">
            <FormattedMessage id="automations.workflows" />
          </h2>
          {workflows.status === 'loading' ? (
            <p className="panel__empty" role="status">
              <FormattedMessage id="automations.loading" />
            </p>
          ) : workflows.status === 'error' ? (
            <p className="panel__empty">
              <FormattedMessage id="automations.error.generic" />
            </p>
          ) : workflows.value.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="automations.noWorkflows" />
            </p>
          ) : (
            <ul className="automations__list">
              {workflows.value.map((w) => (
                <li key={w.id} className="automations__item">
                  <span className="automations__name">{w.name}</span>
                  <span className="customers__meta">
                    <FormattedMessage id={`automations.workflowStatus.${w.status}`} />
                    {' · '}
                    <FormattedMessage id="automations.version" values={{ version: w.version }} />
                  </span>
                  {w.status === 'active' && permissions.planWorkflows ? (
                    <Button
                      variant="secondary"
                      disabled={pending !== undefined}
                      onClick={() => void plan(w)}
                    >
                      <FormattedMessage
                        id={pending === w.id ? 'automations.planning' : 'automations.plan'}
                      />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {permissions.readPlans ? (
        <section className="dept-office__section" aria-labelledby="automations-plans">
          <h2 id="automations-plans">
            <FormattedMessage id="automations.plans" />
          </h2>
          {plans.status === 'loading' ? (
            <p className="panel__empty" role="status">
              <FormattedMessage id="automations.loading" />
            </p>
          ) : plans.status === 'error' ? (
            <p className="panel__empty">
              <FormattedMessage id="automations.error.generic" />
            </p>
          ) : plans.value.length === 0 ? (
            <p className="panel__empty">
              <FormattedMessage id="automations.noPlans" />
            </p>
          ) : (
            <ul className="automations__list">
              {plans.value.map((p) => (
                <li key={p.id}>
                  <PlanRow
                    plan={p}
                    open={selected === p.id}
                    onToggle={() => setSelected(selected === p.id ? undefined : p.id)}
                  />
                </li>
              ))}
            </ul>
          )}
          {selected === undefined ? null : (
            <PlanCard
              key={selected}
              client={client}
              planId={selected}
              canDecide={permissions.decidePlans}
              onDecided={loadPlans}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}

function PlanRow({
  plan,
  open,
  onToggle,
}: {
  readonly plan: PlanView;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const intl = useIntl();
  return (
    <button type="button" className="automations__row" aria-expanded={open} onClick={onToggle}>
      <FormattedMessage
        id="automations.planRow"
        values={{
          date: intl.formatDate(new Date(plan.createdAt), {
            day: 'numeric',
            month: 'short',
            hour: 'numeric',
            minute: '2-digit',
          }),
        }}
      />
      {' · '}
      <FormattedMessage id={`automations.planStatus.${plan.status}`} />
    </button>
  );
}

function PlanCard({
  client,
  planId,
  canDecide,
  onDecided,
}: {
  readonly client: AutomationsClient;
  readonly planId: string;
  readonly canDecide: boolean;
  readonly onDecided: () => void;
}) {
  const [plan, setPlan] = useState<Load<PlanDetail>>({ status: 'loading' });
  const [steps, setSteps] = useState<readonly PlanStepProgress[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const read = useCallback(() => {
    client.plan(planId).then(
      (value) => {
        setPlan({ status: 'ready', value });
        if (value.status !== 'approval_required' && value.status !== 'ready') {
          client.steps(planId).then(setSteps, () => setSteps([]));
        }
      },
      () => setPlan({ status: 'error' }),
    );
  }, [client, planId]);

  useEffect(read, [read]);

  async function decide(decision: 'approve' | 'reject', detail: PlanDetail) {
    setPending(true);
    setError(undefined);
    try {
      await client.decide(planId, decision, {
        version: detail.current.version,
        digest: detail.current.digest,
      });
      onDecided();
      read();
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setPending(false);
    }
  }

  if (plan.status === 'loading') {
    return (
      <p className="panel__empty" role="status">
        <FormattedMessage id="automations.loading" />
      </p>
    );
  }
  if (plan.status === 'error') {
    return (
      <p className="panel__empty" role="alert">
        <FormattedMessage id="automations.error.generic" />
      </p>
    );
  }
  const detail = plan.value;
  const progress = new Map(steps.map((s) => [s.stepId, s]));
  return (
    <article className="report-card automations__plan" aria-labelledby="automations-plan-title">
      <h3 id="automations-plan-title" className="report-card__title">
        {detail.current.request.summary}
      </h3>
      <p>{detail.current.request.objective}</p>
      <p className="customers__meta">
        <FormattedMessage id={`automations.planStatus.${detail.status}`} />
        {' · '}
        <FormattedMessage
          id={
            detail.current.source.kind === 'workflow'
              ? 'automations.fromWorkflow'
              : 'automations.fromPlanner'
          }
        />
      </p>
      <ol className="automations__steps">
        {detail.current.steps.map((step) => {
          const done = progress.get(step.id);
          return (
            <li key={step.id}>
              <span className="automations__name">{step.label}</span>
              {done === undefined ? null : (
                <span className="customers__meta">
                  {' · '}
                  <FormattedMessage id={`automations.stepStatus.${stepStatusOf(done.status)}`} />
                </span>
              )}
              {done?.answer === null || done?.answer === undefined ? null : (
                <p className="automations__answer">{done.answer}</p>
              )}
              {done === undefined || done.missing.length === 0 ? null : (
                <p className="customers__meta">
                  <FormattedMessage
                    id="automations.missing"
                    values={{ missing: done.missing.join(', ') }}
                  />
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {error === undefined ? null : (
        <p className="gia-chat__error" role="alert">
          <FormattedMessage id={error} />
        </p>
      )}
      {detail.status === 'approval_required' && canDecide ? (
        <div className="customers__actions">
          <p className="customers__meta">
            <FormattedMessage id="automations.approveHint" />
          </p>
          <Button disabled={pending} onClick={() => void decide('approve', detail)}>
            <FormattedMessage id="automations.approve" />
          </Button>
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => void decide('reject', detail)}
          >
            <FormattedMessage id="automations.reject" />
          </Button>
        </div>
      ) : null}
      {isRunningPlan(detail) ? (
        <div className="customers__actions">
          <Button variant="secondary" onClick={read}>
            <FormattedMessage id="automations.refresh" />
          </Button>
        </div>
      ) : null}
    </article>
  );
}

const STEP_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

/** A step execution's state as the screen names it; any other in-between state is "working". */
const stepStatusOf = (status: string): string =>
  STEP_STATUSES.has(status) ? status : status === 'unknown' ? 'pending' : 'running';
