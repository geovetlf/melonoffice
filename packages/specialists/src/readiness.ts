import type { DefinitionRef, PolicyId, Specialist } from '@melonoffice/domain';
import {
  configurationCapabilities,
  type CapabilityProblem,
  type ToolLookup,
} from './capabilities.js';
import { skillAllowedIn, type SkillCatalogue } from './skills.js';

/**
 * Whether an agent may be activated (AE-4, ADR-0115): the checks the engines would make on its
 * first task, made before it is switched on, so an agent that would only fail is never `active`.
 * It adds no rule of its own: the capabilities resolver (skills, tools, permissions), the
 * department's state, each tool's state and the model policy the AI Gateway would use. Each
 * problem is a stable code a screen can explain, never a generic "invalid". Eligibility, the tool
 * gate and approvals still decide every task and every call.
 */
export type ReadinessProblem =
  | Exclude<CapabilityProblem, { readonly kind: 'not_active' }>
  /** An agent with no skill knows how to do nothing. */
  | { readonly kind: 'no_skills' }
  /** A skill its department may not have (ADR-0104). */
  | { readonly kind: 'skill_not_for_department'; readonly skill: string }
  /** A tool that exists but may not run now. */
  | { readonly kind: 'tool_not_active'; readonly tool: string }
  /** A model policy the AI Gateway does not know: it would refuse every call (ADR-0027). */
  | { readonly kind: 'model_policy_unknown'; readonly policy: string }
  /** Its department is not active: it takes no work (ADR-0025). */
  | { readonly kind: 'department_not_active' };

export interface AgentReadiness {
  readonly ready: boolean;
  readonly problems: readonly ReadinessProblem[];
}

export interface ReadinessFacts {
  readonly skills: SkillCatalogue;
  readonly tools: ToolLookup;
  /** The permissions of the person who activates it: an agent never acts beyond them. */
  readonly held: ReadonlySet<string>;
  /** Whether the agent's department is active. */
  readonly departmentActive: boolean;
  /**
   * Whether the AI Gateway knows a model policy the agent names. Absent: not checked here. An
   * agent that names none gets the gateway's default, which always exists.
   */
  readonly modelPolicyKnown?: (ref: DefinitionRef<PolicyId>) => boolean;
}

/** What stops `specialist` from being activated now, if anything. Pure. */
export function agentReadiness(specialist: Specialist, facts: ReadinessFacts): AgentReadiness {
  const { configuration } = specialist;
  const found = configurationCapabilities(configuration, facts);
  const problems: ReadinessProblem[] = [];
  if (configuration.skills.length === 0) problems.push({ kind: 'no_skills' });
  for (const problem of found.problems) {
    if (problem.kind !== 'not_active') problems.push(problem);
  }
  for (const { id, version } of configuration.skills) {
    const skill = facts.skills.resolve(id, version);
    if (skill !== undefined && !skillAllowedIn(skill, configuration.departmentId)) {
      problems.push({ kind: 'skill_not_for_department', skill: id });
    }
  }
  for (const { id, version } of configuration.tools) {
    if (facts.tools(id, version)?.active === false) {
      problems.push({ kind: 'tool_not_active', tool: id });
    }
  }
  const model = configuration.policies.model;
  if (
    model !== undefined &&
    facts.modelPolicyKnown !== undefined &&
    !facts.modelPolicyKnown(model)
  ) {
    problems.push({ kind: 'model_policy_unknown', policy: `${model.id}@${model.version}` });
  }
  if (!facts.departmentActive) problems.push({ kind: 'department_not_active' });
  return Object.freeze({
    ready: problems.length === 0,
    problems: Object.freeze(problems.map((p) => Object.freeze(p))),
  });
}
