import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Badge, Button, StateMessage } from '@melonoffice/ui';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { OutOfCredits } from '../aiUsage/OutOfCredits.js';
import { navigate } from '../identity/router.js';
import { paths } from '../shell/routes.js';
import {
  AutomationsError,
  stepViewsOf,
  type AutomationsClient,
  type WorkflowDraftStepSummaryView,
  type WorkflowDraftView,
  type WorkflowStepDraft,
  type WorkflowView,
} from './automationsClient.js';
import { refusalExplanation, stepNumberOf, TechnicalDetail } from './explain.js';
import { draftsOf } from './WorkflowEditor.js';

/**
 * A workflow GIA drafts from a person's words (Block 3 F2, ADR-0171), in GIA's chat and on
 * Automations. GIA proposes; the person reviews and saves. Everything the card says about the
 * workflow comes from the steps the server checked as planning would (who, which tool, what it
 * changes, what asks first, how it ends), never from the model's prose; only GIA's question and
 * its "cannot be done" are its own words, and they are shown as hers. Saving stores a draft
 * workflow, which runs nothing until the person activates it and approves its plan.
 */

/** The most a person writes for a draft: the planner's objective limit. */
export const MAX_INTENT = 1_000;

/** The client calls a draft needs: present only for a person who may draft and save. */
export type DraftClient = Required<Pick<AutomationsClient, 'draftWorkflow' | 'saveDraft'>>;

export const draftClientOf = (client: AutomationsClient | undefined): DraftClient | undefined =>
  client?.draftWorkflow === undefined || client.saveDraft === undefined
    ? undefined
    : {
        draftWorkflow: client.draftWorkflow.bind(client),
        saveDraft: client.saveDraft.bind(client),
      };

type Phase =
  | { readonly kind: 'working' }
  | { readonly kind: 'drafted'; readonly draft: WorkflowDraftView }
  | { readonly kind: 'error'; readonly code: string }
  | { readonly kind: 'saving'; readonly draft: Extract<WorkflowDraftView, { status: 'ready' }> }
  | { readonly kind: 'saved'; readonly workflow: WorkflowView }
  | { readonly kind: 'discarded' };

/** Opens a draft in the advanced editor, as a new workflow that starts from its steps. */
export type AdjustDraft = (name: string, steps: readonly WorkflowStepDraft[]) => void;

/**
 * One draft: asks the server for it once on mount, then shows it for review. A question from GIA
 * is answered here, and asks again with the answer added to the person's words.
 */
