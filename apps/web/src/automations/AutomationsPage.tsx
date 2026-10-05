import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, PageHeader, StateMessage } from '@melonoffice/ui';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AgentTemplateView, SkillView, ToolView } from '../agents/agentsClient.js';
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
  type PlanTraceView,
  type PlanView,
  type ToolResultField,
  type WorkflowDetail,
  type WorkflowStatus,
  type WorkflowStepDraft,
  type WorkflowView,
} from './automationsClient.js';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { draftsOf, WorkflowEditor } from './WorkflowEditor.js';
import {
  failureExplanation,
  refusalExplanation,
  stepNumberOf,
  TechnicalDetail,
} from './explain.js';

/**
 * Automations (WF-3, ADR-0071): the organization's workflows and the plans made from them or by
 * the planner. A person plans an active workflow, reads the plan it gave, and approves or rejects
 * that exact version; approving starts it on the server (ADR-0070), and each step's agent answer
 * is shown once the step completed. The screen runs nothing and shows only what the API gave.
 * A plan reads in the person's words (ADR-0167): who does each step, where it is, what a tool
 * found, what needs their approval, why a step failed and what they can do, and whether the other
 * branches went on. The engine's codes stay folded away as the technical detail.
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
  tools,
  skills,
  decideStep,
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
  /** The tool catalogue (`tool.read`), for tool steps (ADR-0165); without it none is offered. */
  readonly tools?: (() => Promise<readonly ToolView[]>) | undefined;
  /** The skill catalogue, to name the skill that would let an agent use a tool (ADR-0167). */
  readonly skills?: (() => Promise<readonly SkillView[]>) | undefined;
  /**
   * Decides one approval a step waits for (`approval.approve`), the same call as Approvals: the
   * server binds the decision to what was asked, and GIA can never decide. Absent: the plan links
   * to Approvals instead.
   */
  readonly decideStep?:
    ((approvalId: string, decision: 'approve' | 'reject') => Promise<void>) | undefined;
}) {
  const [workflows, setWorkflows] = useState<Load<readonly WorkflowView[]>>({ status: 'loading' });
  const [plans, setPlans] = useState<Load<readonly PlanView[]>>({ status: 'loading' });
  const [selected, setSelected] = useState<string>();
  const [error, setError] = useState<string>();
  const [refused, setRefused] = useState<{
    readonly reason: string;
    readonly stage?: string | undefined;
    readonly detail?: string | undefined;
  }>();
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
  // Who would do each role's steps, for the editor's tool steps (ADR-0167).
  const assignees = useMemo(() => client.assignees?.bind(client), [client]);
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
        setRefused({ reason: outcome.reason, stage: outcome.stage, detail: outcome.detail });
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
          tools={tools}
          assignees={assignees}
          skills={skills}
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
      {refused === undefined ? null : <Refusal refused={refused} />}
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
              decideStep={permissions.decidePlans ? decideStep : undefined}
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

/** Why a workflow could not become a plan: what happened, what to do, and the codes, folded. */
function Refusal({
  refused,
}: {
  readonly refused: {
    readonly reason: string;
    readonly stage?: string | undefined;
    readonly detail?: string | undefined;
  };
}) {
  const { what, todo } = refusalExplanation(refused.reason);
  const n = stepNumberOf(refused.detail);
  return (
    <StateMessage kind="error">
      <strong>
        <FormattedMessage id="automations.refusal.title" />
      </strong>{' '}
      <FormattedMessage id={what} />
      {n === undefined ? null : (
        <>
          {' '}
          <FormattedMessage id="automations.refusal.step" values={{ n }} />
        </>
      )}{' '}
      <FormattedMessage id={todo} />
      <TechnicalDetail codes={[refused.stage, refused.reason, refused.detail]} />
    </StateMessage>
  );
}

/** How often a running plan's screen reads it again, in milliseconds. */
export const PLAN_REFRESH_MS = 10_000;

function PlanCard({
  client,
  planId,
  canDecide,
  onDecided,
  decideStep,
  stop,
}: {
  readonly client: AutomationsClient;
  readonly planId: string;
  readonly canDecide: boolean;
  readonly onDecided: () => void;
  readonly decideStep?:
    ((approvalId: string, decision: 'approve' | 'reject') => Promise<void>) | undefined;
  readonly stop?: ((planId: string) => Promise<void>) | undefined;
}) {
  const intl = useIntl();
  const { specialists } = useOfficeData();
  const agents = readyList(specialists);
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

  // A running plan is read again on its own until it ends (ADR-0167): no button to remember.
  const running = plan.status === 'ready' && isRunningPlan(plan.value);
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(read, PLAN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, read]);

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

  async function decideApproval(approvalId: string, decision: 'approve' | 'reject') {
    if (decideStep === undefined) return;
    setPending(true);
    setError(undefined);
    try {
      await decideStep(approvalId, decision);
      onDecided();
      read();
    } catch {
      setError('automations.approval.failed');
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
  const byId = new Map(detail.current.steps.map((s) => [s.id, s]));
  const date = (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'short', timeStyle: 'short' });
  /** Who does a step: its agent, by name when the office knows it. */
  const agentOf = (step: PlanStepView | undefined): string | undefined => {
    const doer = step?.kind === 'tool' ? byId.get(step.performedBy ?? '') : step;
    const id = doer?.specialist?.id;
    if (id === undefined) return undefined;
    return (
      agents.find((a) => a.id === id)?.displayName ??
      intl.formatMessage({ id: 'automations.anAgent' })
    );
  };
  const toolName = (id: string): string => {
    const key = `approvals.tool.${id}`;
    return intl.messages[key] === undefined ? id : intl.formatMessage({ id: key });
  };
  const failed = steps.filter((s) => s.state === 'failed');
  const now = steps.filter((s) => s.state === 'running' || s.state === 'awaiting_approval');
  const ended =
    detail.status === 'completed' || detail.status === 'failed' || detail.status === 'cancelled';
  return (
    <article className="mo-card automations__plan" aria-labelledby="automations-plan-title">
      <h3 id="automations-plan-title" className="mo-subsection-title">
        {detail.current.request.summary}
      </h3>
      <p className="automations__objective">
        <FormattedMessage
          id="automations.plan.objective"
          values={{ objective: detail.current.request.objective }}
        />
      </p>
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
        {ended && detail.updatedAt !== undefined ? (
          <>
            {' · '}
            <FormattedMessage id="automations.plan.ended" values={{ at: date(detail.updatedAt) }} />
          </>
        ) : null}
      </p>
      {now.length === 0 || ended ? null : (
        <p className="automations__meta">
          <FormattedMessage
            id="automations.plan.now"
            values={{ steps: now.map((s) => `«${s.label}»`).join(', ') }}
          />
        </p>
      )}
      {failed.length === 0 ? null : detail.status === 'completed' ? (
        // A failed branch ends only itself (BR-1, ADR-0162): the plan still completed.
        <StateMessage kind="warning">
          <FormattedMessage id="automations.plan.branchFailed" values={{ n: failed.length }} />
        </StateMessage>
      ) : detail.status === 'failed' ? (
        <StateMessage kind="error">
          <FormattedMessage id="automations.plan.allFailed" />
        </StateMessage>
      ) : isRunningPlan(detail) ? (
        <StateMessage kind="warning">
          <FormattedMessage id="automations.plan.branchFailing" values={{ n: failed.length }} />
        </StateMessage>
      ) : null}
      {detail.status === 'approval_required' &&
      detail.current.estimate?.status === 'estimated' &&
      detail.current.estimate.credits !== null ? (
        <p className="automations__meta">
          <FormattedMessage
            id="automations.estimate"
            values={{ credits: detail.current.estimate.credits }}
          />
        </p>
      ) : detail.status === 'approval_required' && detail.current.estimate?.status === 'unknown' ? (
        // An unknown estimate sets no credit limit, and the plan says so (ADR-0163).
        <p className="automations__meta">
          <FormattedMessage id="automations.estimate.unknown" />
        </p>
      ) : null}
      <ol className="automations__steps">
        {detail.current.steps.map((step) => {
          const done = progress.get(step.id);
          const block = detail.budgetBlocks?.find((b) => b.stepId === step.id);
          const action = checkActionOf(step.decision);
          const agent = agentOf(step);
          return (
            <li key={step.id} className="automations__step">
              <span className="automations__name">{step.label}</span>
              {done === undefined ? null : (
                <span
                  className={`automations__state automations__state--${stateOf(done, block !== undefined)}`}
                >
                  <FormattedMessage
                    id={`automations.state.${stateOf(done, block !== undefined)}`}
                  />
                </span>
              )}
              <p className="automations__meta">
                {action !== undefined ? (
                  <FormattedMessage
                    id="automations.checks"
                    values={{ action: actionLabel(intl, action) }}
                  />
                ) : step.kind === 'tool' && step.tool != null ? (
                  <FormattedMessage
                    id="automations.plan.usesTool"
                    values={{
                      agent: agent ?? intl.formatMessage({ id: 'automations.anAgent' }),
                      tool: toolName(step.tool.id),
                    }}
                  />
                ) : agent !== undefined ? (
                  <FormattedMessage id="automations.plan.doneBy" values={{ agent }} />
                ) : (
                  <FormattedMessage id={`automations.stepKind.${stepKindOf(step.kind)}`} />
                )}
                {done === undefined ? null : (
                  <>
                    {addsToState(done) ? (
                      <>
                        {' · '}
                        <FormattedMessage
                          id={stepProgressKey(done, block !== undefined)}
                          values={{
                            until: done.until == null ? '' : date(done.until),
                            used: block?.usedCredits ?? 0,
                            needed: block?.neededCredits ?? 0,
                            cap: block?.capCredits ?? 0,
                          }}
                        />
                      </>
                    ) : null}
                    {done.attempt == null || done.attempt < 2 ? null : (
                      <>
                        {' · '}
                        <FormattedMessage
                          id="automations.attempt"
                          values={{ attempt: done.attempt }}
                        />
                      </>
                    )}
                    {done.endedAt == null || done.state === 'failed' ? null : (
                      <>
                        {' · '}
                        <FormattedMessage
                          id="automations.step.ended"
                          values={{ at: date(done.endedAt) }}
                        />
                      </>
                    )}
                  </>
                )}
              </p>
              {done?.state === 'awaiting_approval' ? (
                <StepApproval
                  step={step}
                  agent={agent}
                  tool={
                    step.kind === 'tool' && step.tool != null ? toolName(step.tool.id) : undefined
                  }
                  approvalId={done.approvalId ?? undefined}
                  pending={pending}
                  decide={decideStep === undefined ? undefined : decideApproval}
                />
              ) : null}
              {done?.state === 'failed' && done.failure !== 'budget_exceeded' ? (
                <StepFailure done={done} agent={agent} />
              ) : null}
              {done?.result == null ? null : (
                <ToolResult toolId={step.tool?.id ?? ''} fields={done.result} />
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
      {client.trace === undefined || detail.status === 'approval_required' ? null : (
        <PlanTraceDetail load={() => client.trace?.(planId)} />
      )}
    </article>
  );
}

/** A step waiting for the person: what, who asks, why, and the decision itself. */
function StepApproval({
  step,
  agent,
  tool,
  approvalId,
  pending,
  decide,
}: {
  readonly step: PlanStepView;
  readonly agent: string | undefined;
  readonly tool: string | undefined;
  readonly approvalId: string | undefined;
  readonly pending: boolean;
  readonly decide:
    ((approvalId: string, decision: 'approve' | 'reject') => Promise<void>) | undefined;
}) {
  const intl = useIntl();
  return (
    <div className="automations__approval" role="group" aria-label={step.label}>
      <strong>
        <FormattedMessage id="automations.approval.title" />
      </strong>
      <p>
        <FormattedMessage
          id="automations.approval.what"
          values={{
            step: step.label,
            agent: agent ?? intl.formatMessage({ id: 'automations.anAgent' }),
          }}
        />{' '}
        <FormattedMessage
          id={
            tool !== undefined
              ? 'automations.approval.why.tool'
              : step.approvalRequired === true
                ? 'automations.approval.why.step'
                : 'automations.approval.why.policy'
          }
          values={{ tool: tool ?? '' }}
        />
      </p>
      {approvalId === undefined ? null : decide === undefined ? (
        <a
          className="mo-link"
          href={paths.approvals()}
          onClick={(event) => {
            event.preventDefault();
            navigate(paths.approvals());
          }}
        >
          <FormattedMessage id="automations.approval.open" />
        </a>
      ) : (
        <div className="mo-form__actions">
          <Button size="sm" disabled={pending} onClick={() => void decide(approvalId, 'approve')}>
            <FormattedMessage id="automations.approval.approve" />
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={pending}
            onClick={() => void decide(approvalId, 'reject')}
          >
            <FormattedMessage id="automations.approval.reject" />
          </Button>
        </div>
      )}
    </div>
  );
}

/** A failed step: what happened, what it means for the plan, what to do, and the code folded. */
function StepFailure({
  done,
  agent,
}: {
  readonly done: PlanStepProgress;
  readonly agent: string | undefined;
}) {
  const intl = useIntl();
  const { what, todo } = failureExplanation(done.failure);
  return (
    <div className="automations__failure">
      <p>
        <strong>
          <FormattedMessage id="automations.failure.happened" />
        </strong>{' '}
        <FormattedMessage
          id={what}
          values={{
            step: done.label,
            agent: agent ?? intl.formatMessage({ id: 'automations.anAgent' }),
          }}
        />
      </p>
      <p>
        <strong>
          <FormattedMessage id="automations.failure.means" />
        </strong>{' '}
        <FormattedMessage id="automations.failure.meaning" />
      </p>
      <p>
        <strong>
          <FormattedMessage id="automations.failure.todo" />
        </strong>{' '}
        <FormattedMessage id={todo} />
      </p>
      <TechnicalDetail codes={[done.failure ?? undefined, done.stepId]} />
    </div>
  );
}

/** What a tool step found, said plainly; each field's value folded away for whoever needs it. */
function ToolResult({
  toolId,
  fields,
}: {
  readonly toolId: string;
  readonly fields: readonly ToolResultField[];
}) {
  const intl = useIntl();
  const field = (name: string) => fields.find((f) => f.name === name);
  const available = field('available');
  let summary: ReactNode;
  if (available?.type === 'boolean' && !available.value) {
    summary = <FormattedMessage id="automations.result.unavailable" />;
  } else if (toolId === 'knowledge_search' && field('facts')?.type === 'count') {
    const truncated = field('truncated');
    summary = (
      <FormattedMessage
        id={
          truncated?.type === 'boolean' && truncated.value
            ? 'automations.result.knowledge.more'
            : 'automations.result.knowledge'
        }
        values={{ n: field('facts')?.value as number }}
      />
    );
  } else {
    summary = <FormattedMessage id="automations.result.done" />;
  }
  const valueOf = (f: ToolResultField): string =>
    f.type === 'boolean'
      ? intl.formatMessage({ id: f.value ? 'automations.result.yes' : 'automations.result.no' })
      : f.type === 'count'
        ? intl.formatMessage({ id: 'automations.result.count' }, { n: f.value })
        : String(f.value);
  return (
    <div className="automations__result">
      <p>{summary}</p>
      {fields.length === 0 ? null : (
        <details className="automations__technical">
          <summary>
            <FormattedMessage id="automations.result.detail" />
          </summary>
          <ul>
            {fields.map((f) => (
              <li key={f.name}>
                <code>{f.name}</code>: {valueOf(f)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The plan's trace (ADR-0157), read only when the person opens it: codes, times and credits. */
function PlanTraceDetail({ load }: { readonly load: () => Promise<PlanTraceView> | undefined }) {
  const intl = useIntl();
  const [trace, setTrace] = useState<Load<PlanTraceView>>();
  const open = () => {
    if (trace !== undefined) return;
    setTrace({ status: 'loading' });
    const reading = load();
    if (reading === undefined) {
      setTrace({ status: 'error' });
      return;
    }
    reading.then(
      (value) => setTrace({ status: 'ready', value }),
      () => setTrace({ status: 'error' }),
    );
  };
  return (
    <details
      className="automations__technical"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) open();
      }}
    >
      <summary>
        <FormattedMessage id="automations.trace.title" />
      </summary>
      {trace === undefined || trace.status === 'loading' ? (
        <StateMessage kind="loading" inline>
          <FormattedMessage id="automations.loading" />
        </StateMessage>
      ) : trace.status === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="automations.error.generic" />
        </StateMessage>
      ) : (
        <div className="automations__trace">
          <p>
            <FormattedMessage
              id="automations.trace.credits"
              values={{ credits: trace.value.credits.total }}
            />
            {trace.value.failure === null ? null : (
              <>
                {' · '}
                <code>
                  {[trace.value.failure.code, trace.value.failure.stepId, trace.value.failure.cause]
                    .filter((c) => c !== null)
                    .join(' · ')}
                </code>
              </>
            )}
          </p>
          <ul>
            {trace.value.steps.map((s) => (
              <li key={s.stepId}>
                {s.label}
                {s.attempts.map((a) => (
                  <span key={a.attempt} className="automations__meta">
                    {' · '}
                    <FormattedMessage
                      id="automations.trace.attempt"
                      values={{
                        attempt: a.attempt,
                        credits: a.credits,
                        seconds: a.durationMs === null ? '–' : Math.round(a.durationMs / 1000),
                      }}
                    />{' '}
                    <code>{[a.status, a.failure].filter((c) => c !== null).join(' · ')}</code>
                  </span>
                ))}
              </li>
            ))}
          </ul>
          {trace.value.history.length === 0 ? null : (
            <ol className="automations__history">
              {trace.value.history.map((h, i) => (
                <li key={i}>
                  {intl.formatDate(new Date(h.at), { dateStyle: 'short', timeStyle: 'medium' })}{' '}
                  <code>
                    {[h.action, h.result, h.reason].filter((c) => c !== null).join(' · ')}
                  </code>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </details>
  );
}

/** The action a policy check names, when the step is one. */
function checkActionOf(decision: PlanStepView['decision']): string | undefined {
  const action = decision?.input.action;
  return decision?.decision === CHECK_DECISION && typeof action === 'string' ? action : undefined;
}

/**
 * Where a step is, in one word the person reads (ADR-0167): pending, running, waiting for them,
 * waiting for a time, done, failed, skipped, blocked by the credit limit, rejected or stopped.
 */
function stateOf(done: PlanStepProgress, blocked: boolean): string {
  switch (done.state) {
    case 'waiting':
      return 'pending';
    case 'running':
    case 'awaiting_approval':
    case 'completed':
    case 'skipped':
    case 'declined':
    case 'stopped':
      return done.state;
    case 'delayed':
      return 'delayed';
    case 'failed':
      return done.failure === 'budget_exceeded' || blocked ? 'blocked' : 'failed';
    default: {
      // An older API without `state`: its execution's status.
      const status = stepStatusOf(done.status);
      return status === 'completed'
        ? 'completed'
        : status === 'failed' || status === 'cancelled'
          ? 'failed'
          : status === 'running'
            ? 'running'
            : 'pending';
    }
  }
}

/**
 * Whether a step's progress says more than its state word: what a check decided, until when a
 * wait or a retry waits, why a step was skipped, failed or declined. "Done" twice says nothing.
 */
function addsToState(done: PlanStepProgress): boolean {
  if (done.kind === 'condition') return done.state !== 'waiting';
  if (done.kind === 'wait') return done.state === 'delayed' || done.state === 'completed';
  return (
    done.state === 'skipped' ||
    done.state === 'failed' ||
    done.state === 'declined' ||
    done.state === 'delayed' ||
    done.state === undefined
  );
}

/**
 * What a step's progress says. A check says whether it let its branch go on; a step after a
 * check or a declined approval that ended its branch is skipped, never "waiting" forever; a step
 * that asked a person says it waits for them, or that it was rejected or not approved in time. An answer from an older
 * API without `state` falls back to its execution's status.
 */
function stepProgressKey(done: PlanStepProgress, blocked = false): string {
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
  // A step that failed for a passing reason, waiting to run again (ADR-0153).
  if (done.state === 'delayed') return 'automations.retry.delayed';
  // A step that asks a person before it runs (ADR-0146).
  if (done.state === 'awaiting_approval') return 'automations.stepState.awaiting_approval';
  // A step the approved credit budget could not cover never ran (ADR-0163); a failed step ends only
  // its own branch (ADR-0162).
  if (done.state === 'failed') {
    return done.failure === 'budget_exceeded'
      ? blocked
        ? 'automations.stepState.budget'
        : 'automations.stepState.budget.plain'
      : 'automations.stepState.failed';
  }
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
