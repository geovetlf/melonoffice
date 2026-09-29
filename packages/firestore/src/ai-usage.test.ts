import { createAICostEngine, createAIUsageLedger } from '@melonoffice/ai-usage';
import type { AIUsageEvent, OrganizationId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { AI_USAGE_DAYS, AI_USAGE_EVENTS, FirestoreAIUsageStore } from './ai-usage.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as OrganizationId;
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as OrganizationId;
const engine = createAICostEngine();

const event = (id: string, org: OrganizationId, at: string): AIUsageEvent => ({
  id,
  occurredAt: at,
  attribution: { organizationId: org, actor: 'user', taskType: 'summarise' },
  capability: 'llm',
  provider: 'google-vertex-ai',
  model: 'gemini-2.5-flash-lite',
  modelVersion: '001',
  operation: 'text_generation',
  outcome: 'completed',
  cost: engine.cost({
    capability: 'llm',
    provider: 'google-vertex-ai',
    model: 'gemini-2.5-flash-lite',
    operation: 'text_generation',
    pricing: {
      status: 'known',
      currency: 'USD',
      calculator: 'unit_rates',
      rates: [
        { unit: 'input_tokens', microUsd: 100_000, per: 1_000_000 },
        { unit: 'output_tokens', microUsd: 400_000, per: 1_000_000 },
      ],
      version: 'fixture',
      effectiveAt: '2026-09-29',
      source: 'test fixture',
    },
    usage: {
      quantities: [
        { unit: 'input_tokens', quantity: 10_000 },
        { unit: 'output_tokens', quantity: 1_000 },
      ],
    },
    estimatedMicroUsd: 2_000,
  }),
  credits: 1,
  source: 'llm_router',
  requestId: `req-${id}`,
});

describe.runIf(emulatorHost)('FirestoreAIUsageStore (emulator)', () => {
  it('keeps each event once with its day, and reads days, the platform and pages', async () => {
    const db = emulatorFirestore();
    const store = new FirestoreAIUsageStore(db);
    const ledger = createAIUsageLedger(store);
    await ledger.record(event('e1', ORG_A, '2026-09-29T10:00:00.000Z'));
    await ledger.record(event('e1', ORG_A, '2026-09-29T10:00:00.000Z'));
    await ledger.record(event('e2', ORG_A, '2026-09-29T11:00:00.000Z'));
    await ledger.record(event('e3', ORG_A, '2026-09-30T09:00:00.000Z'));
    await ledger.record(event('e4', ORG_B, '2026-09-29T12:00:00.000Z'));
    expect(await store.record(event('e2', ORG_A, '2026-09-29T11:00:00.000Z'))).toBe('replayed');

    expect((await db.collection(AI_USAGE_EVENTS).get()).size).toBe(4);
    expect((await db.collection(AI_USAGE_DAYS).get()).size).toBe(3);

    const a = await ledger.summary(ORG_A, '2026-09-29', '2026-09-30');
    // 10000 × 0.1 + 1000 × 0.4 = 1400 per call.
    expect(a.totals).toEqual({
      operations: 3,
      costMicroUsd: 4_200,
      unpricedOperations: 0,
      credits: 3,
    });
    expect(a.by.model).toMatchObject({
      'google-vertex-ai/gemini-2.5-flash-lite': { operations: 3 },
    });
    expect(a.quantities).toEqual({ llm: { input_tokens: 30_000, output_tokens: 3_000 } });
    expect((await ledger.platformSummary('2026-09-29', '2026-09-29')).totals.operations).toBe(3);

    const first = await ledger.events(ORG_A, { limit: 2 });
    expect(first.items.map((e) => e.id)).toEqual(['e3', 'e2']);
    expect(first.hasMore).toBe(true);
    expect(first.items[0]).toEqual(event('e3', ORG_A, '2026-09-30T09:00:00.000Z'));
    const next = await ledger.events(ORG_A, {
      limit: 2,
      before: { at: '2026-09-29T11:00:00.000Z', id: 'e2' },
    });
    expect(next.items.map((e) => e.id)).toEqual(['e1']);
    expect((await ledger.events(ORG_B, { limit: 10 })).items.map((e) => e.id)).toEqual(['e4']);
  });
});