export function WorkflowDraftCard({
  client,
  intent,
  onAdjust,
  onSaved,
  onOpen,
  onDone,
}: {
  readonly client: DraftClient;
  /** The person's words, as they wrote them. */
  readonly intent: string;
  readonly onAdjust: AdjustDraft;
  readonly onSaved?: ((workflow: WorkflowView) => void) | undefined;
  /**
   * Opens the saved workflow where it can be edited (ADR-0177). Absent: the link goes to
   * Automations with that workflow opened.
   */
  readonly onOpen?: ((workflow: WorkflowView) => void) | undefined;
  /** The card has nothing left to do (discarded): its holder may close it. */
  readonly onDone?: (() => void) | undefined;
}) {
  const intl = useIntl();
  const [words, setWords] = useState(intent);
  const [phase, setPhase] = useState<Phase>({ kind: 'working' });
  const asked = useRef<string | undefined>(undefined);

  const ask = useCallback(
    (text: string) => {
      asked.current = text;
      setWords(text);
      setPhase({ kind: 'working' });
      client.draftWorkflow(text).then(
        (draft) => asked.current === text && setPhase({ kind: 'drafted', draft }),
        (failure: unknown) =>
          asked.current === text &&
          setPhase({
            kind: 'error',
            code: failure instanceof AutomationsError ? failure.code : 'network',
          }),
      );
    },
    [client],
  );

  useEffect(() => {
    // Once per card: a new request is a new card, or an answer to GIA's question.
    if (asked.current === undefined) ask(intent);
  }, [ask, intent]);

  async function save(draft: Extract<WorkflowDraftView, { status: 'ready' }>) {
    setPhase({ kind: 'saving', draft });
    try {
      const workflow = await client.saveDraft(draft.name, draft.steps);
      setPhase({ kind: 'saved', workflow });
      onSaved?.(workflow);
    } catch (failure) {
      setPhase({
        kind: 'error',
        code: failure instanceof AutomationsError ? failure.code : 'network',
      });
    }
  }

  const discard = () => {
    setPhase({ kind: 'discarded' });
    onDone?.();
  };

  return (
    <article
      className="workflow-draft"
      aria-label={intl.formatMessage({ id: 'automations.draft.label' })}
    >
      {phase.kind === 'working' ? (
        <StateMessage kind="loading" inline>
          <FormattedMessage id="automations.draft.working" />
        </StateMessage>
      ) : phase.kind === 'error' ? (
        <DraftError code={phase.code} onRetry={() => ask(words)} onDiscard={discard} />
      ) : phase.kind === 'saved' ? (
        <StateMessage kind="success" inline>
          <FormattedMessage id="automations.draft.saved" values={{ name: phase.workflow.name }} />{' '}
          <a
            className="workflow-draft__go"
            href={paths.automationsWorkflow(phase.workflow.id)}
            onClick={(event) => {
              event.preventDefault();
              if (onOpen === undefined) navigate(paths.automationsWorkflow(phase.workflow.id));
              else onOpen(phase.workflow);
            }}
          >
            <FormattedMessage id="automations.draft.open" />
          </a>
        </StateMessage>
      ) : phase.kind === 'discarded' ? (
        <p className="workflow-draft__note" role="status">
          <FormattedMessage id="automations.draft.discarded" />
        </p>
      ) : (
        <Drafted
          draft={phase.draft}
          saving={phase.kind === 'saving'}
          onSave={(d) => void save(d)}
          onAdjust={onAdjust}
          onDiscard={discard}
          onAnswer={(answer) => ask(joined(words, answer))}
        />
      )}
    </article>
  );
}

/** The person's words with their answer to GIA's question, within the planner's limit. */
const joined = (words: string, answer: string): string =>
  [...`${words}\n${answer.trim()}`].slice(0, MAX_INTENT).join('');

function Drafted({
  draft,
  saving,
  onSave,
  onAdjust,
  onDiscard,
  onAnswer,
}: {
  readonly draft: WorkflowDraftView;
  readonly saving: boolean;
  readonly onSave: (draft: Extract<WorkflowDraftView, { status: 'ready' }>) => void;
  readonly onAdjust: AdjustDraft;
  readonly onDiscard: () => void;
  readonly onAnswer: (answer: string) => void;
}) {
  switch (draft.status) {
    case 'ready':
      return (
        <ReadyDraft
          draft={draft}
          saving={saving}
          onSave={() => onSave(draft)}
          onAdjust={onAdjust}
          onDiscard={onDiscard}
        />
      );
    case 'invalid':
      return <InvalidDraft draft={draft} onAdjust={onAdjust} onDiscard={onDiscard} />;
    case 'needs_clarification':
      return <Question question={draft.question} onAnswer={onAnswer} onDiscard={onDiscard} />;
    case 'not_possible':
      return (
        <StateMessage
          kind="warning"
          inline
          title={<FormattedMessage id="automations.draft.notPossible" />}
          action={<DiscardOnly onDiscard={onDiscard} />}
        >
          <span className="workflow-draft__gia">
            <FormattedMessage id="automations.draft.giaSays" values={{ text: draft.reason }} />
          </span>
        </StateMessage>
      );
    case 'no_agents':
      return (
        <StateMessage
          kind="empty"
          inline
          title={<FormattedMessage id="automations.draft.noAgents" />}
          action={
            <div className="mo-form__actions">
              <Button size="sm" variant="secondary" onClick={() => navigate(paths.agents())}>
                <FormattedMessage id="automations.draft.toAgents" />
              </Button>
              <Button size="sm" variant="ghost" onClick={onDiscard}>
                <FormattedMessage id="automations.draft.discard" />
              </Button>
            </div>
          }
        >
          <FormattedMessage id="automations.draft.noAgentsTodo" />
        </StateMessage>
      );
    case 'failed':
      return <DraftError code={draft.code} onDiscard={onDiscard} />;
  }
}

