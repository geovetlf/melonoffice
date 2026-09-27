import type { ToolDefinition, ToolVersion } from '@melonoffice/domain';
import { canonicalJson } from './canonical.js';
import { ToolError } from './errors.js';
import { checkToolDefinition } from './model.js';

/** A tool and one of its versions, as the registry resolves them. */
export interface ResolvedTool {
  readonly definition: ToolDefinition;
  readonly version: ToolVersion;
}

/**
 * What a tool is and under which policies it may be used (ADR-0026). It never runs a tool: that
 * is the executor's job, behind the tool gate.
 */
export interface ToolRegistry {
  list(): readonly ToolDefinition[];
  find(id: string): ToolDefinition | undefined;
  /** One exact version, or undefined. There is no "latest": callers name the version they use. */
  resolve(id: string, version: number): ResolvedTool | undefined;
}

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};

/**
 * Builds a registry from tool definitions, checking each. Tools ship with the code that runs
 * them, so the catalogue lives in code, like plans (ADR-0021) and departments (ADR-0025).
 *
 * `published` holds the versions a previous release already published: a definition that
 * changes one of them is refused, so a version, once used, keeps meaning the same thing.
 */
export function createToolRegistry(
  definitions: readonly ToolDefinition[],
  published: readonly ToolVersion[] = [],
): ToolRegistry {
  const byId = new Map<string, ToolDefinition>();
  for (const definition of definitions) {
    checkToolDefinition(definition);
    if (byId.has(definition.id)) throw new ToolError('invalid_tool', `duplicate:${definition.id}`);
    byId.set(definition.id, deepFreeze(structuredClone(definition)));
  }
  for (const old of published) {
    const current = byId.get(old.toolId)?.versions[old.version - 1];
    if (current === undefined || canonicalJson(current) !== canonicalJson(old)) {
      throw new ToolError('invalid_tool', `published_version_changed:${old.toolId}@${old.version}`);
    }
  }
  const all = Object.freeze([...byId.values()]);
  return Object.freeze({
    list: () => all,
    find: (id: string) => byId.get(id),
    resolve(id: string, version: number): ResolvedTool | undefined {
      const definition = byId.get(id);
      const found = definition?.versions[version - 1];
      if (definition === undefined || found === undefined || found.version !== version) {
        return undefined;
      }
      return Object.freeze({ definition, version: found });
    },
  });
}

/**
 * MelonOffice's tool catalogue. Empty: no real tool exists yet, and none is invented. The first
 * tools arrive with their executors in a later phase.
 */
export const TOOL_CATALOGUE: readonly ToolDefinition[] = Object.freeze([]);

export const defaultToolRegistry = (): ToolRegistry => createToolRegistry(TOOL_CATALOGUE);
