import type { AuditStore } from '@melonoffice/audit';
import { createAuditService } from '@melonoffice/audit';
import { createCompanyBrain, type KnowledgeRepository } from '@melonoffice/brain';
import { createDecisionEngine, DECIDERS, planConditionEvaluator } from '@melonoffice/decisions';
import type { Logger } from '@melonoffice/observability';
import type { ConditionEvaluator } from '@melonoffice/planning';
import { createAuthorizationService } from '@melonoffice/rbac';
import type { TenancyStore } from '@melonoffice/tenancy';

/**
 * The decision types a plan's condition may name in the worker (WF-4, ADR-0075): the ones whose
 * data the worker reads here and that never call a model, so a condition spends no credits. Any
 * other type is `condition_unknown_decision_type` and the plan stops, never decided on missing
 * data. More join as their ports reach the worker.
 */
export const CONDITION_DECISION_TYPES: readonly string[] = Object.freeze(['action.policy_check']);

export interface PlanConditionStores {
  readonly tenancy: TenancyStore;
  readonly knowledge: KnowledgeRepository;
  readonly audit: AuditStore;
}

/**
 * The worker's condition evaluator: the same Decision Engine the API uses (ADR-0065), with the
 * deciders above and Company Brain read only, deciding as the runtime of the person the plan
 * runs for. It carries out no action: `configured` is false for all of them, which the policy
 * check reports as a constraint, never as a different answer.
 */
export function createPlanConditions(options: {
  readonly stores: PlanConditionStores;
  readonly logger?: Logger;
  readonly now?: () => Date;
}): ConditionEvaluator {
  const { stores, logger, now } = options;
  const authorization = createAuthorizationService();
  const brain = createCompanyBrain({
    repository: stores.knowledge,
    organizations: stores.tenancy,
    authorization,
    ...(now === undefined ? {} : { now }),
    ...(logger === undefined ? {} : { logger }),
  });
  const engine = createDecisionEngine({
    authorization,
    configured: () => false,
    deciders: DECIDERS.filter((d) => CONDITION_DECISION_TYPES.includes(d.type) && !d.usesAI),
    ports: { brain },
    audit: createAuditService(stores.audit, now),
    ...(now === undefined ? {} : { now }),
  });
  return planConditionEvaluator(engine);
}
