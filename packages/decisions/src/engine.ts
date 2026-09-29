import { actorOf, type AuditService } from '@melonoffice/audit';
import type { AuthorizationService, Permission } from '@melonoffice/rbac';
import { createSkillCatalogue, type SkillCatalogue } from '@melonoffice/specialists';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { randomUUID } from 'node:crypto';
import {
  ACTION_CATALOGUE,
  checkCatalogue,
  type ActionConfirmation,
  type ActionDefinition,
  type ActionProposer,
} from './catalogue.js';
import {
  DecisionError,
  isDecisionError,
  type DecisionCategory,
  type DecisionDraft,
  type DecisionResult,
} from './model.js';
import type { DecisionPorts, DecisionPreload } from './ports.js';

/**
 * The Decision Engine (ADR-0065): MelonMotor's one place that decides. It answers two questions,
 * both deterministic and explained, and runs nothing:
 *
 * - **Which actions may be prepared for this person, and on what condition?** The action
 *   catalogue composed with RBAC for the person and whether the engine that carries each out is
 *   set up here.
 * - **What should happen, and why?** A decision type (a decider) reads only the context it needs,
 *   through the existing services and as the person (tenant isolation, their permissions and
 *   their department's reach), applies its rules and returns a `DecisionResult`. Rules come
 *   first; a decider that needs a model calls the AI Gateway, never a provider. Every decision is
 *   audited on the existing trail, with its rules and outcome, never its content.
 */

export type ActionOutcome =
  /** It may be prepared; the person confirms it. */
  | 'available'
  /** It may be prepared; it runs only once approved (ADR-0026). */
  | 'needs_approval'
  /** It is not offered, for the reasons given. */
  | 'unavailable';

/** Why an action is not offered, as closed codes a screen can explain. */
export type ActionReason =
  | 'unknown_action'
  | 'unresolved_tenant'
  /**
   * Who is asking cannot prepare it: GIA prepares for a person asking directly; an agent
   * prepares as the runtime acting for the person who assigned its task (ADR-0029), or for that
   * person. GIA's own actor never prepares anything.
   */
  | 'requires_user'
  | 'permission_denied'
  /** The engine that carries it out is not set up in this environment. */
  | 'not_configured'
  | 'proposer_not_allowed'
  /**
   * An agent proposes only what one of its skills grants (SK-2, ADR-0083). Asked for a named
   * agent: none of its skills, at their exact versions, grants the action. Asked for agents in
   * general: no skill of the catalogue grants it, so no agent can propose it.
   */
  | 'not_granted_by_skill';

/**
 * The agent an action is evaluated for (SK-2, ADR-0083): the actions its skills grant, worked
 * out by the caller from the agent's current version (`grantsOf`). Never taken from a request
 * or a model.
 */
export interface AgentActionGrants {
  readonly actions: ReadonlySet<string>;
}

export interface ActionDecision {
  readonly action: string;
  readonly outcome: ActionOutcome;
  readonly confirmation: ActionConfirmation | null;
  readonly maxCredits: number | null;
  readonly reasons: readonly ActionReason[];
}

/** What a decider is given: the person, the ports, the clock and the actions. */
export interface DeciderContext {
  readonly tenant: TenantContext;
  readonly ports: DecisionPorts;
  readonly preload: DecisionPreload;
  readonly now: Date;
  readonly requestId: string;
  readonly actions: Pick<DecisionEngine, 'evaluateAction'>;
}

/**
 * One decision type. It names what it needs (the person's permissions, the ports it reads), how
 * to check its input, and its rules. Deciders are data in code like the actions: no code assumes
 * how many exist.
 */
export interface Decider<Input = unknown> {
  readonly type: string;
  readonly version: number;
  readonly category: DecisionCategory;
  /** The person must hold every one: a decision never reads what the person may not read. */
  readonly permissions: readonly Permission[];
  /** The ports it cannot decide without; a missing one is `not_configured`. */
  readonly requires: readonly (keyof DecisionPorts)[];
  /** Whether it may call a model (through the AI Gateway, spending credits). */
  readonly usesAI: boolean;
  parse(raw: unknown): Input;
  decide(context: DeciderContext, input: Input): Promise<DecisionDraft>;
}

export interface DecisionRequest {
  readonly type: string;
  readonly input?: unknown;
  /**
   * Context the caller already read as this same person (GIA's commercial insights), so it is
   * not read twice. Server code only: no route accepts it.
   */
  readonly preload?: DecisionPreload;
  readonly requestId?: string;
}