function DiscardOnly({ onDiscard }: { readonly onDiscard: () => void }) {
  return (
    <div className="mo-form__actions">
      <Button size="sm" variant="ghost" onClick={onDiscard}>
        <FormattedMessage id="automations.draft.discard" />
      </Button>
    </div>
  );
}

/** Why no draft came back, and what the person can do. Codes stay in the technical detail. */
function DraftError({
  code,
  onRetry,
  onDiscard,
}: {
  readonly code: string;
  readonly onRetry?: () => void;
  readonly onDiscard: () => void;
}) {
  const credits = code === 'insufficient_credits';
  const key =
    code === 'permission_denied'
      ? 'automations.draft.error.permission'
      : code === 'invalid_workflow'
        ? 'automations.draft.error.words'
        : code === 'policy_not_found' || code === 'workflow_drafts_not_configured'
          ? 'automations.draft.error.unavailable'
          : 'automations.draft.error.generic';
  return (
    <StateMessage
      kind="error"
      inline
      title={<FormattedMessage id="automations.draft.error.title" />}
      action={
        <>
          <TechnicalDetail codes={[code]} />
          <div className="mo-form__actions">
            {onRetry === undefined || credits || code === 'permission_denied' ? null : (
              <Button size="sm" variant="secondary" onClick={onRetry}>
                <FormattedMessage id="automations.draft.retry" />
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              <FormattedMessage id="automations.draft.discard" />
            </Button>
          </div>
        </>
      }
    >
      {credits ? <OutOfCredits /> : <FormattedMessage id={key} />}
    </StateMessage>
  );
}

function Question({
  question,
  onAnswer,
  onDiscard,
}: {
  readonly question: string;
  readonly onAnswer: (answer: string) => void;
  readonly onDiscard: () => void;
}) {
  const intl = useIntl();
  const id = useId();
  const [answer, setAnswer] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (answer.trim() !== '') onAnswer(answer);
  };
  return (
    <form className="workflow-draft__question" onSubmit={submit}>
      <p className="workflow-draft__title">
        <FormattedMessage id="automations.draft.question" />
      </p>
      <p className="workflow-draft__gia">
        <FormattedMessage id="automations.draft.giaSays" values={{ text: question }} />
      </p>
      <label className="mo-field" htmlFor={id}>
        <span className="mo-field__label">
          <FormattedMessage id="automations.draft.answer" />
        </span>
        <textarea
          id={id}
          className="mo-input"
          value={answer}
          rows={2}
          maxLength={MAX_INTENT}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder={intl.formatMessage({ id: 'automations.draft.answerHint' })}
        />
      </label>
      <div className="mo-form__actions">
        <Button type="submit" size="sm" disabled={answer.trim() === ''}>
          <FormattedMessage id="automations.draft.reply" />
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
          <FormattedMessage id="automations.draft.discard" />
        </Button>
      </div>
    </form>
  );
}

/** The draft's steps as the editor's, or nothing when the editor could not show them as they are. */
const editorStepsOf = (steps: readonly unknown[]) => draftsOf(stepViewsOf(steps));

function AdjustButton({
  name,
  steps,
  onAdjust,
  disabled = false,
}: {
  readonly name: string;
  readonly steps: readonly unknown[];
  readonly onAdjust: AdjustDraft;
  readonly disabled?: boolean;
}) {
  const drafts = editorStepsOf(steps);
  if (drafts === undefined) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      disabled={disabled}
      onClick={() => onAdjust(name, drafts)}
    >
      <FormattedMessage id="automations.draft.adjust" />
    </Button>
  );
}

