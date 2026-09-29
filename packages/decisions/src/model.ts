/**
 * What a decision is (ADR-0065). A decision says what should happen and why; it never makes it
 * happen. Its result is data a surface shows (GIA, an agent, a workflow, a screen), with the
 * rules that produced it and the records they read, so every decision can answer: what was
 * decided, why, from which data, under which rule or policy, whether it needs approval, and what
 * would happen next.
 */

/**
 * The kinds of decision MelonMotor knows. A decision type (a decider) belongs to one of them;
 * more deciders join a kind without changing this list.
 */
export type DecisionCategory =
  | 'recommendation'
  | 'routing'
  | 'priority'
  | 'approval_required'
  | 'next_action'
  | 'eligibility'
  | 'policy_check'
  | 'workflow_decision'
  | 'agent_decision';

export type DecisionPriority = 'high' | 'medium' | 'low';

/** Why: a closed code, the rule that gave it (`id@version`) and the values it compared. */
export interface DecisionReason {
  readonly code: string;
  readonly rule: string;
  readonly params: Readonly<Record<string, string | number>>;
}

/** The data a reason rests on: which record, which fact of it, and its value. */
export interface DecisionEvidence {
  readonly source:
    | 'follow_up'
    | 'opportunity'
    | 'contact'
    | 'conversation'
    | 'company_brain'
    | 'forecast'
    | 'action_catalogue'
    | 'agent'
    | 'request';
  /** The record, when there is one: its kind and id, as the app links to it. */
  readonly ref: { readonly type: string; readonly id: string } | null;
  readonly fact: string;
  readonly value: string | number | boolean | null;
}

/**
 * What should happen next, for a person to do or confirm. `action` is an action of the catalogue
 * when GIA or an agent may prepare it (the person still confirms); null when the person does it
 * in the app themselves. Nothing here runs.
 */
export interface RecommendedAction {
  readonly code: string;
  readonly action: string | null;
  /** Where the person does it or sees the record. */
  readonly link: { readonly type: string; readonly id: string } | null;
}

/** One thing a decision about several records says, for example one item to attend to. */
export interface DecisionItem {
  readonly outcome: string;
  readonly priority: DecisionPriority | null;
  readonly subject: { readonly type: string; readonly id: string; readonly label: string | null };
  readonly reasons: readonly DecisionReason[];
  readonly evidence: readonly DecisionEvidence[];
  readonly requiredApproval: boolean;
  readonly recommendedAction: RecommendedAction | null;
}

export interface DecisionResult {
  /** `dec_` and 32 hex characters, one per evaluation; the audit event carries it. */
  readonly id: string;
  /** The decider, e.g. `commercial.priorities`, and its version. */
  readonly type: string;
  readonly version: number;
  readonly category: DecisionCategory;
  /** A closed code of the decider, e.g. `attention_needed`, `approval_required`. */
  readonly outcome: string;
  readonly priority: DecisionPriority | null;
  readonly reasons: readonly DecisionReason[];
  readonly evidence: readonly DecisionEvidence[];
  /** For a decision about several records: each one, most pressing first. */
  readonly items: readonly DecisionItem[];
  readonly requiredApproval: boolean;
  readonly recommendedAction: RecommendedAction | null;
  /** Limits the decision was made under, as codes (e.g. `lists_partial`). */
  readonly constraints: readonly string[];
  /** What the person should know about it, as codes (e.g. `policy_not_confirmed`). */
  readonly warnings: readonly string[];
  /** Every rule that was applied, `id@version`. */
  readonly rules: readonly string[];
  /** What was read (`commercial`, `company_brain.policies`…) and what the person may not read. */
  readonly sourceContext: {
    readonly sources: readonly string[];
    readonly withheld: readonly string[];
  };
  /** The model, when the decision used one, through the AI Gateway. Absent: rules only. */
  readonly model: { readonly provider: string; readonly id: string } | null;
  /**
   * There is deliberately no confidence field: no decider has a real measure of one, and a
   * made-up figure would mislead. A decider that gets one adds it with its meaning.
   */
  readonly createdAt: string;
}

/** A decider's answer, before the engine gives it its id, time and version. */
export type DecisionDraft = Omit<
  DecisionResult,
  'id' | 'type' | 'version' | 'category' | 'createdAt' | 'items' | 'model' | 'constraints'
> & {
  readonly items?: readonly DecisionItem[];
  readonly constraints?: readonly string[];
  readonly model?: DecisionResult['model'];
};

export type DecisionErrorCode =
  | 'unresolved_tenant'
  | 'unknown_decision_type'
  | 'invalid_input'
  | 'permission_denied'
  | 'not_configured';

export class DecisionError extends Error {
  override readonly name = 'DecisionError';
  constructor(
    readonly code: DecisionErrorCode,
    readonly field?: string,
  ) {
    super(field === undefined ? code : `${code}: ${field}`);
  }
}

export const isDecisionError = (error: unknown): error is DecisionError =>
  error instanceof DecisionError;

/** A rule's reference as results and the audit carry it. */
export const ruleRef = (rule: { readonly id: string; readonly version: number }) =>
  `${rule.id}@${String(rule.version)}`;

const PRIORITY_ORDER: readonly DecisionPriority[] = ['high', 'medium', 'low'];

/** The most pressing of several priorities, or null when there is none. */
export function highest(priorities: readonly (DecisionPriority | null)[]): DecisionPriority | null {
  const ranks = priorities
    .filter((p): p is DecisionPriority => p !== null)
    .map((p) => PRIORITY_ORDER.indexOf(p));
  return ranks.length === 0 ? null : (PRIORITY_ORDER[Math.min(...ranks)] ?? null);
}

export const priorityRank = (p: DecisionPriority | null) =>
  p === null ? PRIORITY_ORDER.length : PRIORITY_ORDER.indexOf(p);