export interface DecisionTypeView {
  readonly type: string;
  readonly version: number;
  readonly category: DecisionCategory;
  readonly usesAI: boolean;
  readonly available: boolean;
}

export interface DecisionEngine {
  /**
   * One action, for this person, as `proposer` would prepare it (GIA by default). For an agent,
   * `agent` names the one proposing; without it the answer is for agents in general.
   */
  evaluateAction(
    tenant: TenantContext,
    action: string,
    proposer?: ActionProposer,
    agent?: AgentActionGrants,
  ): ActionDecision;
  /** Every action of the catalogue, in its order, for this person. */
  listActions(
    tenant: TenantContext,
    proposer?: ActionProposer,
    agent?: AgentActionGrants,
  ): readonly ActionDecision[];
  /** Whether it may be prepared at all: `available` or `needs_approval`. */
  offers(
    tenant: TenantContext,
    action: string,
    proposer?: ActionProposer,
    agent?: AgentActionGrants,
  ): boolean;
  /** Decides, explains and audits. Never runs anything. */
  evaluateDecision(tenant: TenantContext, request: DecisionRequest): Promise<DecisionResult>;
  /** The decision types, and whether this person may ask each one here. */
  listDecisionTypes(tenant: TenantContext): readonly DecisionTypeView[];
}

export interface DecisionEngineOptions {
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /**
   * Whether the engine that carries an action out is set up here (for example, agent tasks need
   * their storage and runtime). Absent: every action is.
   */
  readonly configured?: (action: string) => boolean;
  readonly catalogue?: readonly ActionDefinition[];
  /**
   * The skills that grant actions to agents (SK-1/SK-2, ADR-0069/0083). Absent: the catalogue in
   * code.
   */
  readonly skills?: SkillCatalogue;
  readonly deciders?: readonly Decider<unknown>[];
  readonly ports?: DecisionPorts;
  /** The existing audit trail. Absent (tests of the actions only): decisions are not recorded. */
  readonly audit?: AuditService;
  readonly now?: () => Date;
}

const GIA_ACTORS: readonly TenantContext['actor'][] = ['user'];
const AGENT_ACTORS: readonly TenantContext['actor'][] = ['user', 'runtime'];
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_AUDIT_RULES = 12;

