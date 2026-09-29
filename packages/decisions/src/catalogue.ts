import type { Permission } from '@melonoffice/rbac';

/**
 * The Decision Engine's action catalogue (DE-1, ADR-0065): the actions GIA and the agents may
 * prepare for a person, as data in code, like the tools and the skills. An action grants
 * nothing: it names what already decides it (the permission RBAC checks, who carries it out and
 * what it may spend), so every surface answers "can this be offered to this person now, and on
 * what condition?" the same way. No code assumes how many actions exist.
 */

/** Who carries an action out once it is prepared. Never GIA or an agent on its own. */
export type ActionConfirmation =
  /** The person reads what was prepared and confirms it in the app. */
  | 'person_confirms'
  /** It needs an approval bound to the exact operation (ADR-0026) before it runs. */
  | 'approval';

/** Who may prepare an action. */
export type ActionProposer = 'gia' | 'agent';

export interface ActionDefinition {
  readonly id: string;
  readonly version: number;
  /** The permission the person must hold, checked by RBAC for them. */
  readonly permission: Permission;
  readonly confirmation: ActionConfirmation;
  readonly proposers: readonly ActionProposer[];
  /** The most credits carrying it out may spend, once confirmed (0: none). */
  readonly maxCredits: number;
}

const action = (
  id: string,
  fields: Omit<ActionDefinition, 'id' | 'version' | 'proposers'> & {
    readonly proposers?: readonly ActionProposer[];
  },
): ActionDefinition =>
  Object.freeze({
    id,
    version: 1,
    permission: fields.permission,
    confirmation: fields.confirmation,
    proposers: Object.freeze([...(fields.proposers ?? ['gia'])]),
    maxCredits: fields.maxCredits,
  });

/**
 * The actions today. Each was already decided where it lives; the catalogue only brings those
 * decisions together:
 * - a fact about the business, proposed to Company Brain and confirmed by the owner (ADR-0051);
 * - a follow-up, scheduled once the person confirms it (C5, ADR-0058);
 * - a task for one of the agents, assigned once the person confirms it (AE-3, ADR-0064); the
 *   agent's model call spends at most 1 credit (ADR-0063).
 * Tools join as each gets a place in the catalogue, with the approval their risk level needs.
 */
export const ACTION_CATALOGUE: readonly ActionDefinition[] = Object.freeze([
  action('knowledge.propose_fact', {
    permission: 'knowledge.propose',
    confirmation: 'person_confirms',
    maxCredits: 0,
  }),
  action('follow_up.schedule', {
    permission: 'follow_up.manage',
    confirmation: 'person_confirms',
    maxCredits: 0,
  }),
  action('agent_task.assign', {
    permission: 'specialist.task',
    confirmation: 'person_confirms',
    maxCredits: 1,
  }),
  // A discount on an opportunity (ADR-0065): prepared for a person to offer. Nothing carries it
  // out yet, so it is never offered; the policy check still says whether it would need approval.
  action('opportunity.offer_discount', {
    permission: 'opportunity.manage',
    confirmation: 'person_confirms',
    proposers: ['gia', 'agent'],
    maxCredits: 0,
  }),
]);

/** Checks a catalogue once: ids are unique, plain codes, and every field is in range. */
export function checkCatalogue(actions: readonly ActionDefinition[]): readonly ActionDefinition[] {
  const seen = new Set<string>();
  for (const a of actions) {
    if (!/^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(a.id)) throw new Error(`invalid action id ${a.id}`);
    if (seen.has(a.id)) throw new Error(`duplicate action ${a.id}`);
    seen.add(a.id);
    if (!Number.isInteger(a.version) || a.version < 1) throw new Error(`invalid version ${a.id}`);
    if (!Number.isInteger(a.maxCredits) || a.maxCredits < 0) {
      throw new Error(`invalid credits ${a.id}`);
    }
    if (a.proposers.length === 0) throw new Error(`action ${a.id} has no proposer`);
  }
  return actions;
}