function InvalidDraft({
  draft,
  onAdjust,
  onDiscard,
}: {
  readonly draft: Extract<WorkflowDraftView, { status: 'invalid' }>;
  readonly onAdjust: AdjustDraft;
  readonly onDiscard: () => void;
}) {
  const { what, todo } = refusalExplanation(draft.problem.reason);
  const n = stepNumberOf(draft.problem.detail);
  const step = n === undefined ? undefined : draft.steps[n - 1];
  return (
    <StateMessage
      kind="warning"
      inline
      title={<FormattedMessage id="automations.draft.invalid" />}
      action={
        <>
          <TechnicalDetail
            codes={[draft.problem.stage, draft.problem.reason, draft.problem.detail]}
          />
          <div className="mo-form__actions">
            <AdjustButton name={draft.name} steps={draft.steps} onAdjust={onAdjust} />
            <Button size="sm" variant="ghost" onClick={onDiscard}>
              <FormattedMessage id="automations.draft.discard" />
            </Button>
          </div>
        </>
      }
    >
      <FormattedMessage id={what} />
      {n === undefined ? null : (
        <>
          {' '}
          {typeof step?.label === 'string' ? (
            <FormattedMessage
              id="automations.draft.invalidStep"
              values={{ n, label: step.label }}
            />
          ) : (
            <FormattedMessage id="automations.refusal.step" values={{ n }} />
          )}
        </>
      )}{' '}
      <FormattedMessage id={todo} /> <FormattedMessage id="automations.draft.invalidNotSaved" />
    </StateMessage>
  );
}

/** A tool's name, from the catalogue's messages; else its id. */
function toolName(intl: ReturnType<typeof useIntl>, id: string): string {
  const key = `approvals.tool.${id}`;
  return intl.messages[key] === undefined ? id : intl.formatMessage({ id: key });
}

/** A role's name: a catalogue role is `<template>_agent`, named like its template; else its id. */
function roleName(intl: ReturnType<typeof useIntl>, roleId: string): string {
  const key = `agents.template.${roleId.replace(/_agent$/, '')}.name`;
  return intl.messages[key] === undefined ? roleId : intl.formatMessage({ id: key });
}

/** A wait as the person says it: whole days, hours or minutes. */
function waitText(intl: ReturnType<typeof useIntl>, seconds: number): string {
  const [unit, size] =
    seconds % 86_400 === 0
      ? (['days', 86_400] as const)
      : seconds % 3_600 === 0
        ? (['hours', 3_600] as const)
        : (['minutes', 60] as const);
  return intl.formatMessage(
    { id: `automations.draft.wait.${unit}` },
    { n: Math.max(1, Math.round(seconds / size)) },
  );
}

function StepLine({
  step,
  n,
}: {
  readonly step: WorkflowDraftStepSummaryView;
  readonly n: number;
}) {
  const intl = useIntl();
  return (
    <li className="workflow-draft__step">
      <span className="automations__name">
        <FormattedMessage id="automations.draft.stepTitle" values={{ n, label: step.label }} />
      </span>
      <span className="automations__meta">
        {step.kind === 'wait' && step.waitSeconds !== undefined ? (
          <FormattedMessage
            id="automations.draft.step.wait"
            values={{ time: waitText(intl, step.waitSeconds) }}
          />
        ) : step.tool !== undefined ? (
          <FormattedMessage
            id={
              step.tool.changesData
                ? 'automations.draft.step.toolChanges'
                : 'automations.draft.step.toolReads'
            }
            values={{
              agent: step.agent?.displayName ?? '',
              tool: toolName(intl, step.tool.id),
            }}
          />
        ) : step.agent !== undefined ? (
          <FormattedMessage
            id="automations.draft.step.agent"
            values={{
              agent: step.agent.displayName,
              role: roleName(intl, step.agent.roleId),
            }}
          />
        ) : (
          <FormattedMessage id="automations.draft.step.check" />
        )}
      </span>
      {step.approvalRequired ? (
        <Badge tone="warning" className="workflow-draft__badge">
          <FormattedMessage id="automations.draft.step.approval" />
        </Badge>
      ) : null}
    </li>
  );
}

