import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentTemplateView } from '../agents/agentsClient.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { departmentName } from '../office/departments.js';
import {
  AutomationsError,
  CHECK_CONTINUE_ON,
  CHECK_DECISION,
  type WorkflowAgentDraft,
  type WorkflowDecisionView,
  type WorkflowStepDraft,
  type WorkflowView,
} from './automationsClient.js';

/**
 * Writing a workflow (ADR-0028, ADR-0144): a name and its steps. A step is done by an agent with
 * a role (from the agent catalogue), optionally after the person approves it, or is a company
 * policy check (WF-4, ADR-0075) that lets the steps after it run only when the policy allows the
 * action. Each step waits for the earlier steps the person ticks, so a workflow can branch.
 * Saving a workflow that exists writes a new version; the versions before it never change. The
 * server checks everything again.
 */

/** Who can do a step: one department type and role from the catalogue. */
interface RoleChoice {
  readonly key: string;
  readonly departmentTypeId: string;
  readonly roleId: string;
  readonly nameKey: string;
}

const MAX_STEPS = 50;
const keyOf = (departmentTypeId: string, roleId: string) => `${departmentTypeId}/${roleId}`;

function choicesOf(templates: readonly AgentTemplateView[]): readonly RoleChoice[] {
  const seen = new Map<string, RoleChoice>();
  for (const t of templates) {
    const key = keyOf(t.departmentTypeId, t.role.id);
    if (!seen.has(key)) {
      seen.set(key, {
        key,
        departmentTypeId: t.departmentTypeId,
        roleId: t.role.id,
        nameKey: t.nameKey,
      });
    }
  }
  return [...seen.values()];
}

/** A role a saved step already uses stays choosable even when the catalogue no longer has it. */
function withSteps(
  choices: readonly RoleChoice[],
  steps: readonly WorkflowStepDraft[],
): readonly RoleChoice[] {
  const all = [...choices];
  for (const s of steps) {
    if (s.kind !== 'agent') continue;
    const key = keyOf(s.departmentTypeId, s.roleId);
    if (!all.some((c) => c.key === key)) {
      all.push({
        key,
        departmentTypeId: s.departmentTypeId,
        roleId: s.roleId,
        nameKey: `agents.template.${s.roleId.replace(/_agent$/, '')}.name`,
      });
    }
  }
  return all;
}

/** Why saving failed, as one message. */
function saveErrorKey(error: unknown): string {
  if (!(error instanceof AutomationsError)) return 'automations.error.generic';
  switch (error.code) {
    case 'permission_denied':
      return 'automations.error.permission';
    case 'invalid_workflow':
      return error.detail === 'name'
        ? 'automations.editor.error.name'
        : 'automations.editor.error.steps';
    case 'workflow_concurrency_conflict':
    case 'invalid_workflow_transition':
      return 'automations.editor.error.changed';
    default:
      return 'automations.error.generic';
  }
}

export interface WorkflowEditorProps {
  /** A workflow to version, with its current name and steps; none to create one. */
  readonly editing?:
    | {
        readonly id: string;
        readonly name: string;
        readonly steps: readonly WorkflowStepDraft[];
      }
    | undefined;
  readonly templates: () => Promise<readonly AgentTemplateView[]>;
  /** The actions a policy check may name. Absent or failing: only agent steps are offered. */
  readonly checkActions?: (() => Promise<readonly string[]>) | undefined;
  readonly save: (
    name: string,
    steps: readonly WorkflowStepDraft[],
    workflowId?: string,
  ) => Promise<WorkflowView>;
  readonly onSaved: (workflow: WorkflowView) => void;
  readonly onCancel: () => void;
}

