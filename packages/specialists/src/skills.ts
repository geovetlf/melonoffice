import type { MessageKey, SkillDefinition, SkillId, ToolId } from '@melonoffice/domain';
import type { Permission } from '@melonoffice/rbac';

/**
 * Skills (ADR-0062): what an agent knows how to do, as catalogue data like the tools and the
 * departments. A skill grants nothing. It names the catalogue tools it uses (the agent's version
 * must also have them, and the tool gate still decides every call) and the records it reads (the
 * person the agent acts for must hold those permissions). No code assumes how many skills exist.
 */
export interface AgentSkill extends SkillDefinition {
  readonly descriptionKey: MessageKey;
  /** The RBAC permissions that read the records this skill works from. */
  readonly reads: readonly Permission[];
}

const skill = (
  id: string,
  options: { readonly tools?: readonly string[]; readonly reads: readonly Permission[] },
): AgentSkill =>
  Object.freeze({
    id: id as SkillId,
    version: 1,
    nameKey: `agents.skill.${id}.name` as MessageKey,
    descriptionKey: `agents.skill.${id}.description` as MessageKey,
    toolIds: Object.freeze((options.tools ?? []).map((t) => t as ToolId)),
    reads: Object.freeze([...options.reads]),
  });

/**
 * The initial skills. Only `conversation_reply` uses tools today (the conversation agent's,
 * ADR-0043); the others work from what the organization has recorded, and act only once a tool
 * for them exists in the catalogue.
 */
export const SKILL_CATALOGUE: readonly AgentSkill[] = Object.freeze([
  skill('conversation_reply', {
    tools: ['message_send', 'conversation_handoff'],
    reads: ['conversation.read'],
  }),
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
