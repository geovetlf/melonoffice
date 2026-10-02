import type { IsoTimestamp, OrganizationId, SpecialistId, UserId } from './ids.js';
import type { ExecutionId } from './execution.js';

/**
 * One note in an agent's own memory (ADR-0117): what the agent learned about how to work for its
 * organization, kept between tasks. It belongs to the agent, never to the company: the company's
 * knowledge is Company Brain's, and nothing here is ever written to or read from it.
 *
 * Kept only while the agent's `memory` setting is on, read only by that agent of that
 * organization, and gone at `expiresAt` (it is never read after). A person may delete any note.
 */
export interface AgentMemory {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly specialistId: SpecialistId;
  /** What kind of note: a preference of the people it works for, a lesson, or a person's note. */
  readonly kind: AgentMemoryKind;
  /** The note, in plain words; short, and never a secret or someone's contact details. */
  readonly text: string;
  /** Where it came from: a task of the agent (`executionId`) or a person. */
  readonly source:
    | { readonly type: 'task'; readonly id: ExecutionId }
    | { readonly type: 'person'; readonly id: UserId };
  readonly createdAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

export type AgentMemoryKind = 'preference' | 'lesson' | 'note';