export function WorkflowEditor({
  editing,
  templates,
  checkActions,
  save,
  onSaved,
  onCancel,
}: WorkflowEditorProps) {
  const intl = useIntl();
  const { departments } = useOfficeData();
  const depts = readyList(departments);
  const [choices, setChoices] = useState<readonly RoleChoice[] | 'error' | undefined>();
  const [name, setName] = useState(editing?.name ?? '');
  const [steps, setSteps] = useState<readonly WorkflowStepDraft[]>(
    editing?.steps ?? [agentDraft('new_1', [])],
  );
  const [actions, setActions] = useState<readonly string[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();
  // New steps get keys no saved step has: saved ones are named `step_<n>` or by their id.
  const nextKey = useRef(1);

  useEffect(() => {
    let live = true;
    templates().then(
      (list) => live && setChoices(withSteps(choicesOf(list), editing?.steps ?? [])),
      () => live && setChoices('error'),
    );
    return () => {
      live = false;
    };
    // The steps being edited are read once, when the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  useEffect(() => {
    let live = true;
    // Without the catalogue no check is offered; a saved check keeps its action.
    checkActions?.().then(
      (list) => live && setActions(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [checkActions]);

  const actionChoices = [
    ...actions,
    ...steps.flatMap((s) => (s.kind === 'check' && !actions.includes(s.action) ? [s.action] : [])),
  ].filter((a, i, all) => a !== '' && all.indexOf(a) === i);

  const newKey = () => {
    nextKey.current += 1;
    return `new_${nextKey.current}`;
  };
  const change = (index: number, next: WorkflowStepDraft) =>
    setSteps(steps.map((s, i) => (i === index ? next : s)));
  const changeAgent = (index: number, patch: Partial<WorkflowAgentDraft>) => {
    const step = steps[index];
    if (step?.kind === 'agent') change(index, { ...step, ...patch });
  };
  const toggleAfter = (index: number, key: string, on: boolean) => {
    const step = steps[index];
    if (step === undefined) return;
    const earlier = steps.slice(0, index).map((s) => s.key);
    const after = on ? [...step.after, key] : step.after.filter((k) => k !== key);
    change(index, { ...step, after: earlier.filter((k) => after.includes(k)) });
  };
  /** A step waits only for steps before it: anything else is dropped after a move or removal. */
  const ordered = (next: readonly WorkflowStepDraft[]) =>
    next.map((s, i) => {
      const earlier = new Set(next.slice(0, i).map((e) => e.key));
      return { ...s, after: s.after.filter((k) => earlier.has(k)) };
    });
  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const [step] = next.splice(index, 1);
    if (step === undefined) return;
    next.splice(index + by, 0, step);
    setSteps(ordered(next));
  };

  const actionLabel = (a: string): string => {
    const key = `agents.action.${a}`;
    return intl.messages[key] === undefined ? a : intl.formatMessage({ id: key });
  };
  const choiceLabel = (c: RoleChoice): string => {
    const role =
      intl.messages[c.nameKey] === undefined ? c.roleId : intl.formatMessage({ id: c.nameKey });
    const dept = depts.find((d) => d.typeId === c.departmentTypeId);
    return dept === undefined ? role : `${role} · ${departmentName(intl, dept, 'name')}`;
  };

  const complete =
    name.trim() !== '' &&
    steps.length > 0 &&
    steps.every(
      (s) =>
        s.label.trim() !== '' &&
        (s.kind === 'agent'
          ? s.roleId !== ''
          : // A check decides on what came before it, so it waits for at least one step.
            s.action !== '' && s.after.length > 0),
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || sending) return;
    setSending(true);
    setError(undefined);
    try {
      onSaved(await save(name.trim(), steps, editing?.id));
    } catch (failure) {
      setError(saveErrorKey(failure));
    } finally {
      setSending(false);
    }
  };

  const titleId = 'workflow-editor-title';
  return (
    <form
      className="mo-panel mo-page-section workflow-editor"
      aria-labelledby={titleId}
      onSubmit={(e) => void submit(e)}
    >
      <h2 id={titleId} className="mo-section-title">
        <FormattedMessage
          id={editing === undefined ? 'automations.editor.new' : 'automations.editor.version'}
        />
      </h2>
      {choices === undefined ? (
        <StateMessage kind="loading" inline>
          <FormattedMessage id="automations.loading" />
        </StateMessage>
      ) : choices === 'error' ? (
        <StateMessage kind="error">
          <FormattedMessage id="automations.editor.rolesError" />
        </StateMessage>
      ) : (
        <>
          <label className="mo-field">
            <span className="mo-label">
              <FormattedMessage id="automations.editor.name" />
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
            />
          </label>
          <p className="mo-hint">
            <FormattedMessage id="automations.editor.hint" />
          </p>
          <ol className="workflow-editor__steps">
            {steps.map((step, i) => (
              <li key={i} className="workflow-editor__step">
                <label className="mo-field">
                  <span className="mo-label">
                    <FormattedMessage id="automations.editor.stepLabel" values={{ n: i + 1 }} />
                  </span>
                  <input
                    value={step.label}
                    onChange={(e) => change(i, { ...step, label: e.target.value })}
                    maxLength={120}
                    required
                  />
                </label>
                {actionChoices.length === 0 && step.kind === 'agent' ? null : (
                  <label className="mo-field">
                    <span className="mo-label">
                      <FormattedMessage id="automations.editor.kind" />
                    </span>
                    <select
                      value={step.kind}
                      onChange={(e) =>
                        change(
                          i,
                          e.target.value === 'check'
                            ? checkDraft(step.key, step.label, step.after)
                            : { ...agentDraft(step.key, step.after), label: step.label },
                        )
                      }
                    >
                      <option value="agent">
                        {intl.formatMessage({ id: 'automations.editor.kind.agent' })}
                      </option>
                      <option value="check">
                        {intl.formatMessage({ id: 'automations.editor.kind.check' })}
                      </option>
                    </select>
                  </label>
                )}
                {step.kind === 'agent' ? (
                  <>
                    <label className="mo-field">
                      <span className="mo-label">
                        <FormattedMessage id="automations.editor.who" />
                      </span>
                      <select
                        value={step.roleId === '' ? '' : keyOf(step.departmentTypeId, step.roleId)}
                        onChange={(e) => {
                          const c = choices.find((x) => x.key === e.target.value);
                          changeAgent(i, {
                            departmentTypeId: c?.departmentTypeId ?? '',
                            roleId: c?.roleId ?? '',
                          });
                        }}
                        required
                      >
                        <option value="">
                          {intl.formatMessage({ id: 'agents.create.choose' })}
                        </option>
                        {choices.map((c) => (
                          <option key={c.key} value={c.key}>
                            {choiceLabel(c)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="workflow-editor__check">
                      <input
                        type="checkbox"
                        checked={step.approvalRequired}
                        onChange={(e) => changeAgent(i, { approvalRequired: e.target.checked })}
                      />
                      <FormattedMessage id="automations.editor.approval" />
                    </label>
                  </>
                ) : (
                  <>
                    <label className="mo-field">
                      <span className="mo-label">
                        <FormattedMessage id="automations.editor.check.action" />
                      </span>
                      <select
                        value={step.action}
                        onChange={(e) => change(i, { ...step, action: e.target.value })}
                        required
                      >
                        <option value="">
                          {intl.formatMessage({ id: 'agents.create.choose' })}
                        </option>
                        {actionChoices.map((a) => (
                          <option key={a} value={a}>
                            {actionLabel(a)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="mo-field">
                      <span className="mo-label">
                        <FormattedMessage id="automations.editor.check.discount" />
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step="any"
                        value={step.discountPercent ?? ''}
                        onChange={(e) =>
                          change(i, {
                            ...step,
                            discountPercent: e.target.value === '' ? null : Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <p className="mo-hint">
                      <FormattedMessage id="automations.editor.check.hint" />
                    </p>
                  </>
                )}
                {i === 0 ? null : (
                  <fieldset className="mo-field">
                    <legend className="mo-label">
                      <FormattedMessage id="automations.editor.after" />
                    </legend>
                    {steps.slice(0, i).map((before, j) => (
                      <label key={before.key} className="workflow-editor__check">
                        <input
                          type="checkbox"
                          checked={step.after.includes(before.key)}
                          onChange={(e) => toggleAfter(i, before.key, e.target.checked)}
                        />
                        <FormattedMessage
                          id="automations.editor.afterStep"
                          values={{ n: j + 1, label: before.label.trim() }}
                        />
                      </label>
                    ))}
                  </fieldset>
                )}
                <div className="mo-form__actions">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    iconOnly
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={intl.formatMessage({ id: 'automations.editor.up' }, { n: i + 1 })}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    iconOnly
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={intl.formatMessage({ id: 'automations.editor.down' }, { n: i + 1 })}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={steps.length === 1}
                    onClick={() => setSteps(ordered(steps.filter((_, j) => j !== i)))}
                  >
                    <FormattedMessage id="automations.editor.remove" values={{ n: i + 1 }} />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <div className="mo-form__actions">
            <Button
              type="button"
              variant="secondary"
              disabled={steps.length >= MAX_STEPS}
              onClick={() =>
                setSteps([
                  ...steps,
                  agentDraft(
                    newKey(),
                    steps.slice(-1).map((s) => s.key),
                  ),
                ])
              }
            >
              <FormattedMessage id="automations.editor.addStep" />
            </Button>
          </div>
          {error === undefined ? null : (
            <StateMessage kind="error">
              <FormattedMessage id={error} />
            </StateMessage>
          )}
          <div className="mo-form__actions">
            <Button type="submit" disabled={!complete || sending}>
              <FormattedMessage
                id={
                  sending
                    ? 'automations.editor.saving'
                    : editing === undefined
                      ? 'automations.editor.create'
                      : 'automations.editor.publish'
                }
              />
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={sending}>
              <FormattedMessage id="agents.create.cancel" />
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

const agentDraft = (key: string, after: readonly string[]): WorkflowStepDraft => ({
  kind: 'agent',
  key,
  label: '',
  after,
  departmentTypeId: '',
  roleId: '',
  approvalRequired: false,
});

const checkDraft = (key: string, label: string, after: readonly string[]): WorkflowStepDraft => ({
  kind: 'check',
  key,
  label,
  after,
  action: '',
  discountPercent: null,
});

/** A check the editor wrote: the policy check, going on only when allowed, with its input. */
function checkOf(
  decision: WorkflowDecisionView,
): { readonly action: string; readonly discountPercent: number | null } | undefined {
  const { action, discountPercent, ...rest } = decision.input;
  const same =
    decision.decision === CHECK_DECISION &&
    decision.continueOn.length === CHECK_CONTINUE_ON.length &&
    decision.continueOn.every((o) => CHECK_CONTINUE_ON.includes(o));
  if (!same || typeof action !== 'string' || Object.keys(rest).length > 0) return undefined;
  if (discountPercent !== undefined && typeof discountPercent !== 'number') return undefined;
  return { action, discountPercent: discountPercent ?? null };
}

/** A workflow's steps as the editor writes them, when every step is one it can write. */
export function draftsOf(
  steps: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly dependsOn: readonly string[];
    readonly assignee: { readonly departmentTypeId: string; readonly roleId: string } | null;
    readonly decision?: WorkflowDecisionView | null;
    readonly approvalRequired: boolean;
  }[],
): readonly WorkflowStepDraft[] | undefined {
  const drafts: WorkflowStepDraft[] = [];
  for (const [i, s] of steps.entries()) {
    // A step may wait only for steps before it: any other shape would be lost by rewriting it.
    const earlier = new Set(steps.slice(0, i).map((e) => e.id));
    if (!s.dependsOn.every((d) => earlier.has(d))) return undefined;
    const base = { key: s.id, label: s.label, after: [...s.dependsOn] };
    if (s.kind === 'specialist' && s.assignee !== null) {
      drafts.push({
        ...base,
        kind: 'agent',
        departmentTypeId: s.assignee.departmentTypeId,
        roleId: s.assignee.roleId,
        approvalRequired: s.approvalRequired,
      });
      continue;
    }
    const check =
      s.kind === 'condition' && !s.approvalRequired && s.decision != null
        ? checkOf(s.decision)
        : undefined;
    if (check === undefined) return undefined;
    drafts.push({ ...base, kind: 'check', ...check });
  }
  return drafts;
}
