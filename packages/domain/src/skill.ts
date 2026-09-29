import type { MessageKey, SkillId, ToolId } from './ids.js';

/** A tool a skill grants, at exactly these versions (SK-1, ADR-0069). */
export interface SkillToolGrant {
  readonly id: ToolId;
  readonly versions: readonly number[];
}

/**
 * An internal capability a specialist can use. Skills are never shown as separate specialists.
 * A skill is the only way an agent gets a tool or a Decision Engine action (SK-1, ADR-0069).
 */
export interface SkillDefinition {
  readonly id: SkillId;
  readonly nameKey: MessageKey;
  readonly version: number;
  /** The tools, and their exact versions, an agent with this skill may be given. */
  readonly tools: readonly SkillToolGrant[];
  /** The Decision Engine actions (`ACTION_CATALOGUE` ids) it lets an agent propose. */
  readonly actions: readonly string[];
}

/** A typed function or integration that a skill may call. */
export interface ToolReference {
  readonly id: ToolId;
}