export function createDecisionEngine(options: DecisionEngineOptions): DecisionEngine {
  const { authorization, configured = () => true, audit, now = () => new Date() } = options;
  const ports = options.ports ?? {};
  const catalogue = checkCatalogue(options.catalogue ?? ACTION_CATALOGUE);
  const byId = new Map(catalogue.map((a) => [a.id, a]));
  // Every action some skill of the catalogue grants: what agents in general may propose.
  const grantedToAgents = new Set(
    (options.skills ?? createSkillCatalogue()).list().flatMap((skill) => skill.actions),
  );
  const deciders = new Map<string, Decider<unknown>>();
  for (const decider of options.deciders ?? []) {
    if (deciders.has(decider.type)) throw new Error(`duplicate decider ${decider.type}`);
    deciders.set(decider.type, decider);
  }
  const can = (tenant: TenantContext, permission: string) =>
    authorization.authorize(tenant, permission).allowed;

  function evaluateAction(
    tenant: TenantContext,
    id: string,
    proposer: ActionProposer = 'gia',
    agent?: AgentActionGrants,
  ): ActionDecision {
    const definition = byId.get(id);
    if (definition === undefined) {
      return Object.freeze({
        action: id,
        outcome: 'unavailable',
        confirmation: null,
        maxCredits: null,
        reasons: Object.freeze(['unknown_action' as const]),
      });
    }
    const reasons: ActionReason[] = [];
    if (!isResolvedTenant(tenant)) reasons.push('unresolved_tenant');
    else {
      const actors = proposer === 'agent' ? AGENT_ACTORS : GIA_ACTORS;
      if (!actors.includes(tenant.actor)) reasons.push('requires_user');
      if (!can(tenant, definition.permission)) reasons.push('permission_denied');
    }
    if (!definition.proposers.includes(proposer)) reasons.push('proposer_not_allowed');
    if (proposer === 'agent' && !(agent?.actions ?? grantedToAgents).has(id)) {
      reasons.push('not_granted_by_skill');
    }
    if (!configured(id)) reasons.push('not_configured');
    return Object.freeze({
      action: id,
      outcome:
        reasons.length > 0
          ? 'unavailable'
          : definition.confirmation === 'approval'
            ? 'needs_approval'
            : 'available',
      confirmation: definition.confirmation,
      maxCredits: definition.maxCredits,
      reasons: Object.freeze(reasons),
    });
  }

  const isSetUp = (decider: Decider<unknown>) =>
    decider.requires.every((p) => ports[p] !== undefined);
  const mayAsk = (tenant: TenantContext, decider: Decider<unknown>) =>
    decider.permissions.every((p) => can(tenant, p));

  const engine: DecisionEngine = Object.freeze({
    evaluateAction,
    listActions: (tenant: TenantContext, proposer?: ActionProposer, agent?: AgentActionGrants) =>
      Object.freeze(catalogue.map((a) => evaluateAction(tenant, a.id, proposer, agent))),
    offers: (
      tenant: TenantContext,
      id: string,
      proposer?: ActionProposer,
      agent?: AgentActionGrants,
    ) => evaluateAction(tenant, id, proposer, agent).outcome !== 'unavailable',

    listDecisionTypes(tenant: TenantContext) {
      return Object.freeze(
        [...deciders.values()].map((d) =>
          Object.freeze({
            type: d.type,
            version: d.version,
            category: d.category,
            usesAI: d.usesAI,
            available: isResolvedTenant(tenant) && isSetUp(d) && mayAsk(tenant, d),
          }),
        ),
      );
    },

    async evaluateDecision(tenant: TenantContext, request: DecisionRequest) {
      if (!isResolvedTenant(tenant)) throw new DecisionError('unresolved_tenant');
      const decider = deciders.get(request.type);
      if (decider === undefined) throw new DecisionError('unknown_decision_type');
      const requestId =
        request.requestId !== undefined && REQUEST_ID.test(request.requestId)
          ? request.requestId
          : randomUUID().replace(/-/g, '');
      const id = `dec_${randomUUID().replace(/-/g, '')}`;
      const record = async (
        result: 'success' | 'denied' | 'failure',
        fields: { readonly reason: string; readonly rules?: readonly string[] },
      ) =>
        audit?.record({
          action: 'decision.evaluated',
          result,
          actor: actorOf(tenant),
          organizationId: tenant.organizationId,
          target: { type: 'decision', id },
          reason: fields.reason,
          decision: {
            type: decider.type,
            version: decider.version,
            rules: (fields.rules ?? []).slice(0, MAX_AUDIT_RULES),
          },
          requestId,
          source: 'api',
        });

      if (!mayAsk(tenant, decider)) {
        await record('denied', { reason: 'permission_denied' });
        throw new DecisionError('permission_denied');
      }
      if (!isSetUp(decider)) {
        await record('denied', { reason: 'not_configured' });
        throw new DecisionError('not_configured');
      }
      const input = decider.parse(request.input);
      let draft: DecisionDraft;
      try {
        draft = await decider.decide(
          {
            tenant,
            ports,
            preload: request.preload ?? {},
            now: now(),
            requestId,
            actions: engine,
          },
          input,
        );
      } catch (error) {
        await record('failure', { reason: isDecisionError(error) ? error.code : 'decider_failed' });
        throw error;
      }
      const result: DecisionResult = Object.freeze({
        id,
        type: decider.type,
        version: decider.version,
        category: decider.category,
        outcome: draft.outcome,
        priority: draft.priority,
        reasons: Object.freeze([...draft.reasons]),
        evidence: Object.freeze([...draft.evidence]),
        items: Object.freeze([...(draft.items ?? [])]),
        requiredApproval: draft.requiredApproval,
        recommendedAction: draft.recommendedAction,
        constraints: Object.freeze([...(draft.constraints ?? [])]),
        warnings: Object.freeze([...draft.warnings]),
        rules: Object.freeze([...new Set(draft.rules)]),
        sourceContext: Object.freeze({
          sources: Object.freeze([...draft.sourceContext.sources]),
          withheld: Object.freeze([...draft.sourceContext.withheld]),
        }),
        model: draft.model ?? null,
        createdAt: now().toISOString(),
      });
      await record('success', { reason: result.outcome, rules: result.rules });
      return result;
    },
  });
  return engine;
}
