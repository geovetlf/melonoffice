import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button } from '@melonoffice/ui';
import { useEffect, useState, type FormEvent } from 'react';
import type { AgentTemplateView } from '../agents/agentsClient.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { departmentName } from '../office/departments.js';
import {
  AutomationsError,
  type WorkflowStepDraft,
  type WorkflowView,
} from './automationsClient.js';

/**
 * Writing a workflow (ADR-0028): a name and its steps, one after another, each done by an agent
 * with a role (from the agent catalogue), optionally after the person approves it. Saving a
 * workflow that exists writes a new version; the versions before it never change. The server
 * checks everything again.
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
    editing?.steps ?? [{ label: '', departmentTypeId: '', roleId: '', approvalRequired: false }],
  );
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

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

  const change = (index: number, patch: Partial<WorkflowStepDraft>) =>
    setSteps(steps.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const move = (index: number, by: -1 | 1) => {
    const next = [...steps];
    const [step] = next.splice(index, 1);
    if (step === undefined) return;
    next.splice(index + by, 0, step);
    setSteps(next);
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
    steps.every((s) => s.label.trim() !== '' && s.roleId !== '');

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
      className="dept-office__section workflow-editor"
      aria-labelledby={titleId}
      onSubmit={(e) => void submit(e)}
    >
      <h2 id={titleId}>
        <FormattedMessage
          id={editing === undefined ? 'automations.editor.new' : 'automations.editor.version'}
        />
      </h2>
      {choices === undefined ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="automations.loading" />
        </p>
      ) : choices === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="automations.editor.rolesError" />
        </p>
      ) : (
        <>
          <label className="documents__picker">
            <span>
              <FormattedMessage id="automations.editor.name" />
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              required
            />
          </label>
          <p className="customers__meta">
            <FormattedMessage id="automations.editor.hint" />
          </p>
          <ol className="workflow-editor__steps">
            {steps.map((step, i) => (
              <li key={i} className="workflow-editor__step">
                <label className="documents__picker">
                  <span>
                    <FormattedMessage id="automations.editor.stepLabel" values={{ n: i + 1 }} />
                  </span>
                  <input
                    value={step.label}
                    onChange={(e) => change(i, { label: e.target.value })}
                    maxLength={120}
                    required
                  />
                </label>
                <label className="documents__picker">
                  <span>
                    <FormattedMessage id="automations.editor.who" />
                  </span>
                  <select
                    value={step.roleId === '' ? '' : keyOf(step.departmentTypeId, step.roleId)}
                    onChange={(e) => {
                      const c = choices.find((x) => x.key === e.target.value);
                      change(i, {
                        departmentTypeId: c?.departmentTypeId ?? '',
                        roleId: c?.roleId ?? '',
                      });
                    }}
                    required
                  >
                    <option value="">{intl.formatMessage({ id: 'agents.create.choose' })}</option>
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
                    onChange={(e) => change(i, { approvalRequired: e.target.checked })}
                  />
                  <FormattedMessage id="automations.editor.approval" />
                </label>
                <div className="customers__actions">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                    aria-label={intl.formatMessage({ id: 'automations.editor.up' }, { n: i + 1 })}
                  >
                    ↑
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={i === steps.length - 1}
                    onClick={() => move(i, 1)}
                    aria-label={intl.formatMessage({ id: 'automations.editor.down' }, { n: i + 1 })}
                  >
                    ↓
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={steps.length === 1}
                    onClick={() => setSteps(steps.filter((_, j) => j !== i))}
                  >
                    <FormattedMessage id="automations.editor.remove" values={{ n: i + 1 }} />
                  </Button>
                </div>
              </li>
            ))}
          </ol>
          <div className="customers__actions">
            <Button
              type="button"
              variant="secondary"
              disabled={steps.length >= MAX_STEPS}
              onClick={() =>
                setSteps([
                  ...steps,
                  { label: '', departmentTypeId: '', roleId: '', approvalRequired: false },
                ])
              }
            >
              <FormattedMessage id="automations.editor.addStep" />
            </Button>
          </div>
          {error === undefined ? null : (
            <p className="gia-chat__error" role="alert">
              <FormattedMessage id={error} />
            </p>
          )}
          <div className="customers__actions">
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
            <Button type="button" variant="secondary" onClick={onCancel} disabled={sending}>
              <FormattedMessage id="agents.create.cancel" />
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

/** A workflow's steps as the editor writes them, when every step is one it can write. */
export function draftsOf(
  steps: readonly {
    readonly id: string;
    readonly kind: string;
    readonly label: string;
    readonly dependsOn: readonly string[];
    readonly assignee: { readonly departmentTypeId: string; readonly roleId: string } | null;
    readonly approvalRequired: boolean;
  }[],
): readonly WorkflowStepDraft[] | undefined {
  const drafts: WorkflowStepDraft[] = [];
  for (const [i, s] of steps.entries()) {
    // Only one step after another: any other shape would be lost by rewriting it here.
    const before = steps[i - 1];
    const linear =
      before === undefined
        ? s.dependsOn.length === 0
        : s.dependsOn.length === 1 && s.dependsOn[0] === before.id;
    if (s.kind !== 'specialist' || s.assignee === null || !linear) return undefined;
    drafts.push({
      label: s.label,
      departmentTypeId: s.assignee.departmentTypeId,
      roleId: s.assignee.roleId,
      approvalRequired: s.approvalRequired,
    });
  }
  return drafts;
}
