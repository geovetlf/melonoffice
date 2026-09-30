import type {
  MessageKey,
  SkillDefinition,
  SkillId,
  SkillToolGrant,
  ToolId,
} from '@melonoffice/domain';
import type { Permission } from '@melonoffice/rbac';

/**
 * Skills (ADR-0062, SK-1 ADR-0069): what an agent knows how to do, as catalogue data like the
 * tools and the departments. A skill is the only way an agent gets a tool or a Decision Engine
 * action: an agent's tools must each be granted by one of its skills, at that exact version
 * (Department → Specialist → Role → Skills → Tools, D-28/D-29). A skill grants no authority by
 * itself: the tool gate still decides every call, and the person the agent acts for must hold
 * the records' permissions (`reads`). No code assumes how many skills exist.
 */
export interface AgentSkill extends SkillDefinition {
  readonly descriptionKey: MessageKey;
  /** The RBAC permissions that read the records this skill works from. */
  readonly reads: readonly Permission[];
  /**
   * The department types whose agents may have this skill (ADR-0104). Absent: any department.
   * A skill that names some grants nothing to an agent of another department.
   */
  readonly departments?: readonly string[];
}

const skill = (
  id: string,
  options: {
    readonly tools?: Readonly<Record<string, readonly number[]>>;
    readonly actions?: readonly string[];
    readonly reads: readonly Permission[];
    readonly version?: number;
    readonly departments?: readonly string[];
  },
): AgentSkill =>
  Object.freeze({
    ...(options.departments === undefined
      ? {}
      : { departments: Object.freeze([...options.departments]) }),
    id: id as SkillId,
    version: options.version ?? 1,
    nameKey: `agents.skill.${id}.name` as MessageKey,
    descriptionKey: `agents.skill.${id}.description` as MessageKey,
    tools: Object.freeze(
      Object.entries(options.tools ?? {}).map(([tool, versions]): SkillToolGrant =>
        Object.freeze({ id: tool as ToolId, versions: Object.freeze([...versions]) }),
      ),
    ),
    actions: Object.freeze([...(options.actions ?? [])]),
    reads: Object.freeze([...options.reads]),
  });

/**
 * The skills. `conversation_reply` grants the conversation agent's tools (ADR-0043): the reply at
 * its supervised (2) or autonomous (3) version, and the hand-off. Version 2 of two skills adds
 * what Geovet decided agents may propose (ADR-0084), always for a person to confirm:
 * - `customer_follow_up@2`: the follow-up proposal (`follow_up.schedule`) and scheduling it with
 *   `follow_up_schedule@2`, which needs a person's approval every time;
 * - `company_knowledge@2`: facts for the company memory (`knowledge.propose_fact`), stored as
 *   proposed until the owner confirms them.
 * The others work from what the organization has recorded and grant nothing to act with: which
 * skill may grant a new tool or action is the owner's decision, never assumed here. Version 1 of
 * every skill stays as it was: an agent keeps the version it has until someone upgrades it.
 */
export const SKILL_CATALOGUE: readonly AgentSkill[] = Object.freeze([
  skill('conversation_reply', {
    tools: { message_send: [2, 3], conversation_handoff: [1] },
    reads: ['conversation.read'],
  }),
  // What the company knows (Company Brain, ADR-0051), for the agent's department only (ADR-0063).
  skill('company_knowledge', { reads: ['knowledge.read'] }),
  skill('company_knowledge', {
    version: 2,
    actions: ['knowledge.propose_fact'],
    reads: ['knowledge.read'],
  }),
  skill('customer_follow_up', { reads: ['contact.read', 'opportunity.read', 'follow_up.read'] }),
  skill('customer_follow_up', {
    version: 2,
    tools: { follow_up_schedule: [2] },
    actions: ['follow_up.schedule'],
    reads: ['contact.read', 'opportunity.read', 'follow_up.read'],
  }),
  // Version 3 (ADR-0104): the agent itself asks, mid-task, to schedule the follow-up with
  // `follow_up_schedule@3`, by a contact's reference; a person approves every call. For agents of
  // the commercial department (Comercial y Ventas) only, and it reaches an agent only when a
  // person upgrades it.
  skill('customer_follow_up', {
    version: 3,
    tools: { follow_up_schedule: [3] },
    actions: ['follow_up.schedule'],
    reads: ['contact.read', 'opportunity.read', 'follow_up.read'],
    departments: ['sales'],
  }),
  skill('pipeline_analysis', { reads: ['opportunity.read', 'report.read'] }),
  skill('campaign_analysis', { reads: ['contact.read', 'report.read'] }),
  skill('content_drafting', { reads: ['knowledge.read'] }),
  skill('design_briefing', { reads: ['knowledge.read'] }),
  skill('operations_tracking', { reads: ['conversation.read', 'follow_up.read'] }),
  skill('finance_review', { reads: ['report.read', 'credits.read'] }),
  skill('market_research', { reads: ['knowledge.read', 'report.read'] }),
]);

export interface SkillCatalogue {
  list(): readonly AgentSkill[];
  /** One exact version, or undefined: there is no "latest". */
  resolve(id: string, version: number): AgentSkill | undefined;
}

export function createSkillCatalogue(
  skills: readonly AgentSkill[] = SKILL_CATALOGUE,
): SkillCatalogue {
  const byKey = new Map(skills.map((s) => [`${s.id}@${s.version}`, s]));
  if (byKey.size !== skills.length) throw new Error('duplicate skill version');
  return Object.freeze({
    list: () => skills,
    resolve: (id: string, version: number) => byKey.get(`${id}@${version}`),
  });
}

/** A tool at one version, as `id@version`. */
export const toolKey = (id: string, version: number): string => `${id}@${version}`;

/** The department type of a catalogue department's id (`{organizationId}_{typeId}`). */
const departmentTypeOf = (departmentId: string): string => {
  const separator = departmentId.indexOf('_');
  return separator < 0 ? '' : departmentId.slice(separator + 1);
};

/**
 * Whether an agent of this department may have this skill (ADR-0104): a skill that names department
 * types is for their agents only.
 */
export const skillAllowedIn = (skill: AgentSkill, departmentId: string): boolean =>
  skill.departments === undefined || skill.departments.includes(departmentTypeOf(departmentId));

/**
 * What an agent's skills grant: every tool version (`id@version`) and every action. Unknown
 * skills grant nothing. Given the agent's department, a skill that is not for it grants nothing
 * either (ADR-0104).
 */
export function grantsOf(
  refs: readonly { readonly id: string; readonly version: number }[],
  catalogue: SkillCatalogue,
  departmentId?: string,
): { readonly tools: ReadonlySet<string>; readonly actions: ReadonlySet<string> } {
  const tools = new Set<string>();
  const actions = new Set<string>();
  for (const ref of refs) {
    const found = catalogue.resolve(ref.id, ref.version);
    if (found !== undefined && departmentId !== undefined && !skillAllowedIn(found, departmentId)) {
      continue;
    }
    for (const grant of found?.tools ?? []) {
      for (const version of grant.versions) tools.add(toolKey(grant.id, version));
    }
    for (const action of found?.actions ?? []) actions.add(action);
  }
  return Object.freeze({ tools, actions });
}
