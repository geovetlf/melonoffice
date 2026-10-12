import type { IsoTimestamp } from '@melonoffice/domain';

/**
 * The `updatedAt` of a record's next version. A version is its timestamp, and a change compares
 * the one the person read (`expectedUpdatedAt`): it must move even when two writes share a
 * millisecond, or a clock behind the last writer's, or a stale version would still match and the
 * second change would silently overwrite the first.
 */
export function versionAfter(previous: string | undefined, clock: Date): IsoTimestamp {
  const last = previous === undefined ? Number.NaN : Date.parse(previous);
  const at = Number.isNaN(last) || clock.getTime() > last ? clock : new Date(last + 1);
  return at.toISOString() as IsoTimestamp;
}
