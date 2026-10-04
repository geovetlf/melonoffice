import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, PageHeader, StateMessage } from '@melonoffice/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentTemplateView } from '../agents/agentsClient.js';
import { ExecutionRequestError } from '../executions/executionsClient.js';
import { newRequestKey } from '../office/AgentTasks.js';
import {
  AutomationsError,
  isRunningPlan,
  WORKFLOW_TRANSITIONS,
  type AutomationsClient,
  CHECK_DECISION,
  type PlanDetail,
  type PlanStepProgress,
  type PlanStepView,
  type PlanView,
  type WorkflowDetail,
  type WorkflowStatus,
  type WorkflowStepDraft,
  type WorkflowView,
} from './automationsClient.js';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import { draftsOf, WorkflowEditor } from './WorkflowEditor.js';

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
  /** `workflow.manage`: create, version and move workflows. */
  readonly manageWorkflows?: boolean;
}

type Editing =
  | { readonly mode: 'create' }
  | {
      readonly mode: 'version';
      readonly id: string;
      readonly name: string;
      readonly steps: readonly WorkflowStepDraft[];
    };

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
  templates,
  stop,
}: {
  readonly client: AutomationsClient;
  readonly permissions: AutomationsPermissions;
  /**
   * Stops a running plan and everything it delegated (ADR-0029), with `execution.cancel`. Absent:
   * the plan shows no stop.
   */
  readonly stop?: ((planId: string) => Promise<void>) | undefined;
  /** The agent catalogue, for who does each step; without it workflows are not written here. */
  readonly templates?: (() => Promise<readonly AgentTemplateView[]>) | undefined;
}) {
  const [workflows, setWorkflows] = useState<Load<readonly WorkflowView[]>>({ status: 'loading' });
  const [plans, setPlans] = useState<Load<readonly PlanView[]>>({ status: 'loading' });
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [refused, setRefused] = useState<string>();
  const [pending, setPending] = useState<string>();
  const [editing, setEditing] = useState<Editing>();
  const [openWorkflow, setOpenWorkflow] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const canWrite = permissions.manageWorkflows === true && templates !== undefined;
  // One key per workflow and press: a retry after a network failure is the same plan.
  const keys = useRef(new Map<string, string>());

  const loadPlans = useCallback(() => {
    if (!permissions.readPlans) return;
    client.plans().then(
      (value) => setPlans({ status: 'ready', value: [...value].sort(newestFirst) }),
      () => setPlans({ status: 'error' }),
    );
  }, [client, permissions.readPlans]);

  const loadWorkflows = useCallback(() => {
    if (!permissions.readWorkflows) return;
    client.workflows().then(
      (value) => setWorkflows({ status: 'ready', value }),
      () => setWorkflows({ status: 'error' }),
    );
  }, [client, permissions.readWorkflows]);

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

  const checkActions = useCallback(() => client.checkActions(), [client]);
  const save = useCallback(
    (name: string, steps: readonly WorkflowStepDraft[], workflowId?: string) =>
      workflowId === undefined
        ? client.createWorkflow(name, steps)
        : client.publishVersion(workflowId, name, steps),
    [client],
  );

  async function move(workflow: WorkflowView, to: WorkflowStatus) {
    if (pending !== undefined) return;
    if (
      to === 'archived' &&
      !globalThis.confirm(intl.formatMessage({ id: 'automations.archiveConfirm' }))
    ) {
      return;
    }
    setPending(workflow.id);
    setError(undefined);
    setNotice(undefined);
    try {
      await client.changeStatus(workflow.id, workflow.status, to);
      setNotice(`automations.moved.${to}`);
    } catch (failure) {
      setError(
        failure instanceof AutomationsError &&
          (failure.code === 'workflow_concurrency_conflict' ||
            failure.code === 'invalid_workflow_transition')
          ? 'automations.editor.error.changed'
          : errorKey(failure),
      );
    } finally {
      setPending(undefined);
      loadWorkflows();
    }
  }

  const intl = useIntl();

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
    <div className="mo-page automations-page">
      <PageHeader
        title={<FormattedMessage id="nav.automations" />}
        description={<FormattedMessage id="automations.intro" />}
      />
      {error === undefined ? null : (
        <StateMessage kind="error">
          <FormattedMessage id={error} />
        </StateMessage>
      )}
      {notice === undefined ? null : (
        <StateMessage kind="success">
          <FormattedMessage id={notice} />
        </StateMessage>
      )}
      {editing === undefined || templates === undefined ? null : (
        <WorkflowEditor
          key={editing.mode === 'create' ? 'create' : editing.id}
          editing={editing.mode === 'create' ? undefined : editing}
          templates={templates}
          checkActions={checkActions}
          save={save}
          onSaved={(saved) => {
            setEditing(undefined);
            setOpenWorkflow(undefined);
            setNotice(
              saved.version > 1 ? 'automations.editor.versioned' : 'automations.editor.created',
            );
            loadWorkflows();
          }}
          onCancel={() => setEditing(undefined)}
        />
      )}
      {refused === undefined ? null : (
        <StateMessage kind="error">
          {REFUSALS.has(refused) ? (
            <FormattedMessage id={`automations.refusedBecause.${refused}`} />
          ) : (
            <FormattedMessage id="automations.refused" values={{ reason: refused }} />
          )}
        </StateMessage>
      )}
      {permissions.readWorkflows ? (
        <section className="mo-panel mo-page-section" aria-labelledby="automations-workflows">
          <div className="mo-page-section__header">
            <h2 id="automations-workflows" className="mo-section-title">
              <FormattedMessage id="automations.workflows" />
            </h2>
            {canWrite && editing === undefined ? (
              <Button onClick={() => setEditing({ mode: 'create' })}>
                <FormattedMessage id="automations.editor.open" />
              </Button>
            ) : null}
          </div>
          {workflows.status === 'loading' ? (
            <StateMessage kind="loading">
              <FormattedMessage id="automations.loading" />
            </StateMessage>
          ) : workflows.status === 'error' ? (
            <StateMessage kind="error">
              <FormattedMessage id="automations.error.generic" />
            </StateMessage>
          ) : workflows.value.length === 0 ? (
            <StateMessage kind="empty">
              <FormattedMessage id="automations.noWorkflows" />
            </StateMessage>
          ) : (
            <ul className="mo-list">
              {workflows.value.map((w) => (
                <li key={w.id} className="mo-list-item">
                  <div className="mo-list-item__main">
                    <span className="mo-list-item__title">{w.name}</span>
                    <span className="mo-list-item__meta">
                      <FormattedMessage id={`automations.workflowStatus.${w.status}`} />
                      {' · '}
                      <FormattedMessage id="automations.version" values={{ version: w.version }} />
                    </span>
                  </div>
                  <div className="mo-list-item__actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-expanded={openWorkflow === w.id}
                      onClick={() => setOpenWorkflow(openWorkflow === w.id ? undefined : w.id)}
                    >
                      <FormattedMessage id="automations.steps" />
                    </Button>
                    {w.status === 'active' && permissions.planWorkflows ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={pending !== undefined}
                        onClick={() => void plan(w)}
                      >
                        <FormattedMessage
                          id={pending === w.id ? 'automations.planning' : 'automations.plan'}
                        />
                      </Button>
                    ) : null}
                    {permissions.manageWorkflows === true
                      ? WORKFLOW_TRANSITIONS[w.status].map((to) => (
                          <Button
                            key={to}
                            size="sm"
                            variant="secondary"
                            disabled={pending !== undefined}
                            onClick={() => void move(w, to)}
                          >
                            <FormattedMessage id={`automations.move.${to}`} />
                          </Button>
                        ))
                      : null}
                  </div>
                  {openWorkflow === w.id ? (
                    <WorkflowSteps
                      key={`${w.id}:${w.version}`}
                      client={client}
                      workflow={w}
                      onVersion={
                        canWrite && w.status !== 'archived' && editing === undefined
                          ? (drafts, detail) =>
                              setEditing({
                                mode: 'version',
                                id: w.id,
                                name: detail.current.name,
                                steps: drafts,
                              })
                          : undefined
                      }
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      {permissions.readPlans ? (
        <section className="mo-panel mo-page-section" aria-labelledby="automations-plans">
          <h2 id="automations-plans" className="mo-section-title">
            <FormattedMessage id="automations.plans" />
          </h2>
          {plans.status === 'loading' ? (
            <StateMessage kind="loading">
              <FormattedMessage id="automations.loading" />
            </StateMessage>
          ) : plans.status === 'error' ? (
            <StateMessage kind="error">
              <FormattedMessage id="automations.error.generic" />
            </StateMessage>
          ) : plans.value.length === 0 ? (
            <StateMessage kind="empty">
              <FormattedMessage id="automations.noPlans" />
            </StateMessage>
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
              stop={stop}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}

/** A workflow's current version: its steps, who does each, and which wait for approval. */
function WorkflowSteps({
  client,
  workflow,
  onVersion,
}: {
  readonly client: AutomationsClient;
  readonly workflow: WorkflowView;
  readonly onVersion:
    ((drafts: readonly WorkflowStepDraft[], detail: WorkflowDetail) => void) | undefined;
}) {
  const intl = useIntl();
  const [detail, setDetail] = useState<Load<WorkflowDetail>>({ status: 'loading' });
  useEffect(() => {
    let live = true;
    client.workflow(workflow.id).then(
      (value) => live && setDetail({ status: 'ready', value }),
      () => live && setDetail({ status: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [client, workflow.id]);

  if (detail.status === 'loading') {
    return (
      <StateMessage kind="loading" inline className="automations__detail">
        <FormattedMessage id="automations.loading" />
      </StateMessage>
    );
  }
  if (detail.status === 'error') {
    return (
      <StateMessage kind="error" className="automations__detail">
        <FormattedMessage id="automations.error.generic" />
      </StateMessage>
    );
  }
  const current = detail.value.current;
  const drafts = draftsOf(current.steps);
  return (
    <div className="automations__detail">
      <ol className="automations__steps">
        {current.steps.map((step) => (
          <li key={step.id}>
            <span className="automations__name">{step.label}</span>
            <span className="automations__meta">
              {' · '}
              {typeof step.decision?.input.action === 'string' &&
              step.decision.decision === CHECK_DECISION ? (
                <FormattedMessage
                  id="automations.checks"
                  values={{ action: actionLabel(intl, step.decision.input.action) }}
                />
              ) : step.assignee === null ? (
                <FormattedMessage id={`automations.stepKind.${stepKindOf(step.kind)}`} />
              ) : (
                <FormattedMessage
                  id="automations.doneBy"
                  values={{ role: roleLabel(intl, step.assignee.roleId) }}
                />
              )}
              {step.approvalRequired ? (
                <>
                  {' · '}
                  <FormattedMessage id="automations.needsApproval" />
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      {onVersion === undefined ? null : drafts === undefined ? (
        <p className="mo-hint">
          <FormattedMessage id="automations.editor.notEditable" />
        </p>
      ) : (
        <div className="mo-list-item__actions">
          <Button size="sm" variant="secondary" onClick={() => onVersion(drafts, detail.value)}>
            <FormattedMessage id="automations.editor.edit" />
          </Button>
        </div>
      )}
    </div>
  );
}

const STEP_KINDS = new Set([
  'specialist',
  'tool',
  'approval',
  'verification',
  'condition',
  'parallel',
  'wait',
]);
const stepKindOf = (kind: string): string => (STEP_KINDS.has(kind) ? kind : 'other');

/** An action's name from the catalogue's messages; else its id. */
function actionLabel(intl: ReturnType<typeof useIntl>, action: string): string {
  const key = `agents.action.${action}`;
  return intl.messages[key] === undefined ? action : intl.formatMessage({ id: key });
}

/** A role's name: a catalogue role is `<template>_agent`, named like its template; else its id. */
function roleLabel(intl: ReturnType<typeof useIntl>, roleId: string): string {
  const key = `agents.template.${roleId.replace(/_agent$/, '')}.name`;
  return intl.messages[key] === undefined ? roleId : intl.formatMessage({ id: key });
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
  stop,
}: {
  readonly client: AutomationsClient;
  readonly planId: string;
  readonly canDecide: boolean;
  readonly onDecided: () => void;
  readonly stop?: ((planId: string) => Promise<void>) | undefined;
}) {
  const intl = useIntl();
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

  async function stopPlan() {
    if (stop === undefined) return;
    if (!globalThis.confirm(intl.formatMessage({ id: 'automations.stop.confirm' }))) return;
    setPending(true);
    setError(undefined);
    try {
      await stop(planId);
      onDecided();
      read();
    } catch (failure) {
      setError(
        failure instanceof ExecutionRequestError && failure.code === 'execution_already_terminal'
          ? 'automations.error.changed'
          : failure instanceof ExecutionRequestError && failure.status === 403
            ? 'automations.error.permission'
            : 'automations.error.generic',
      );
    } finally {
      setPending(false);
    }
  }

  if (plan.status === 'loading') {
    return (
      <StateMessage kind="loading" inline>
        <FormattedMessage id="automations.loading" />
      </StateMessage>
    );
  }
  if (plan.status === 'error') {
    return (
      <StateMessage kind="error">
        <FormattedMessage id="automations.error.generic" />
      </StateMessage>
    );
  }
  const detail = plan.value;
  const progress = new Map(steps.map((s) => [s.stepId, s]));
  return (
    <article className="mo-card automations__plan" aria-labelledby="automations-plan-title">
      <h3 id="automations-plan-title" className="mo-subsection-title">
        {detail.current.request.summary}
      </h3>
      <p className="automations__objective">{detail.current.request.objective}</p>
      <p className="automations__meta">
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
      {detail.status === 'approval_required' &&
      detail.current.estimate?.status === 'estimated' &&
      detail.current.estimate.credits !== null ? (
        <p className="automations__meta">
          <FormattedMessage
            id="automations.estimate"
            values={{ credits: detail.current.estimate.credits }}
          />
        </p>
      ) : null}
      <ol className="automations__steps">
        {detail.current.steps.map((step) => {
          const done = progress.get(step.id);
          const action = checkActionOf(step.decision);
          return (
            <li key={step.id}>
              <span className="automations__name">{step.label}</span>
              {action === undefined ? null : (
                <span className="automations__meta">
                  {' · '}
                  <FormattedMessage
                    id="automations.checks"
                    values={{ action: actionLabel(intl, action) }}
                  />
                </span>
              )}
              {done === undefined ? null : (
                <span className="automations__meta">
                  {' · '}
                  <FormattedMessage
                    id={stepProgressKey(done)}
                    values={{
                      until:
                        done.until == null
                          ? ''
                          : intl.formatDate(done.until, { dateStyle: 'short', timeStyle: 'short' }),
                    }}
                  />
                  {done.state === 'awaiting_approval' ? (
                    <>
                      {' · '}
                      <a
                        className="mo-link"
                        href={paths.approvals()}
                        onClick={(event) => {
                          event.preventDefault();
                          navigate(paths.approvals());
                        }}
                      >
                        <FormattedMessage id="nav.approvals" />
                      </a>
                    </>
                  ) : null}
                </span>
              )}
              {done?.answer === null || done?.answer === undefined ? null : (
                <p className="automations__answer">{done.answer}</p>
              )}
              {done === undefined || done.missing.length === 0 ? null : (
                <p className="automations__meta">
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
        <StateMessage kind="error">
          <FormattedMessage id={error} />
        </StateMessage>
      )}
      {detail.status === 'approval_required' && canDecide ? (
        <div className="mo-form__actions">
          <p className="mo-hint automations__hint">
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
        <div className="mo-form__actions">
          <Button variant="secondary" onClick={read}>
            <FormattedMessage id="automations.refresh" />
          </Button>
          {stop === undefined ? null : (
            <Button variant="danger" disabled={pending} onClick={() => void stopPlan()}>
              <FormattedMessage id="automations.stop" />
            </Button>
          )}
        </div>
      ) : null}
    </article>
  );
}

/** Why a plan was refused, said plainly for the reasons a workflow from the editor can meet. */
const REFUSALS = new Set([
  'specialist_not_eligible',
  'permission_not_held',
  'department_not_allowed',
  'plan_denied_by_policy',
]);

/** The action a policy check names, when the step is one. */
function checkActionOf(decision: PlanStepView['decision']): string | undefined {
  const action = decision?.input.action;
  return decision?.decision === CHECK_DECISION && typeof action === 'string' ? action : undefined;
}

/**
 * What a step's progress says. A check says whether it let its branch go on; a step after a
 * check or a declined approval that ended its branch is skipped, never "waiting" forever; a step
 * that asked a person says it waits for them, or that it was rejected or not approved in time. An answer from an older
 * API without `state` falls back to its execution's status.
 */
function stepProgressKey(done: PlanStepProgress): string {
  if (done.kind === 'condition') {
    return done.state === 'completed'
      ? 'automations.check.passed'
      : done.state === 'stopped'
        ? 'automations.check.stopped'
        : done.state === 'failed'
          ? 'automations.check.failed'
          : done.state === 'skipped'
            ? 'automations.stepState.skipped'
            : 'automations.stepStatus.pending';
  }
  if (done.state === 'skipped') return 'automations.stepState.skipped';
  // A wait step (ADR-0152): not started, waiting until a time, or over.
  if (done.kind === 'wait') {
    return done.state === 'delayed'
      ? 'automations.wait.delayed'
      : done.state === 'completed'
        ? 'automations.wait.done'
        : 'automations.stepStatus.pending';
  }
  // A step that asks a person before it runs (ADR-0146).
  if (done.state === 'awaiting_approval') return 'automations.stepState.awaiting_approval';
  if (done.state === 'declined') {
    return done.failure === 'rejected' || done.failure === 'expired'
      ? `automations.stepState.declined.${done.failure}`
      : 'automations.stepState.declined.other';
  }
  return `automations.stepStatus.${stepStatusOf(done.status)}`;
}

const STEP_STATUSES = new Set(['pending', 'running', 'completed', 'failed', 'cancelled']);

/** A step execution's state as the screen names it; any other in-between state is "working". */
const stepStatusOf = (status: string | null): string =>
  status === null || status === 'unknown'
    ? 'pending'
    : STEP_STATUSES.has(status)
      ? status
      : 'running';
