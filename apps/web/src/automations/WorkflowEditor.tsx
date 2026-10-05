import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentTemplateView, SkillView, ToolView } from '../agents/agentsClient.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { departmentName } from '../office/departments.js';
import {
  AutomationsError,
  CHECK_CONTINUE_ON,
  CHECK_DECISION,
  MAX_WAIT_SECONDS,
  WAIT_UNIT_SECONDS,
  waitSecondsOf,
  type ToolValueDraft,
  type WaitUnit,
  type WorkflowAgentDraft,
  type WorkflowDecisionView,
  type WorkflowStepDraft,
  type WorkflowStepView,
  type WorkflowToolDraft,
  type WorkflowView,
} from './automationsClient.js';
import { stepNumberOf, TechnicalDetail } from './explain.js';
import {
  roleAgentOf,
  sourceKey,
  sourcesFor,
  tidy,
  toolAvailability,
  toolChoicesOf,
  toolStepComplete,
  type RoleAgent,
  type ToolAvailability,
  type ToolChoice,
} from './toolSteps.js';

/**
 * Writing a workflow (ADR-0028, ADR-0144): a name and its steps. A step is done by an agent with
 * a role (from the agent catalogue), optionally after the person approves it, or is a company
 * policy check (WF-4, ADR-0075) that lets the steps after it run only when the policy allows the
 * action, or a set time to wait before the steps after it (ADR-0152, ADR-0158), or a tool that
 * only reads, used by an earlier agent step's agent (ADR-0165). Each step waits for the earlier
 * steps the person ticks, so a workflow can branch.
 * Saving a workflow that exists writes a new version; the versions before it never change. The
 * server checks everything again.
 * This is the advanced mode (ADR-0167): every step and its wiring. It offers a tool only when the
 * agent that would do its agent step may use it (Agent → Skill → Tool, as the server reads it), and
 * says what is still missing before it can be saved.
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

/** Why saving failed, as one message, and the server's codes for the technical detail. */
interface SaveError {
  readonly key: string;
  readonly values?: Readonly<Record<string, number>>;
  readonly codes: readonly (string | undefined)[];
}

