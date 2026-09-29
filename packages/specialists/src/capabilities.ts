import type { Specialist, SpecialistConfiguration } from '@melonoffice/domain';
import { canTakeNewWork } from './lifecycle.js';
import type { SkillCatalogue } from './skills.js';

/**
 * What an agent may do, worked out the way the engines will decide it (ADR-0062): no AI and no
 * guessing. It adds no rule of its own. It reads the agent's current version against the skill
 * catalogue, the tool catalogue and the permissions of the person it would act for, and says what
 * is missing. The tool gate, eligibility and approvals stay the ones that decide at run time.
 */

/** A tool as the catalogue describes it, when this exact version exists there. */
export interface ToolFacts {
  readonly riskLevel: string;
  readonly approval: string;
  readonly permissions: readonly string[];
}

export type ToolLookup = (id: string, version: number) => ToolFacts | undefined;

export type CapabilityProblem =
  | { readonly kind: 'unknown_skill'; readonly skill: string }
  | { readonly kind: 'unknown_tool'; readonly tool: string }
  | { readonly kind: 'skill_tool_not_assigned'; readonly skill: string; readonly tool: string }
  | { readonly kind: 'permission_not_held'; readonly permission: string }
  | { readonly kind: 'not_active'; readonly status: string };

export interface AgentCapabilities {
  readonly skills: readonly {
    readonly id: string;
    readonly version: number;
    readonly known: boolean;
    readonly tools: readonly string[];
    readonly reads: readonly string[];
  }[];
  readonly tools: readonly {
    readonly id: string;
    readonly version: number;
    readonly known: boolean;
    readonly riskLevel: string | null;
    readonly approval: string | null;
  }[];
  /** Every permission the agent's work needs: its own list, its skills' reads and its tools'. */
  readonly permissions: {
    readonly required: readonly string[];
    readonly missing: readonly string[];
  };
  readonly problems: readonly CapabilityProblem[];
  /** Active and with nothing missing: it may take work. */
  readonly ready: boolean;
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** What `configuration` lets an agent do for someone who holds `held`. */
export function configurationCapabilities(
  configuration: SpecialistConfiguration,
  options: {
    readonly skills: SkillCatalogue;
    readonly tools: ToolLookup;
    readonly held: ReadonlySet<string>;
  },
): Omit<AgentCapabilities, 'ready'> {
  const problems: CapabilityProblem[] = [];
  const assigned = new Set(configuration.tools.map((t) => t.id as string));
  const skills = configuration.skills.map(({ id, version }) => {
    const found = options.skills.resolve(id, version);
    if (found === undefined) problems.push({ kind: 'unknown_skill', skill: id });
    for (const tool of found?.toolIds ?? []) {
      if (!assigned.has(tool)) problems.push({ kind: 'skill_tool_not_assigned', skill: id, tool });
    }
    return Object.freeze({
      id: id as string,
      version,
      known: found !== undefined,
      tools: Object.freeze([...(found?.toolIds ?? [])] as string[]),
      reads: Object.freeze([...(found?.reads ?? [])] as string[]),
    });
  });
  const tools = configuration.tools.map(({ id, version }) => {
    const found = options.tools(id, version);
    if (found === undefined) problems.push({ kind: 'unknown_tool', tool: id });
    return Object.freeze({
      id: id as string,
      version,
      known: found !== undefined,
      riskLevel: found?.riskLevel ?? null,
      approval: found?.approval ?? null,
      permissions: found?.permissions ?? [],
    });
  });
  const required = sorted([
    ...configuration.permissions,
    ...skills.flatMap((s) => s.reads),
    ...tools.flatMap((t) => t.permissions),
  ]);
  const missing = required.filter((p) => !options.held.has(p));
  for (const permission of missing) problems.push({ kind: 'permission_not_held', permission });
  return Object.freeze({
    skills: Object.freeze(skills),
    tools: Object.freeze(
      tools.map(({ id, version, known, riskLevel, approval }) =>
        Object.freeze({ id, version, known, riskLevel, approval }),
      ),
    ),
    permissions: Object.freeze({
      required: Object.freeze(required),
      missing: Object.freeze(missing),
    }),
    problems: Object.freeze(problems),
  });
}

/** What an agent may do now: its current version, and only while it is active. */
export function agentCapabilities(
  specialist: Specialist,
  options: Parameters<typeof configurationCapabilities>[1],
): AgentCapabilities {
  const found = configurationCapabilities(specialist.configuration, options);
  const problems = canTakeNewWork(specialist.status)
    ? found.problems
    : Object.freeze([
        ...found.problems,
        { kind: 'not_active', status: specialist.status } as const,
      ]);
  return Object.freeze({ ...found, problems, ready: problems.length === 0 });
}
