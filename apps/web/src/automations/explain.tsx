import { FormattedMessage } from '@melonoffice/i18n';

/**
 * What the screen says when the engine refuses or a step fails (ADR-0167): what happened and what
 * the person can do, in their words. The engine's code stays available, folded away as the
 * technical detail; the trace, logs and audit keep it whole.
 */

/** What happened and what to do, as message keys. */
export interface Explanation {
  readonly what: string;
  readonly todo: string;
}

/** Plan validation refusals (`plan_refused`), grouped by what the person can do about them. */
const REFUSAL_GROUPS: Readonly<Record<string, string>> = {
  tool_not_assigned: 'tool_not_assigned',
  specialist_not_eligible: 'no_agent',
  assignee_unavailable: 'no_agent',
  permission_not_held: 'permission',
  department_not_allowed: 'department',
  plan_denied_by_policy: 'policy',
  tool_denied_by_policy: 'tool_unusable',
  tool_not_active: 'tool_unusable',
  tool_not_found: 'tool_unusable',
  tool_not_runtime_invocable: 'tool_unusable',
  tool_not_read_only: 'tool_unusable',
  environment_not_allowed: 'tool_unusable',
  department_mismatch: 'tool_department',
  invalid_tool_input: 'tool_input',
  invalid_tool_input_ref: 'tool_input',
  invalid_input_ref: 'tool_input',
  tool_input_from_model: 'tool_input',
  input_ref_needs_fixed_input: 'tool_input',
  invalid_dependency: 'structure',
  invalid_tool_dependency: 'structure',
  invalid_performer: 'structure',
  duplicate_step: 'structure',
  invalid_condition: 'structure',
  invalid_proposal: 'structure',
  verification_missing: 'structure',
};

/** Why a plan could not be prepared from a workflow. */
export function refusalExplanation(reason: string): Explanation {
  const group = REFUSAL_GROUPS[reason] ?? 'other';
  return {
    what: `automations.refusal.${group}.what`,
    todo: `automations.refusal.${group}.todo`,
  };
}

/** Failure codes of a step's work, grouped by what the person can do about them. */
const FAILURE_GROUPS: Readonly<Record<string, string>> = {
  tool_not_granted_by_skill: 'tool_not_granted',
  tool_not_assigned: 'tool_not_granted',
  tool_failure: 'tool',
  tool_failed: 'tool',
  tool_not_active: 'tool',
  tool_denied_by_policy: 'tool',
  tool_not_runtime_invocable: 'tool',
  tool_not_runtime_invokable: 'tool',
  environment_not_allowed: 'tool',
  agent_paused: 'agent',
  agent_disabled: 'agent',
  agent_not_active: 'agent',
  agent_not_configured: 'agent',
  specialist_not_eligible: 'agent',
  specialist_not_found: 'agent',
  no_agent: 'agent',
  no_specialist: 'agent',
  permission_denied: 'permission',
  permission_not_held: 'permission',
  tool_not_permitted: 'permission',
  insufficient_credits: 'credits',
  credits_not_configured: 'credits',
  timeout: 'time',
  task_time_limit_reached: 'time',
  input_unavailable: 'input',
  approval_rejected: 'rejected',
  invalid_response: 'answer',
  invalid_json: 'answer',
  output_rejected: 'answer',
  output_unavailable: 'answer',
  verification_failed: 'answer',
  agent_guardian: 'answer',
  ai_review: 'answer',
  figure_contradiction: 'answer',
  secret_disclosed: 'answer',
  instructions_contradict_company_brain: 'answer',
  provider_rejected: 'service',
  unavailable: 'service',
  down: 'service',
  executor_error: 'service',
  connection_reset: 'service',
  cancelled: 'cancelled',
  execution_cancelled: 'cancelled',
};

/** Why a step's work failed. A code no group names is said plainly as "something went wrong". */
export function failureExplanation(code: string | null | undefined): Explanation {
  const group =
    code == null
      ? 'other'
      : (FAILURE_GROUPS[code] ?? (code.startsWith('model_') ? 'service' : 'other'));
  return {
    what: `automations.failure.${group}.what`,
    todo: `automations.failure.${group}.todo`,
  };
}

/** The step a validation detail names (`steps.<i>…`), counted from 1 as the screen counts them. */
export function stepNumberOf(detail: string | undefined): number | undefined {
  const match = /^steps\.(\d+)(?:\.|$)/.exec(detail ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]) + 1;
}

/** The engine's own codes, folded away: for support, never the message itself. */
export function TechnicalDetail({ codes }: { readonly codes: readonly (string | undefined)[] }) {
  const shown = codes.filter((c): c is string => c !== undefined && c !== '');
  if (shown.length === 0) return null;
  return (
    <details className="automations__technical">
      <summary>
        <FormattedMessage id="automations.technical" />
      </summary>
      <code>{shown.join(' · ')}</code>
    </details>
  );
}
