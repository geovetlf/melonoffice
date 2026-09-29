import type { KnowledgeView } from '@melonoffice/brain';
import type { ActionProposer } from '../catalogue.js';
import type { Decider, DeciderContext } from '../engine.js';
import { DecisionError, ruleRef, type DecisionEvidence, type DecisionReason } from '../model.js';

/**
 * May this action go ahead, and does it need approval? (`action.policy_check`, ADR-0065). It
 * checks the action against the catalogue for the person (their permission, whether it is set up
 * here) and against the company's own policies in Company Brain: read only, the `policies`
 * domain, only the keys a rule knows. A policy nobody confirmed, or one another source disagrees
 * with and nobody settled, is not trusted: the decision then asks for approval and says why. Nothing is run; an approval here is a requirement stated, which
 * the person or the tool gate (ADR-0026) acts on.
 */

export const POLICY_RULES = Object.freeze({
  availability: { id: 'policy.action_available', version: 1 },
  discount: { id: 'policy.discount_limit', version: 1 },
});

/**
 * The company policies a rule reads, by their Company Brain key (domain `policies`), and what
 * kind of value each must hold. A policy with another key or type is not read.
 */
export const POLICY_KEYS = Object.freeze({
  discountApprovalAbovePercent: 'discount_approval_above_percent',
});

interface Input {
  readonly action: string;
  readonly discountPercent: number | undefined;
  /** Who would prepare it: GIA (default) or an agent. */
  readonly proposer: ActionProposer;
}

const ACTION = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;

function parse(raw: unknown): Input {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DecisionError('invalid_input');
  }
  const { action, discountPercent, proposer = 'gia' } = raw as Record<string, unknown>;
  if (proposer !== 'gia' && proposer !== 'agent') {
    throw new DecisionError('invalid_input', 'proposer');
  }
  if (typeof action !== 'string' || !ACTION.test(action)) {
    throw new DecisionError('invalid_input', 'action');
  }
  if (
    discountPercent !== undefined &&
    (typeof discountPercent !== 'number' ||
      !Number.isFinite(discountPercent) ||
      discountPercent < 0 ||
      discountPercent > 100)
  ) {
    throw new DecisionError('invalid_input', 'discountPercent');
  }
  return { action, discountPercent: discountPercent as number | undefined, proposer };
}

const reason = (
  rule: { readonly id: string; readonly version: number },
  code: string,
  params: Record<string, string | number> = {},
): DecisionReason => Object.freeze({ code, rule: ruleRef(rule), params: Object.freeze(params) });

/** The company's discount limit, when Company Brain holds one as a number in force. */
function discountPolicy(items: readonly KnowledgeView[]): KnowledgeView | undefined {
  return items.find(
    (i) =>
      i.domain === 'policies' &&
      i.key === POLICY_KEYS.discountApprovalAbovePercent &&
      i.status === 'active' &&
      i.value.type === 'number',
  );
}

export const policyCheckDecider = Object.freeze<Decider<Input>>({
  type: 'action.policy_check',
  version: 1,
  category: 'policy_check',
  permissions: ['decision.evaluate'],
  requires: [],
  usesAI: false,
  parse,
  async decide(context: DeciderContext, input: Input) {
    const { tenant, ports } = context;
    const rules = [ruleRef(POLICY_RULES.availability)];
    const reasons: DecisionReason[] = [];
    const evidence: DecisionEvidence[] = [];
    const warnings: string[] = [];
    const constraints: string[] = [];
    const sources = ['action_catalogue'];
    const withheld: string[] = [];

    const action = context.actions.evaluateAction(tenant, input.action, input.proposer);
    evidence.push({
      source: 'action_catalogue',
      ref: { type: 'action', id: input.action },
      fact: 'outcome',
      value: action.outcome,
    });
    // Not being set up here does not change what the rules say; anything else does.
    const blocking = action.reasons.filter((r) => r !== 'not_configured');
    if (action.reasons.includes('not_configured')) constraints.push('not_carried_out_here');
    if (blocking.length > 0) {
      return {
        outcome: 'not_allowed',
        priority: null,
        reasons: blocking.map((r) => reason(POLICY_RULES.availability, r)),
        evidence,
        requiredApproval: false,
        recommendedAction: null,
        constraints,
        warnings,
        rules,
        sourceContext: { sources, withheld },
      };
    }
    let requiredApproval = action.outcome === 'needs_approval';
    if (requiredApproval) reasons.push(reason(POLICY_RULES.availability, 'action_needs_approval'));

    if (input.discountPercent !== undefined) {
      rules.push(ruleRef(POLICY_RULES.discount));
      evidence.push({
        source: 'request',
        ref: null,
        fact: 'discount_percent',
        value: input.discountPercent,
      });
      let policies: readonly KnowledgeView[] | undefined;
      if (ports.brain !== undefined) {
        try {
          policies = await ports.brain.list(tenant, { domain: 'policies' });
          sources.push('company_brain.policies');
        } catch {
          // The person may not read the company's policies, or they could not be read now.
          withheld.push('company_brain.policies');
        }
      }
      const policy = policies === undefined ? undefined : discountPolicy(policies);
      if (policy === undefined || policy.value.type !== 'number') {
        // No limit known: nothing to compare with, and the decision says so rather than guess.
        warnings.push(policies === undefined ? 'policies_unavailable' : 'no_company_policy');
        reasons.push(reason(POLICY_RULES.discount, 'no_discount_policy'));
      } else {
        const limit = policy.value.number;
        const ref = { type: 'knowledge_item', id: policy.id };
        evidence.push(
          {
            source: 'company_brain',
            ref,
            fact: POLICY_KEYS.discountApprovalAbovePercent,
            value: limit,
          },
          { source: 'company_brain', ref, fact: 'verification', value: policy.verification },
        );
        // A source that disagrees with it and nobody settled yet: not trusted either.
        const inConflict = policy.openConflictId !== undefined;
        if (inConflict) {
          evidence.push({ source: 'company_brain', ref, fact: 'open_conflict', value: true });
        }
        const confirmed =
          policy.verification === 'confirmed' && !policy.needsConfirmation && !inConflict;
        if (input.discountPercent > limit) {
          requiredApproval = true;
          reasons.push(
            reason(POLICY_RULES.discount, 'discount_above_policy', {
              discountPercent: input.discountPercent,
              limitPercent: limit,
            }),
          );
        } else if (!confirmed) {
          // A limit nobody confirmed is not trusted to allow anything.
          requiredApproval = true;
          reasons.push(
            reason(
              POLICY_RULES.discount,
              inConflict ? 'policy_in_conflict' : 'policy_not_confirmed',
              { limitPercent: limit },
            ),
          );
        } else {
          reasons.push(
            reason(POLICY_RULES.discount, 'discount_within_policy', {
              discountPercent: input.discountPercent,
              limitPercent: limit,
            }),
          );
        }
        if (inConflict) warnings.push('policy_in_conflict');
        else if (!confirmed) warnings.push('policy_not_confirmed');
      }
    }
    return {
      outcome: requiredApproval ? 'approval_required' : 'allowed',
      priority: null,
      reasons,
      evidence,
      requiredApproval,
      recommendedAction: requiredApproval
        ? { code: 'ask_owner_approval', action: null, link: null }
        : { code: 'prepare_action', action: input.action, link: null },
      constraints,
      warnings,
      rules,
      sourceContext: { sources, withheld },
    };
  },
});
