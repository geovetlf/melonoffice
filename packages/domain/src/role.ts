import type { DepartmentTypeId, MessageKey, RoleId, SkillId } from './ids.js';

/** A specialty from the role catalogue, e.g. "Meta Ads Specialist" or "TikTok Publisher". */
export interface RoleDefinition {
  readonly id: RoleId;
  readonly nameKey: MessageKey;
  readonly version: number;
  /** Skills a specialist with this role starts with. */
  readonly defaultSkillIds: readonly SkillId[];
  /** Department types this role is suggested for; empty means any. */
  readonly suggestedDepartmentTypeIds: readonly DepartmentTypeId[];
}
