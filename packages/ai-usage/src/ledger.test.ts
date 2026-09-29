import type { AIUsageEvent, OrganizationId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { createAICostEngine } from './engine.js';
import { AIUsageError } from './errors.js';
import { createAIUsageLedger, daysBetween, InMemoryAIUsageStore } from './ledger.js';

/**
 * The AI Usage Ledger (ADR-0074): events kept once, daily totals by every dimension, summaries
 * per organization and for the platform, in each capability's own units.
 */

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as OrganizationId;
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as OrganizationId;
const engine = createAICostEngine();

function event(
  id: string,
  extra: {
    org?: OrganizationId;
    at?: string;
    capability?: string;
    provider?: string;
    model?: string;
    units?: [string, number][];
    rate?: number | null;
    credits?: number;
    agent?: string;
    department?: string;
    workflow?: string;
    taskType?: string;
  } = {},
): AIUsageEvent {
  const capability = extra.capability ?? 'llm';
  const provider = extra.provider ?? 'deepseek';
  const model = extra.model ?? 'deepseek-chat';
  const units = extra.units ?? [
    ['input_tokens', 18_000],
    ['output_tokens', 3_000],
  ];
  const cost = engine.cost({
    capability,
    provider,
    model,
    operation: 'generate',
    pricing:
      extra.rate === null
        ? { status: 'unknown' }
        : {
            status: 'known',
            currency: 'USD',
            calculator: 'unit_rates',
            rates: units.map(([unit]) => ({ unit, microUsd: extra.rate ?? 1, per: 1 })),
            version: 'fixture',
            effectiveAt: '2026-09-29',
            source: 'test fixture',
          },
    usage: { quantities: units.map(([unit, quantity]) => ({ unit, quantity })) },
  });
  return {
    id,
    occurredAt: extra.at ?? '2026-09-29T10:00:00.000Z',
    attribution: {
      organizationId: extra.org ?? ORG_A,
      actor: 'runtime',
      userId: 'user-1' as never,
      ...(extra.agent === undefined ? {} : { specialistId: extra.agent as never }),
      ...(extra.department === undefined ? {} : { departmentId: extra.department as never }),
      ...(extra.workflow === undefined ? {} : { workflowId: extra.workflow as never }),
      ...(extra.taskType === undefined ? {} : { taskType: extra.taskType }),
    },
    capability,
    provider,
    model,
    modelVersion: 'v1',
    operation: 'generate',
    outcome: 'completed',
    cost,
    credits: extra.credits ?? 1,
    source: 'test',
    requestId: `req-${id}`,
  };
}

describe('AI usage ledger', () => {
  it('answers what each company, agent, department, workflow, task, capability, provider and model cost', async () => {
    const ledger = createAIUsageLedger(new InMemoryAIUsageStore());
    // Company A, Comercial, Sales agent, lead qualification on DeepSeek.
    await ledger.record(
      event('e1', { agent: 'sales', department: 'a_sales', taskType: 'lead_qualification' }),
    );
    // Company A, Marketing, Video agent, 12 s of 1080p video transformation.
    await ledger.record(
      event('e2', {
        capability: 'video_transformation',
        provider: 'provider-x',
        model: 'model-y',
        units: [['seconds', 12]],
        rate: 250_000,
        credits: 300,
        agent: 'video',
        department: 'a_marketing',
        workflow: 'campaign-q4',
      }),
    );
    // Company A, 4 images whose price is not known yet.
    await ledger.record(
      event('e3', {
        capability: 'image_generation',
        provider: 'google',
        model: 'imagen-x',
        units: [['images', 4]],
        rate: null,
        credits: 0,
        department: 'a_marketing',
      }),
    );
    await ledger.record(event('e4', { org: ORG_B }));

    const a = await ledger.summary(ORG_A, '2026-09-29', '2026-09-29');
    expect(a.totals).toEqual({
      operations: 3,
      costMicroUsd: 21_000 + 3_000_000,
      unpricedOperations: 1,
      credits: 301,
    });
    expect(a.by.capability).toMatchObject({
      llm: { operations: 1, costMicroUsd: 21_000 },
      video_transformation: { costMicroUsd: 3_000_000 },
      image_generation: { costMicroUsd: 0, unpricedOperations: 1 },
    });
    expect(a.by.department.a_marketing).toMatchObject({ operations: 2, costMicroUsd: 3_000_000 });
    expect(a.by.agent).toMatchObject({ sales: { operations: 1 }, video: { operations: 1 } });
    expect(a.by.workflow).toEqual({
      'campaign-q4': {
        operations: 1,
        costMicroUsd: 3_000_000,
        unpricedOperations: 0,
        credits: 300,
      },
    });
    expect(a.by.task_type).toMatchObject({ lead_qualification: { operations: 1 } });
    expect(a.by.model).toMatchObject({ 'deepseek/deepseek-chat': { operations: 1 } });
    expect(a.by.user).toMatchObject({ 'user-1': { operations: 3 } });
    // Each capability in its own units; no universal unit.
    expect(a.quantities).toEqual({
      llm: { input_tokens: 18_000, output_tokens: 3_000 },
      video_transformation: { seconds: 12 },
      image_generation: { images: 4 },
    });

    const platform = await ledger.platformSummary('2026-09-29', '2026-09-29');
    expect(platform.scope).toBe('platform');
    expect(platform.totals.operations).toBe(4);
    const byOrganization = await ledger.organizationTotals('2026-09-29', '2026-09-29');
    expect(Object.keys(byOrganization).sort()).toEqual([ORG_A, ORG_B].sort());
    expect(byOrganization[ORG_A]?.operations).toBe(3);
    expect(byOrganization[ORG_B]?.operations).toBe(1);
    const b = await ledger.summary(ORG_B, '2026-09-29', '2026-09-29');
    expect(b.totals.operations).toBe(1);
  });

  it('keeps an event once, and sums days, not events', async () => {
    const store = new InMemoryAIUsageStore();
    const ledger = createAIUsageLedger(store);
    await ledger.record(event('e1'));
    await ledger.record(event('e1'));
    await ledger.record(event('e2', { at: '2026-09-30T01:00:00.000Z' }));
    expect(await store.record(event('e2'))).toBe('replayed');
    expect((await ledger.summary(ORG_A, '2026-09-29', '2026-09-29')).totals.operations).toBe(1);
    expect((await ledger.summary(ORG_A, '2026-09-29', '2026-09-30')).totals.operations).toBe(2);
    expect((await ledger.summary(ORG_A, '2026-10-01', '2026-10-02')).totals.operations).toBe(0);
  });

  it('lists an organization’s events newest first, one page at a time', async () => {
    const ledger = createAIUsageLedger(new InMemoryAIUsageStore());
    for (const [id, at] of [
      ['e1', '2026-09-29T10:00:00.000Z'],
      ['e2', '2026-09-29T11:00:00.000Z'],
      ['e3', '2026-09-29T12:00:00.000Z'],
    ] as const) {
      await ledger.record(event(id, { at }));
    }
    await ledger.record(event('other', { org: ORG_B }));
    const first = await ledger.events(ORG_A, { limit: 2 });
    expect(first.items.map((e) => e.id)).toEqual(['e3', 'e2']);
    expect(first.hasMore).toBe(true);
    const last = first.items[1] as AIUsageEvent;
    const second = await ledger.events(ORG_A, {
      limit: 2,
      before: { at: last.occurredAt, id: last.id },
    });
    expect(second).toEqual({ items: [expect.objectContaining({ id: 'e1' })], hasMore: false });
    await expect(ledger.events(ORG_A, { limit: 0 })).rejects.toThrow(AIUsageError);
  });

  it('refuses malformed events and ranges', async () => {
    const ledger = createAIUsageLedger(new InMemoryAIUsageStore());
    await expect(ledger.record({ ...event('e1'), id: 'bad id!' })).rejects.toThrow(AIUsageError);
    await expect(ledger.record({ ...event('e1'), credits: -1 })).rejects.toThrow(AIUsageError);
    await expect(
      ledger.record({ ...event('e1'), creditPolicy: { id: 'free text', version: 'v1' } }),
    ).rejects.toThrow(AIUsageError);
    await expect(ledger.record({ ...event('e1'), fallbackFrom: 'a b' })).rejects.toThrow(
      AIUsageError,
    );
    expect(
      await ledger.record({
        ...event('e2'),
        credits: 0,
        creditPolicy: { id: 'provider_cost_at_rate', version: '10000' },
        fallbackFrom: 'alpha/alpha-small',
      }),
    ).toBeUndefined();
    await expect(
      ledger.record({
        ...event('e1'),
        attribution: { ...event('e1').attribution, taskType: 'free text' },
      }),
    ).rejects.toThrow(AIUsageError);
    await expect(ledger.record({ ...event('e1'), provider: 'other' })).rejects.toThrow(
      AIUsageError,
    );
    expect(() => daysBetween('2026-09-30', '2026-09-29')).toThrow(AIUsageError);
    expect(() => daysBetween('2026-01-01', '2026-12-31')).toThrow(AIUsageError);
    expect(daysBetween('2026-09-30', '2026-10-01')).toEqual(['2026-09-30', '2026-10-01']);
  });
});
