import type { AIUsageEvent } from '@melonoffice/domain';

/**
 * Where AI usage events go (ADR-0073). Every engine that serves an AI capability emits to one;
 * the usage ledger (next block) is the persistent one the Financial Backend will read. A failed
 * emit never fails the operation it describes: the credits ledger already charged it.
 */
export interface AIUsageSink {
  record(event: AIUsageEvent): Promise<void>;
}

/** For tests and local runs. */
export class InMemoryUsageSink implements AIUsageSink {
  readonly events: AIUsageEvent[] = [];

  async record(event: AIUsageEvent): Promise<void> {
    if (!this.events.some((e) => e.id === event.id)) this.events.push(event);
  }
}