function ReadyDraft({
  draft,
  saving,
  onSave,
  onAdjust,
  onDiscard,
}: {
  readonly draft: Extract<WorkflowDraftView, { status: 'ready' }>;
  readonly saving: boolean;
  readonly onSave: () => void;
  readonly onAdjust: AdjustDraft;
  readonly onDiscard: () => void;
}) {
  const intl = useIntl();
  const { summary } = draft;
  const titleId = useId();
  const agents = [
    ...new Map(
      summary.steps.flatMap((s) => (s.agent === undefined ? [] : [[s.agent.id, s.agent]])),
    ).values(),
  ];
  const tools = summary.steps.flatMap((s) => (s.tool === undefined ? [] : [s.tool]));
  const reads = [...new Set(tools.filter((t) => !t.changesData).map((t) => t.id))];
  const changes = [...new Set(tools.filter((t) => t.changesData).map((t) => t.id))];
  const approvals = summary.steps.filter((s) => s.approvalRequired);
  const label = (id: string) => summary.steps.find((s) => s.id === id)?.label ?? id;
  const list = (items: readonly string[]) =>
    new Intl.ListFormat(intl.locale, { type: 'conjunction' }).format(items);

  return (
    <section className="workflow-draft__ready" aria-labelledby={titleId}>
      <header className="workflow-draft__header">
        <p className="workflow-draft__kicker">
          <FormattedMessage id="automations.draft.kicker" />
        </p>
        <h3 id={titleId} className="workflow-draft__title">
          {draft.name}
        </h3>
        <div className="workflow-draft__badges">
          <Badge tone="success">
            <FormattedMessage id="automations.draft.valid" />
          </Badge>
          {summary.approvalRequired ? (
            <Badge tone="warning">
              <FormattedMessage id="automations.draft.asksApproval" />
            </Badge>
          ) : null}
          <Badge tone={summary.changesData ? 'warning' : 'neutral'}>
            <FormattedMessage
              id={summary.changesData ? 'automations.draft.changes' : 'automations.draft.readsOnly'}
            />
          </Badge>
        </div>
      </header>

      <h4 className="workflow-draft__heading">
        <FormattedMessage id="automations.draft.what" />
        {' · '}
        <FormattedMessage
          id="automations.draft.stepCount"
          values={{ count: summary.steps.length }}
        />
      </h4>
      <ol className="workflow-draft__steps">
        {summary.steps.map((s, i) => (
          <StepLine key={s.id} step={s} n={i + 1} />
        ))}
      </ol>

      <dl className="workflow-draft__facts">
        <div>
          <dt>
            <FormattedMessage id="automations.draft.who" />
          </dt>
          <dd>
            {list(
              agents.map((a) =>
                intl.formatMessage(
                  { id: 'automations.draft.agentRole' },
                  { agent: a.displayName, role: roleName(intl, a.roleId) },
                ),
              ),
            )}
          </dd>
        </div>
        <div>
          <dt>
            <FormattedMessage id="automations.draft.data" />
          </dt>
          <dd>
            {reads.length === 0 ? (
              <FormattedMessage id="automations.draft.dataAgents" />
            ) : (
              <FormattedMessage
                id="automations.draft.dataTools"
                values={{ tools: list(reads.map((id) => toolName(intl, id))) }}
              />
            )}
          </dd>
        </div>
        <div>
          <dt>
            <FormattedMessage id="automations.draft.modifies" />
          </dt>
          <dd>
            {changes.length === 0 ? (
              <FormattedMessage id="automations.draft.modifiesNothing" />
            ) : (
              list(changes.map((id) => toolName(intl, id)))
            )}
          </dd>
        </div>
        <div>
          <dt>
            <FormattedMessage id="automations.draft.approvals" />
          </dt>
          <dd>
            {approvals.length === 0 ? (
              <FormattedMessage id="automations.draft.approvalsNone" />
            ) : (
              list(approvals.map((s) => s.label))
            )}
          </dd>
        </div>
        <div>
          <dt>
            <FormattedMessage id="automations.draft.when" />
          </dt>
          <dd>
            <FormattedMessage id="automations.draft.whenManual" />
          </dd>
        </div>
        <div>
          <dt>
            <FormattedMessage id="automations.draft.result" />
          </dt>
          <dd>{list(summary.results.map(label))}</dd>
        </div>
      </dl>

      <p className="workflow-draft__note">
        <FormattedMessage id="automations.draft.saveNote" />
      </p>
      <div className="mo-form__actions workflow-draft__actions">
        <Button size="sm" onClick={onSave} disabled={saving}>
          <FormattedMessage id={saving ? 'automations.editor.saving' : 'automations.draft.save'} />
        </Button>
        <AdjustButton name={draft.name} steps={draft.steps} onAdjust={onAdjust} disabled={saving} />
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={saving}>
          <FormattedMessage id="automations.draft.discard" />
        </Button>
      </div>
    </section>
  );
}

