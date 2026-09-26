/**
 * Branded identifiers. Each entity has its own id type, so a specialist id
 * can never be passed where a department or skill id is expected.
 */
declare const brand: unique symbol;

export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type OrganizationId = Brand<string, 'OrganizationId'>;
/** Id of a department type in the catalogue (e.g. the initial seven from D-11, or future ones). */
export type DepartmentTypeId = Brand<string, 'DepartmentTypeId'>;
export type DepartmentId = Brand<string, 'DepartmentId'>;
export type SpecialistId = Brand<string, 'SpecialistId'>;
export type RoleId = Brand<string, 'RoleId'>;
export type SkillId = Brand<string, 'SkillId'>;
export type ToolId = Brand<string, 'ToolId'>;
export type UserId = Brand<string, 'UserId'>;
export type HistoryEventId = Brand<string, 'HistoryEventId'>;

/** An i18n message key; user-visible names are never stored as fixed strings. */
export type MessageKey = Brand<string, 'MessageKey'>;
/** ISO-8601 timestamp in UTC. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;
