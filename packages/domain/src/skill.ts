import type { MessageKey, SkillId, ToolId } from './ids.js';

/** An internal capability a specialist can use. Skills are never shown as separate specialists. */
export interface SkillDefinition {
  readonly id: SkillId;
  readonly nameKey: MessageKey;
  readonly version: number;
  readonly toolIds: readonly ToolId[];
}

/** A typed function or integration that a skill may call. */
export interface ToolReference {
  readonly id: ToolId;
}