/**
 * Where a person asks GIA for an automation on Automations: their words, then the card. Each
 * request is a new card; the one before is replaced.
 */
export function WorkflowFromWords({
  client,
  onAdjust,
  onSaved,
  onOpen,
  onClose,
}: {
  readonly client: DraftClient;
  readonly onAdjust: AdjustDraft;
  readonly onSaved: (workflow: WorkflowView) => void;
  readonly onOpen?: ((workflow: WorkflowView) => void) | undefined;
  readonly onClose: () => void;
}) {
  const intl = useIntl();
  const id = useId();
  const [text, setText] = useState('');
  const [request, setRequest] = useState<{ readonly key: number; readonly intent: string }>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const intent = text.trim();
    if (intent === '') return;
    setRequest((r) => ({ key: (r?.key ?? 0) + 1, intent }));
  };
  return (
    <section className="mo-panel mo-page-section workflow-draft-panel" aria-labelledby={`${id}-t`}>
      <h2 id={`${id}-t`} className="mo-section-title">
        <FormattedMessage id="automations.draft.panelTitle" />
      </h2>
      <p className="automations__meta">
        <FormattedMessage id="automations.draft.panelHint" />
      </p>
      <form className="workflow-draft__ask" onSubmit={submit}>
        <label className="mo-field" htmlFor={id}>
          <span className="mo-field__label">
            <FormattedMessage id="automations.draft.intent" />
          </span>
          <textarea
            id={id}
            className="mo-input"
            value={text}
            rows={3}
            maxLength={MAX_INTENT}
            onChange={(event) => setText(event.target.value)}
            placeholder={intl.formatMessage({ id: 'automations.draft.intentHint' })}
          />
        </label>
        <div className="mo-form__actions">
          <Button type="submit" disabled={text.trim() === ''}>
            <FormattedMessage id="automations.draft.ask" />
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            <FormattedMessage id="agents.create.cancel" />
          </Button>
        </div>
        <p className="workflow-draft__note">
          <FormattedMessage id="automations.draft.cost" />
        </p>
      </form>
      {request === undefined ? null : (
        <WorkflowDraftCard
          key={request.key}
          client={client}
          intent={request.intent}
          onAdjust={onAdjust}
          onSaved={onSaved}
          onOpen={onOpen}
          onDone={() => setRequest(undefined)}
        />
      )}
    </section>
  );
}

/**
 * A draft opened in the advanced editor from GIA's chat: kept here until Automations opens it,
 * once. It holds the steps only in this tab's memory.
 */
let handedOver: { readonly name: string; readonly steps: readonly WorkflowStepDraft[] } | undefined;

export function handOverDraft(name: string, steps: readonly WorkflowStepDraft[]): void {
  handedOver = { name, steps };
  navigate(paths.automations());
}

export function takeHandedOverDraft():
  { readonly name: string; readonly steps: readonly WorkflowStepDraft[] } | undefined {
  const draft = handedOver;
  handedOver = undefined;
  return draft;
}
