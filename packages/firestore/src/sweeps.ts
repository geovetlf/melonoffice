import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { SweepClaim, SweepLedger, SweepRecord, SweepState } from '@melonoffice/execution';
import type { IsoTimestamp } from '@melonoffice/domain';

/**
 * `executionSweeps/{slotId}` (ADR-0121): one document per 3-hour slot of the automatic sweep.
 * Written by the worker only. It holds no organization's data beyond the ids of what it closed.
 */
export const EXECUTION_SWEEPS = 'executionSweeps';

interface SweepDocument {
  readonly state: SweepState;
  readonly scheduledAt?: FirestoreTimestamp;
  readonly startedAt?: FirestoreTimestamp;
  readonly finishedAt?: FirestoreTimestamp;
  readonly counts?: Readonly<Record<string, number>>;
  readonly closed?: SweepRecord['closed'];
}

const at = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));

export class FirestoreSweepLedger implements SweepLedger {
  constructor(private readonly db: Firestore) {}

  #doc(slotId: string) {
    return this.db.collection(EXECUTION_SWEEPS).doc(slotId);
  }

  async reserve(slotId: string, scheduledAt: IsoTimestamp): Promise<boolean> {
    const doc = this.#doc(slotId);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const current = snapshot.data() as SweepDocument | undefined;
      if (current !== undefined && current.state !== 'unscheduled') return false;
      t.set(doc, { state: 'scheduled', scheduledAt: at(scheduledAt) } satisfies SweepDocument);
      return true;
    });
  }

  async unreserve(slotId: string): Promise<void> {
    const doc = this.#doc(slotId);
    await this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const current = snapshot.data() as SweepDocument | undefined;
      if (current?.state === 'scheduled') t.update(doc, { state: 'unscheduled' });
    });
  }

  async claim(slotId: string, startedAt: IsoTimestamp, staleAfterMs: number): Promise<SweepClaim> {
    const doc = this.#doc(slotId);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const current = snapshot.data() as SweepDocument | undefined;
      if (current?.state === 'done') return 'done';
      if (
        current?.state === 'running' &&
        current.startedAt !== undefined &&
        Date.parse(startedAt) - current.startedAt.toMillis() <= staleAfterMs
      ) {
        return 'running';
      }
      t.set(doc, { state: 'running', startedAt: at(startedAt) }, { merge: true });
      return 'claimed';
    });
  }

  async finish(record: SweepRecord): Promise<void> {
    await this.#doc(record.slotId).set(
      {
        state: 'done',
        finishedAt: at(record.finishedAt),
        counts: record.counts,
        closed: record.closed,
      },
      { merge: true },
    );
  }
}
