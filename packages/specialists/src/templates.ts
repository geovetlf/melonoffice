import type {
  DepartmentTypeId,
  MessageKey,
  PolicyId,
  SkillId,
  SpecialistPolicies,
} from '@melonoffice/domain';
import { SKILL_CATALOGUE, type AgentSkill } from './skills.js';

/**
 * Agent templates (ADR-0062): the starting configuration of the initial agents, as catalogue data.
 * A template is never an agent. An organization's owner creates an agent from one, in `draft`,
 * and it only works once it is activated; after that it is the organization's own, versioned
 * like any specialist. GIA is not a template: it is the executive orchestrator, not an agent of
 * a department (D-28).
 *
 * Each template names one base role, version 1, of its own. This is provisional until the role
 * catalogue (D-27) is decided; a new role reaches an agent as a new version, never an edit.
 */
export interface AgentTemplate {
  readonly id: string;
  readonly departmentTypeId: DepartmentTypeId;
  readonly nameKey: MessageKey;
  readonly mainRoleId: string;
  readonly roleVersion: number;
  /** Why the agent exists, in the organization's language: stored as its `purpose`. */
  readonly purpose: Readonly<Record<AgentLocale, string>>;
  readonly skills: readonly { readonly id: SkillId; readonly version: number }[];
  /** The model policy the agent's tasks use (ADR-0063). */
  readonly policies: SpecialistPolicies;
}

/**
 * The model policy of an agent's tasks (ADR-0063): named here so an agent never falls back to
 * the default policy. The policy itself is configuration of the worker. Version 2 (ADR-0100) pins
 * no provider or model: the Harness and the AI Gateway's router choose per task. Agents made
 * before it keep version 1 until a person moves them.
 */
export const AGENT_TASK_POLICY_REF = Object.freeze({ id: 'agent_task' as PolicyId, version: 2 });

export const AGENT_LOCALES = ['es', 'en'] as const;
export type AgentLocale = (typeof AGENT_LOCALES)[number];

/** A skill as `id` (version 1) or `id@version`: always one exact version of the catalogue. */
const skillRef = (ref: string) => {
  const [id, version = '1'] = ref.split('@');
  const found = SKILL_CATALOGUE.find(
    (s: AgentSkill) => s.id === id && s.version === Number(version),
  );
  if (found === undefined) throw new Error(`unknown skill ${ref}`);
  return Object.freeze({ id: found.id, version: found.version });
};

const template = (
  id: string,
  departmentTypeId: string,
  skills: readonly string[],
  purpose: Record<AgentLocale, string>,
): AgentTemplate =>
  Object.freeze({
    id,
    departmentTypeId: departmentTypeId as DepartmentTypeId,
    nameKey: `agents.template.${id}.name` as MessageKey,
    mainRoleId: `${id}_agent`,
    roleVersion: 1,
    purpose: Object.freeze(purpose),
    // Every agent can read what the company knows for its department (ADR-0063), and propose
    // facts to it for the owner to confirm (ADR-0084).
    skills: Object.freeze(['company_knowledge@2', ...skills].map(skillRef)),
    policies: Object.freeze({ model: AGENT_TASK_POLICY_REF }),
  });

export const AGENT_TEMPLATES: readonly AgentTemplate[] = Object.freeze([
  template('commercial', 'sales', ['customer_follow_up@2', 'pipeline_analysis'], {
    es: 'Da seguimiento a clientes y oportunidades, y ayuda a cerrar ventas.',
    en: 'Follows up on customers and opportunities, and helps close sales.',
  }),
  template('marketing', 'marketing', ['campaign_analysis', 'content_drafting'], {
    es: 'Analiza de dónde llegan los clientes y prepara contenido para atraer más.',
    en: 'Analyses where customers come from and prepares content to attract more.',
  }),
  template('creative', 'marketing', ['design_briefing', 'content_drafting'], {
    es: 'Prepara ideas, textos y briefs de diseño para la marca.',
    en: 'Prepares ideas, copy and design briefs for the brand.',
  }),
  template('operations', 'operations', ['operations_tracking'], {
    es: 'Vigila las conversaciones y seguimientos pendientes para que nada se quede sin atender.',
    en: 'Watches pending conversations and follow-ups so nothing is left unattended.',
  }),
  template('finance', 'finance', ['finance_review'], {
    es: 'Revisa ventas registradas y el consumo de créditos.',
    en: 'Reviews recorded sales and credit use.',
  }),
  template('research', 'research', ['market_research'], {
    es: 'Reúne lo que la empresa sabe y lo que muestran sus cifras para responder preguntas.',
    en: 'Brings together what the company knows and what its figures show to answer questions.',
  }),
]);

export const findAgentTemplate = (id: unknown): AgentTemplate | undefined =>
  typeof id === 'string' ? AGENT_TEMPLATES.find((t) => t.id === id) : undefined;