function saveErrorOf(error: unknown): SaveError {
  if (!(error instanceof AutomationsError)) return { key: 'automations.error.generic', codes: [] };
  const codes = [error.code, error.detail];
  switch (error.code) {
    case 'permission_denied':
      return { key: 'automations.error.permission', codes };
    case 'invalid_workflow': {
      if (error.detail === 'name') return { key: 'automations.editor.error.name', codes };
      const n = stepNumberOf(error.detail);
      if (n === undefined) return { key: 'automations.editor.error.steps', codes };
      // Which step, and for a wait or a tool step what about it, as the server named it.
      const part = /\.(wait|tool|input|inputFrom|performedBy|decision)\b/.exec(
        error.detail ?? '',
      )?.[1];
      const key =
        part === 'wait'
          ? 'automations.editor.error.wait'
          : part === 'decision'
            ? 'automations.editor.error.check'
            : part === undefined
              ? 'automations.editor.error.step'
              : 'automations.editor.error.tool';
      return { key, values: { n }, codes };
    }
    case 'workflow_concurrency_conflict':
    case 'invalid_workflow_transition':
      return { key: 'automations.editor.error.changed', codes };
    default:
      return { key: 'automations.error.generic', codes };
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
  /** The tool catalogue (`tool.read`). Absent or failing: no tool step is offered. */
  readonly tools?: (() => Promise<readonly ToolView[]>) | undefined;
  /**
   * Who would do each role's steps today and the tools its skills let it use (ADR-0167). Absent
   * or failing: no tool is offered as usable, since the editor cannot tell who would use it.
   */
  readonly assignees?: (() => Promise<readonly RoleAgent[]>) | undefined;
  /** The skill catalogue, to name the skill that would let an agent use a tool. */
  readonly skills?: (() => Promise<readonly SkillView[]>) | undefined;
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
  tools,
  assignees,
  skills,
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
  const [toolChoices, setToolChoices] = useState<readonly ToolChoice[]>([]);
  // Undefined while loading or when it failed: then no tool is offered as usable.
  const [agents, setAgents] = useState<readonly RoleAgent[]>();
  const [skillList, setSkillList] = useState<readonly SkillView[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<SaveError>();
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

  useEffect(() => {
    let live = true;
    // Without the catalogue no tool step is offered; a saved one keeps its tool and input.
    tools?.().then(
      (list) => live && setToolChoices(toolChoicesOf(list)),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [tools]);

  useEffect(() => {
    let live = true;
    assignees?.().then(
      (list) => live && setAgents(list),
      () => undefined,
    );
    skills?.().then(
      (list) => live && setSkillList(list),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [assignees, skills]);

  const actionChoices = [
    ...actions,
    ...steps.flatMap((s) => (s.kind === 'check' && !actions.includes(s.action) ? [s.action] : [])),
  ].filter((a, i, all) => a !== '' && all.indexOf(a) === i);

  const newKey = () => {
    nextKey.current += 1;
    return `new_${nextKey.current}`;
  };
  const update = (next: readonly WorkflowStepDraft[]) => setSteps(tidy(next, toolChoices));
  const change = (index: number, next: WorkflowStepDraft) =>
    update(steps.map((s, i) => (i === index ? next : s)));
  const changeAgent = (index: number, patch: Partial<WorkflowAgentDraft>) => {
    const step = steps[index];
    if (step?.kind === 'agent') change(index, { ...step, ...patch });
  };
  const changeTool = (index: number, patch: Partial<WorkflowToolDraft>) => {
    const step = steps[index];
    if (step?.kind === 'tool') change(index, { ...step, ...patch });
  };
  const setValue = (index: number, name: string, value: ToolValueDraft | undefined) => {
    const step = steps[index];
    if (step?.kind !== 'tool') return;
    const rest = Object.fromEntries(Object.entries(step.values).filter(([k]) => k !== name));
    changeTool(index, { values: value === undefined ? rest : { ...rest, [name]: value } });
  };
  const toggleAfter = (index: number, key: string, on: boolean) => {
    const step = steps[index];
    if (step === undefined) return;
    const earlier = steps.slice(0, index).map((s) => s.key);
    const after = on ? [...step.after, key] : step.after.filter((k) => k !== key);
    change(index, { ...step, after: earlier.filter((k) => after.includes(k)) });
  };
  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const [step] = next.splice(index, 1);
    if (step === undefined) return;
    next.splice(index + by, 0, step);
    update(next);
  };
  /** The nearest agent step before `index`: who a new tool step's tool is for. */
  const performerBefore = (index: number): string =>
    steps
      .slice(0, index)
      .filter((s) => s.kind === 'agent')
      .at(-1)?.key ?? '';
  // Tools are named as Approvals names them; else by their id.
  const toolLabel = (c: { readonly id: string }): string => {
    const key = `approvals.tool.${c.id}`;
    return intl.messages[key] === undefined ? c.id : intl.formatMessage({ id: key });
  };
  const fieldLabel = (toolId: string, name: string): string => {
    const key = `automations.editor.toolInput.${toolId}.${name}`;
    return intl.messages[key] === undefined ? name : intl.formatMessage({ id: key });
  };
  const stepName = (index: number): string =>
    intl.formatMessage(
      { id: 'automations.editor.afterStep' },
      { n: index + 1, label: steps[index]?.label.trim() ?? '' },
    );

  const actionLabel = (a: string): string => {
    const key = `agents.action.${a}`;
    return intl.messages[key] === undefined ? a : intl.formatMessage({ id: key });
  };
  const choiceLabel = (c: RoleChoice): string => {
    const role =
      intl.messages[c.nameKey] === undefined ? c.roleId : intl.formatMessage({ id: c.nameKey });
    const dept = depts.find((d) => d.typeId === c.departmentTypeId);
    const named = dept === undefined ? role : `${role} · ${departmentName(intl, dept, 'name')}`;
    // A role no active agent has: a plan of it would be refused, and the list says so.
    return agents !== undefined && roleAgentOf(agents, c) === undefined
      ? intl.formatMessage({ id: 'automations.editor.who.none' }, { role: named })
      : named;
  };
  const availabilityOf = (step: WorkflowToolDraft, tool: { id: string; version: number }) =>
    toolAvailability(steps, step.performer, tool, agents);
  /** The skill that lets an agent use a tool version, by its name, when the catalogue has one. */
  const grantingSkill = (tool: { id: string; version: number }) => {
    const skill = skillList.find((k) =>
      k.tools.some((t) => t.id === tool.id && t.versions.includes(tool.version)),
    );
    if (skill === undefined) return undefined;
    const label =
      intl.messages[skill.nameKey] === undefined
        ? skill.id
        : intl.formatMessage({ id: skill.nameKey });
    return { name: label, version: skill.version };
  };

  /** What still keeps the workflow from being saved, one message per thing. */
  const problems: { readonly id: string; readonly values?: Record<string, string | number> }[] = [];
  if (name.trim() === '') problems.push({ id: 'automations.editor.missing.name' });
  steps.forEach((s, i) => {
    const n = i + 1;
    if (s.label.trim() === '')
      problems.push({ id: 'automations.editor.missing.label', values: { n } });
    if (s.kind === 'agent') {
      if (s.roleId === '') problems.push({ id: 'automations.editor.missing.who', values: { n } });
      return;
    }
    if (s.kind === 'tool') {
      if (s.performer === '' || s.toolId === '') {
        problems.push({ id: 'automations.editor.missing.tool', values: { n } });
      } else if (!availabilityOf(s, { id: s.toolId, version: s.toolVersion }).ok) {
        problems.push({ id: 'automations.editor.missing.toolUnavailable', values: { n } });
      } else if (!toolStepComplete(s, toolChoices)) {
        problems.push({ id: 'automations.editor.missing.toolInput', values: { n } });
      }
      return;
    }
    // A check decides on, and a wait follows, what came before it: each waits for a step.
    if (s.after.length === 0) {
      problems.push({ id: 'automations.editor.missing.after', values: { n } });
    }
    if (s.kind === 'check' && s.action === '') {
      problems.push({ id: 'automations.editor.missing.action', values: { n } });
    }
    if (s.kind === 'wait' && waitSecondsOf(s) === undefined) {
      problems.push({ id: 'automations.editor.missing.wait', values: { n } });
    }
  });
  const complete = steps.length > 0 && problems.length === 0;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!complete || sending) return;
    setSending(true);
    setError(undefined);
    try {
      onSaved(await save(name.trim(), steps, editing?.id));
    } catch (failure) {
      setError(saveErrorOf(failure));
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
            <strong>
              <FormattedMessage id="automations.editor.advanced" />
            </strong>{' '}
            <FormattedMessage id="automations.editor.advancedHint" />
          </p>
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
                {i === 0 && actionChoices.length === 0 && step.kind === 'agent' ? null : (
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
                            : e.target.value === 'wait'
                              ? waitDraft(step.key, step.label, step.after)
                              : e.target.value === 'tool'
                                ? toolDraft(step.key, step.label, performerBefore(i))
                                : { ...agentDraft(step.key, step.after), label: step.label },
                        )
                      }
                    >
                      <option value="agent">
                        {intl.formatMessage({ id: 'automations.editor.kind.agent' })}
                      </option>
                      {actionChoices.length === 0 && step.kind !== 'check' ? null : (
                        <option value="check">
                          {intl.formatMessage({ id: 'automations.editor.kind.check' })}
                        </option>
                      )}
                      <option value="wait">
                        {intl.formatMessage({ id: 'automations.editor.kind.wait' })}
                      </option>
                      {step.kind === 'tool' ||
                      (toolChoices.length > 0 && performerBefore(i) !== '') ? (
                        <option value="tool">
                          {intl.formatMessage({ id: 'automations.editor.kind.tool' })}
                        </option>
                      ) : null}
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
                    {step.roleId === '' || agents === undefined ? null : (
                      <RoleAgentHint agent={roleAgentOf(agents, step)} />
                    )}
                    <label className="workflow-editor__check">
                      <input
                        type="checkbox"
                        checked={step.approvalRequired}
                        onChange={(e) => changeAgent(i, { approvalRequired: e.target.checked })}
                      />
                      <FormattedMessage id="automations.editor.approval" />
                    </label>
                  </>
                ) : step.kind === 'tool' ? (
                  <ToolStepFields
                    step={step}
                    index={i}
                    steps={steps}
                    choices={toolChoices}
                    stepName={stepName}
                    toolLabel={toolLabel}
                    fieldLabel={fieldLabel}
                    availability={(tool) => availabilityOf(step, tool)}
                    grantingSkill={grantingSkill}
                    onPerformer={(performer) => changeTool(i, { performer })}
                    onTool={(c) =>
                      changeTool(i, {
                        toolId: c?.id ?? '',
                        toolVersion: c?.version ?? 0,
                        values: {},
                      })
                    }
                    onValue={(name, value) => setValue(i, name, value)}
                  />
                ) : step.kind === 'wait' ? (
                  <>
                    <label className="mo-field">
                      <span className="mo-label">
                        <FormattedMessage id="automations.editor.wait.amount" />
                      </span>
                      <input
                        type="number"
                        min={1}
                        max={MAX_WAIT_SECONDS / WAIT_UNIT_SECONDS[step.unit]}
                        step={1}
                        value={step.amount ?? ''}
                        onChange={(e) =>
                          change(i, {
                            ...step,
                            amount: e.target.value === '' ? null : Number(e.target.value),
                          })
                        }
                        required
                      />
                    </label>
                    <label className="mo-field">
                      <span className="mo-label">
                        <FormattedMessage id="automations.editor.wait.unit" />
                      </span>
                      <select
                        value={step.unit}
                        onChange={(e) => change(i, { ...step, unit: e.target.value as WaitUnit })}
                      >
                        {(Object.keys(WAIT_UNIT_SECONDS) as WaitUnit[]).map((u) => (
                          <option key={u} value={u}>
                            {intl.formatMessage({ id: `automations.editor.wait.${u}` })}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="mo-hint">
                      <FormattedMessage id="automations.editor.wait.hint" />
                    </p>
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
                {i === 0 || step.kind === 'tool' ? null : (
                  <fieldset className="mo-field">
                    <legend className="mo-label">
                      <FormattedMessage id="automations.editor.after" />
                    </legend>
                    {steps.slice(0, i).map((before, j) =>
                      // A tool step ends with its agent step: steps wait for that one instead.
                      before.kind === 'tool' ? null : (
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
                      ),
                    )}
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
                    onClick={() => update(steps.filter((_, j) => j !== i))}
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
                    steps
                      .filter((s) => s.kind !== 'tool')
                      .slice(-1)
                      .map((s) => s.key),
                  ),
                ])
              }
            >
              <FormattedMessage id="automations.editor.addStep" />
            </Button>
          </div>
          {error === undefined ? null : (
            <StateMessage kind="error">
              <FormattedMessage id={error.key} values={error.values ?? {}} />
              <TechnicalDetail codes={error.codes} />
            </StateMessage>
          )}
          {complete ? null : (
            <div className="mo-hint workflow-editor__missing" aria-live="polite">
              <FormattedMessage id="automations.editor.missing" />
              <ul>
                {problems.map((p, i) => (
                  <li key={i}>
                    <FormattedMessage id={p.id} values={p.values ?? {}} />
                  </li>
                ))}
              </ul>
            </div>
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

const waitDraft = (key: string, label: string, after: readonly string[]): WorkflowStepDraft => ({
  kind: 'wait',
  key,
  label,
  after,
  amount: null,
  unit: 'hours',
});

/** A wait in the largest unit it is a whole number of, as the editor shows it. */
function waitOf(seconds: number): { readonly amount: number; readonly unit: WaitUnit } {
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    if (seconds % WAIT_UNIT_SECONDS[unit] === 0) {
      return { amount: seconds / WAIT_UNIT_SECONDS[unit], unit };
    }
  }
  // Seconds the editor cannot show: not offered for rewriting (`draftsOf` refuses it).
  return { amount: seconds, unit: 'minutes' };
}

const toolDraft = (key: string, label: string, performer: string): WorkflowStepDraft => ({
  kind: 'tool',
  key,
  label,
  after: performer === '' ? [] : [performer],
  performer,
  toolId: '',
  toolVersion: 0,
  values: {},
});

/**
 * A tool step's agent step, its tool, and where each input comes from (ADR-0165). Only the sources
 * a plan would accept are offered (`sourcesFor`); a fixed value is typed by the field.
 */
function ToolStepFields({
  step,
  index,
  steps,
  choices,
  stepName,
  toolLabel,
  fieldLabel,
  availability,
  grantingSkill,
  onPerformer,
  onTool,
  onValue,
}: {
  readonly step: WorkflowToolDraft;
  readonly index: number;
  readonly steps: readonly WorkflowStepDraft[];
  readonly choices: readonly ToolChoice[];
  readonly stepName: (index: number) => string;
  readonly toolLabel: (c: { readonly id: string }) => string;
  readonly fieldLabel: (toolId: string, name: string) => string;
  readonly availability: (tool: {
    readonly id: string;
    readonly version: number;
  }) => ToolAvailability;
  readonly grantingSkill: (tool: {
    readonly id: string;
    readonly version: number;
  }) => { readonly name: string; readonly version: number } | undefined;
  readonly onPerformer: (key: string) => void;
  readonly onTool: (choice: ToolChoice | undefined) => void;
  readonly onValue: (name: string, value: ToolValueDraft | undefined) => void;
}) {
  const intl = useIntl();
  const tool = choices.find((c) => c.id === step.toolId && c.version === step.toolVersion);
  const toolKey = (c: { readonly id: string; readonly version: number }) => `${c.id}@${c.version}`;
  return (
    <>
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="automations.editor.tool.performer" />
        </span>
        <select value={step.performer} onChange={(e) => onPerformer(e.target.value)} required>
          <option value="">{intl.formatMessage({ id: 'agents.create.choose' })}</option>
          {steps.slice(0, index).map((s, j) =>
            s.kind === 'agent' ? (
              <option key={s.key} value={s.key}>
                {stepName(j)}
              </option>
            ) : null,
          )}
        </select>
      </label>
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="automations.editor.tool.tool" />
        </span>
        <select
          value={step.toolId === '' ? '' : toolKey({ id: step.toolId, version: step.toolVersion })}
          onChange={(e) => onTool(choices.find((c) => toolKey(c) === e.target.value))}
          required
        >
          <option value="">{intl.formatMessage({ id: 'agents.create.choose' })}</option>
          {step.toolId !== '' && tool === undefined ? (
            <option value={toolKey({ id: step.toolId, version: step.toolVersion })}>
              {step.toolId}
            </option>
          ) : null}
          {choices.map((c) => {
            // A tool the step's agent may not use is shown, never chosen (ADR-0167).
            const usable = availability(c).ok;
            return (
              <option key={toolKey(c)} value={toolKey(c)} disabled={!usable}>
                {usable
                  ? toolLabel(c)
                  : intl.formatMessage(
                      { id: 'automations.editor.tool.unavailable' },
                      { tool: toolLabel(c) },
                    )}
              </option>
            );
          })}
        </select>
      </label>
      {step.toolId === '' ? (
        choices.some((c) => !availability(c).ok) ? (
          <UnavailableTools
            why={choices.map(availability).find((a) => !a.ok)}
            toolLabel={toolLabel}
            choices={choices}
            availability={availability}
            grantingSkill={grantingSkill}
          />
        ) : null
      ) : (
        <ChosenToolNotice
          availability={availability({ id: step.toolId, version: step.toolVersion })}
          tool={toolLabel({ id: step.toolId })}
          skill={grantingSkill({ id: step.toolId, version: step.toolVersion })}
        />
      )}
      {tool === undefined
        ? null
        : tool.input.map((field) => {
            const value = step.values[field.name];
            const sources = sourcesFor(steps, index, tool, field, choices);
            const label = fieldLabel(tool.id, field.name);
            const fixed = value === undefined || value.from === 'fixed' ? value : undefined;
            return (
              <fieldset key={field.name} className="mo-field">
                <legend className="mo-label">
                  {field.required ? (
                    label
                  ) : (
                    <FormattedMessage id="automations.editor.tool.optional" values={{ label }} />
                  )}
                </legend>
                {sources.length === 0 ? null : (
                  <select
                    aria-label={intl.formatMessage(
                      { id: 'automations.editor.tool.source' },
                      { label },
                    )}
                    value={value === undefined ? 'fixed' : sourceKey(value)}
                    onChange={(e) =>
                      onValue(
                        field.name,
                        sources.find((src) => sourceKey(src.value) === e.target.value)?.value,
                      )
                    }
                  >
                    <option value="fixed">
                      {intl.formatMessage({ id: 'automations.editor.tool.fixed' })}
                    </option>
                    {sources.map((src) => (
                      <option key={sourceKey(src.value)} value={sourceKey(src.value)}>
                        {src.field === undefined
                          ? intl.formatMessage(
                              { id: 'automations.editor.tool.answer' },
                              { step: stepName(src.index) },
                            )
                          : intl.formatMessage(
                              { id: 'automations.editor.tool.result' },
                              { step: stepName(src.index), field: src.field },
                            )}
                      </option>
                    ))}
                  </select>
                )}
                {value !== undefined && value.from !== 'fixed' ? null : (
                  <FixedValue
                    field={field}
                    label={label}
                    value={fixed?.value}
                    onChange={(v) =>
                      onValue(field.name, v === undefined ? undefined : { from: 'fixed', value: v })
                    }
                  />
                )}
              </fieldset>
            );
          })}
      <p className="mo-hint">
        <FormattedMessage id="automations.editor.tool.hint" />
      </p>
    </>
  );
}

/** Who a role's step would go to today, or that no active agent has the role (ADR-0167). */
function RoleAgentHint({ agent }: { readonly agent: RoleAgent | undefined }) {
  return agent === undefined ? (
    <StateMessage kind="warning" inline>
      <FormattedMessage id="automations.editor.who.noAgent" />
    </StateMessage>
  ) : (
    <p className="mo-hint">
      <FormattedMessage
        id="automations.editor.who.agent"
        values={{ agent: agent.agent.displayName }}
      />
    </p>
  );
}

/** Why a tool cannot be used by the agent that would do the step, and what would let it. */
function unavailableMessage(
  why: Extract<ToolAvailability, { ok: false }>,
  tool: string,
  skill: { readonly name: string; readonly version: number } | undefined,
) {
  const agent = why.agent?.displayName ?? '';
  return (
    <>
      <FormattedMessage id={`automations.editor.tool.why.${why.why}`} values={{ tool, agent }} />
      {why.why === 'not_granted' && skill !== undefined ? (
        <>
          {' '}
          <FormattedMessage
            id="automations.editor.tool.grantedBy"
            values={{ skill: skill.name, version: skill.version, agent }}
          />
        </>
      ) : null}
    </>
  );
}

/** The chosen tool, when the step's agent may not use it: never left to fail when planned. */
function ChosenToolNotice({
  availability,
  tool,
  skill,
}: {
  readonly availability: ToolAvailability;
  readonly tool: string;
  readonly skill: { readonly name: string; readonly version: number } | undefined;
}) {
  if (availability.ok) {
    return (
      <p className="mo-hint">
        <FormattedMessage
          id="automations.editor.tool.usedBy"
          values={{ agent: availability.agent.displayName, tool }}
        />
      </p>
    );
  }
  return (
    <StateMessage kind="warning">
      <strong>
        <FormattedMessage id="automations.editor.tool.notAvailable" />
      </strong>{' '}
      {unavailableMessage(availability, tool, skill)}
    </StateMessage>
  );
}

/** Why some tools are listed but cannot be chosen for this step. */
function UnavailableTools({
  why,
  choices,
  toolLabel,
  availability,
  grantingSkill,
}: {
  readonly why: ToolAvailability | undefined;
  readonly choices: readonly ToolChoice[];
  readonly toolLabel: (c: { readonly id: string }) => string;
  readonly availability: (tool: {
    readonly id: string;
    readonly version: number;
  }) => ToolAvailability;
  readonly grantingSkill: (tool: {
    readonly id: string;
    readonly version: number;
  }) => { readonly name: string; readonly version: number } | undefined;
}) {
  if (why === undefined || why.ok) return null;
  // No agent step, no agent or nothing known: one reason for all of them.
  if (why.why !== 'not_granted') {
    return (
      <p className="mo-hint">
        <FormattedMessage
          id={`automations.editor.tool.why.${why.why}`}
          values={{ tool: '', agent: '' }}
        />
      </p>
    );
  }
  return (
    <ul className="mo-hint workflow-editor__missing">
      {choices.map((c) => {
        const a = availability(c);
        return a.ok ? null : (
          <li key={`${c.id}@${c.version}`}>
            {unavailableMessage(a, toolLabel(c), grantingSkill(c))}
          </li>
        );
      })}
    </ul>
  );
}

/** A fixed input value, typed by its field: text, one of a list, a number or yes/no. */
function FixedValue({
  field,
  label,
  value,
  onChange,
}: {
  readonly field: ToolChoice['input'][number];
  readonly label: string;
  readonly value: string | number | boolean | undefined;
  readonly onChange: (value: string | number | boolean | undefined) => void;
}) {
  const intl = useIntl();
  if (field.type === 'boolean') {
    return (
      <label className="workflow-editor__check">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }
  if (field.enum !== undefined) {
    return (
      <select
        aria-label={label}
        value={typeof value === 'string' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
        required={field.required}
      >
        <option value="">{intl.formatMessage({ id: 'agents.create.choose' })}</option>
        {field.enum.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return (
      <input
        aria-label={label}
        type="number"
        step={field.type === 'integer' ? 1 : 'any'}
        min={field.minimum}
        max={field.maximum}
        value={typeof value === 'number' ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        required={field.required}
      />
    );
  }
  return (
    <input
      aria-label={label}
      value={typeof value === 'string' ? value : ''}
      minLength={field.minLength}
      maxLength={field.maxLength}
      onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}
      required={field.required}
    />
  );
}

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
  steps: readonly WorkflowStepView[],
): readonly WorkflowStepDraft[] | undefined {
  const drafts: WorkflowStepDraft[] = [];
  for (const [i, s] of steps.entries()) {
    // A step may wait only for steps before it: any other shape would be lost by rewriting it.
    const earlier = new Set(steps.slice(0, i).map((e) => e.id));
    if (!s.dependsOn.every((d) => earlier.has(d))) return undefined;
    const base = { key: s.id, label: s.label, after: [...s.dependsOn] };
    if (s.kind === 'tool') {
      const tool = toolOf(s, drafts);
      if (tool === undefined) return undefined;
      drafts.push({ ...base, kind: 'tool', ...tool });
      continue;
    }
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
    if (s.kind === 'wait') {
      // A wait of whole minutes: anything else would change by rewriting it.
      if (s.wait == null || s.wait.seconds % 60 !== 0) return undefined;
      drafts.push({ ...base, kind: 'wait', ...waitOf(s.wait.seconds) });
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

/**
 * A tool step the editor wrote: it waits for its agent step alone, its fixed input is plain values
 * and every reference names an earlier step. Any other shape would change by rewriting it.
 */
function toolOf(
  s: WorkflowStepView,
  earlier: readonly WorkflowStepDraft[],
): Pick<WorkflowToolDraft, 'performer' | 'toolId' | 'toolVersion' | 'values'> | undefined {
  const performer = s.performedBy ?? '';
  const isAgent = (key: string) => earlier.some((d) => d.key === key && d.kind === 'agent');
  if (s.tool == null || s.approvalRequired || !isAgent(performer)) return undefined;
  if (s.dependsOn.length !== 1 || s.dependsOn[0] !== performer) return undefined;
  const values: Record<string, ToolValueDraft> = {};
  for (const [key, value] of Object.entries(s.input ?? {})) {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return undefined;
    }
    values[key] = { from: 'fixed', value };
  }
  for (const [key, ref] of Object.entries(s.inputFrom ?? {})) {
    const source = earlier.find((d) => d.key === ref.step);
    if (source === undefined) return undefined;
    values[key] =
      ref.field === undefined
        ? { from: 'answer', step: ref.step }
        : { from: 'result', step: ref.step, field: ref.field };
  }
  return { performer, toolId: s.tool.id, toolVersion: s.tool.version, values };
}
