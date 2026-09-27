import type { SpecialistStatus } from '@melonoffice/domain';

export const SPECIALIST_STATUSES = [
  'draft',
  'active',
  'paused',
  'disabled',
  'archived',
] as const satisfies readonly SpecialistStatus[];

/**
 * Allowed status changes (ADR-0025):
 *
 * - `draft` is being prepared: it becomes `active`, or is discarded as `archived`.
 * - `active` is the only status eligible for new executions.
 * - `paused` stops a specialist for a while; `disabled` until someone turns it back on.
 * - `archived` is history and final. A specialist with history is never deleted.
 */
export const SPECIALIST_TRANSITIONS: Readonly<
  Record<SpecialistStatus, readonly SpecialistStatus[]>
> = Object.freeze({
  draft: Object.freeze(['active', 'archived'] as const),
  active: Object.freeze(['paused', 'disabled', 'archived'] as const),
  paused: Object.freeze(['active', 'disabled', 'archived'] as const),
  disabled: Object.freeze(['active', 'archived'] as const),
  archived: Object.freeze([] as const),
});

export const isSpecialistStatus = (value: unknown): value is SpecialistStatus =>
  typeof value === 'string' && (SPECIALIST_STATUSES as readonly string[]).includes(value);

export const canChangeSpecialistStatus = (from: SpecialistStatus, to: SpecialistStatus): boolean =>
  SPECIALIST_TRANSITIONS[from].includes(to);

/** Whether a specialist in this status may be given new work. Only `active` may. */
export const canTakeNewWork = (status: SpecialistStatus): boolean => status === 'active';
