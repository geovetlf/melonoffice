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
}

const skill = (
  id: string,
  options: {
    readonly tools?: Readonly<Record<string, readonly number[]>>;
    readonly actions?: readonly string[];
    readonly reads: readonly Permission[];
  },
): AgentSkill =>
  Object.freeze({
    id: id as SkillId,
    version: 1,
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
 * The initial skills. Only `conversation_reply` grants tools today (the conversation agent's,
 * ADR-0043): the reply at its supervised (2) or autonomous (3) version, and the hand-off. The
 * others work from what the organization has recorded and grant nothing to act with: which
 * skill may grant a new tool or action is the owner's decision, never assumed here.
 */
export const SKILL_CATALOGUE: readonly AgentSkill[] = Object.freeze([
  skill('conversation_reply', {
    tools: { message_send: [2, 3], conversation_handoff: [1] },
    reads: ['conversation.read'],
  }),
  // What the company knows (Company Brain, ADR-0051), for the agent's department only (ADR-0063).
  skill('company_knowledge', { reads: ['knowledge.read'] }),
  skill('customer_follow_up', { reads: ['contact.read', 'opportunity.read', 'follow_up.read'] }),
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

/**
 * What an agent's skills grant: every tool version (`id@version`) and every action. Unknown
 * skills grant nothing.
 */
export function grantsOf(
  refs: readonly { readonly id: string; readonly version: number }[],
  catalogue: SkillCatalogue,
): { readonly tools: ReadonlySet<string>; readonly actions: ReadonlySet<string> } {
  const tools = new Set<string>();
  const actions = new Set<string>();
  for (const ref of refs) {
    const found = catalogue.resolve(ref.id, ref.version);
    for (const grant of found?.tools ?? []) {
      for (const version of grant.versions) tools.add(toolKey(grant.id, version));
    }
    for (const action of found?.actions ?? []) actions.add(action);
  }
  return Object.freeze({ tools, actions });
}
