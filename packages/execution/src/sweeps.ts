import type { ExecutionStatus, IsoTimestamp, OrganizationId } from '@melonoffice/domain';

/**
 * The automatic sweep's record (ADR-0121): `executionSweeps/{slotId}`, one per 3-hour slot. It
 * makes every run happen once, whatever the queue delivers, and keeps what each run closed: which
 * execution, why, when it was found and when it was closed.
 */

/** Where a slot is. `done` is final: a slot never runs twice. */
export type SweepState = 'scheduled' | 'unscheduled' | 'running' | 'done';

/** One execution a run closed as abandoned. */
export interface SweptExecution {
  readonly executionId: string;
  readonly organizationId: OrganizationId;
  readonly from: ExecutionStatus;
  /** Why it was abandoned: `lease_expired`, `approval_expired` or `no_progress`. */
  readonly why: string;
  readonly lastProgressAt: string | null;
  readonly detectedAt: IsoTimestamp;
  readonly closedAt: IsoTimestamp;
}

/** What one run found and did. */
export interface SweepRecord {
  readonly slotId: string;
  /** How many candidates ended in each state (`closed`, `active`, `no_context`, ...). */
  readonly counts: Readonly<Record<string, number>>;
  readonly closed: readonly SweptExecution[];
  readonly finishedAt: IsoTimestamp;
}

/** The answer to a claim: run it, it already ran, or another run holds it now. */
export type SweepClaim = 'claimed' | 'done' | 'running';

export interface SweepLedger {
  /**
   * Marks a slot as scheduled. True only for the first caller, or after `unreserve`: the one that
   * must queue its task. A slot that already runs or ran is never reserved again.
   */
  reserve(slotId: string, at: IsoTimestamp): Promise<boolean>;
  /** A reserved slot whose task could not be queued: the next caller may reserve it again. */
  unreserve(slotId: string): Promise<void>;
  /**
   * Claims a slot's run. A run that started more than `staleAfterMs` ago and never finished (its
   * worker died) may be claimed again: every close it made is guarded by the execution's revision.
   */
  claim(slotId: string, at: IsoTimestamp, staleAfterMs: number): Promise<SweepClaim>;
  /** Stores what the run did and marks the slot done. */
  finish(record: SweepRecord): Promise<void>;
}

interface StoredSweep {
  readonly state: SweepState;
  readonly scheduledAt?: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly record?: SweepRecord;
}

/** The ledger in memory, for tests. */
export class InMemorySweepLedger implements SweepLedger {
  readonly #slots = new Map<string, StoredSweep>();

  async reserve(slotId: string, at: IsoTimestamp) {
    const current = this.#slots.get(slotId);
    if (current !== undefined && current.state !== 'unscheduled') return false;
    this.#slots.set(slotId, { state: 'scheduled', scheduledAt: at });
    return true;
  }

  async unreserve(slotId: string) {
    const current = this.#slots.get(slotId);
    if (current?.state === 'scheduled')
      this.#slots.set(slotId, { ...current, state: 'unscheduled' });
  }

  async claim(slotId: string, at: IsoTimestamp, staleAfterMs: number): Promise<SweepClaim> {
    const current = this.#slots.get(slotId);
    if (current?.state === 'done') return 'done';
    if (
      current?.state === 'running' &&
      Date.parse(at) - Date.parse(current.startedAt ?? at) <= staleAfterMs
    ) {
      return 'running';
    }
    this.#slots.set(slotId, { ...current, state: 'running', startedAt: at });
    return 'claimed';
  }

  async finish(record: SweepRecord) {
    const current = this.#slots.get(record.slotId);
    this.#slots.set(record.slotId, { ...current, state: 'done', record });
  }

  /** Test hook: a slot as stored. */
  slot(slotId: string): StoredSweep | undefined {
    return this.#slots.get(slotId);
  }
}
