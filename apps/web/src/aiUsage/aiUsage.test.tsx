import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { periodDays } from './aiUsageClient.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const bucket = (operations: number, costMicroUsd: number, credits: number, unpriced = 0) => ({
  operations,
  costMicroUsd,
  unpricedOperations: unpriced,
  credits,
});

/** Two Gemini calls charged 1 credit each, and one free NVIDIA call: internal cost apart. */
const SUMMARY = {
  scope: 'org_1',
  currency: 'USD',
  totals: bucket(3, 1_250, 2),
  by: {
    capability: { llm: bucket(3, 1_250, 2) },
    provider: { vertex: bucket(2, 1_250, 2), nvidia: bucket(1, 0, 0) },
    model: {
      'vertex/gemini-2.5-flash-lite': bucket(2, 1_250, 2),
      'nvidia/nemotron-3-nano-30b-a3b': bucket(1, 0, 0),
    },
  },
  quantities: {},
};

const event = (id: string, provider: string, model: string, cost: number, credits: number) => ({
  id,
  occurredAt: '2026-09-29T12:00:00.000Z',
  capability: 'llm',
  provider,
  model,
  modelVersion: 'current',
  operation: 'text_generation',
  outcome: 'completed',
  credits,
  cost: { actualMicroUsd: cost },
  attribution: { organizationId: 'org_1', actor: 'user' },
  source: 'llm_router',
  requestId: id,
});

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push('ai_usage.read', 'credits.read');
  backend.options.aiUsage = {
    org_1: {
      summary: SUMMARY,
      events: [
        event('e1', 'vertex', 'gemini-2.5-flash-lite', 625, 1),
        event('e2', 'nvidia', 'nemotron-3-nano-30b-a3b', 0, 0),
      ],
    },
  };
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const usageCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.apiCalls().filter((c) => c.url.includes('/ai-usage'));

describe('AI usage and cost (ADR-0074, ADR-0081)', () => {
  it('shows internal cost and credits apart, and a breakdown by capability, provider and model', async () => {
    open('/ai-usage');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'AI usage and cost' }),
    ).toBeTruthy();
    const totals = await screen.findByText('Internal AI cost', { selector: 'dt' });
    expect(within(totals.parentElement as HTMLElement).getByText('$0.00125')).toBeTruthy();
    const credits = screen.getByText('Credits used', { selector: 'dt' });
    expect(within(credits.parentElement as HTMLElement).getByText('2')).toBeTruthy();
    const providers = screen.getByRole('region', { name: 'By provider' });
    expect(within(providers).getByRole('button', { name: 'nvidia' })).toBeTruthy();
    const capability = screen.getByRole('region', { name: 'By capability' });
    expect(within(capability).getByRole('button', { name: 'Text AI (LLM)' })).toBeTruthy();
  });

  it('filters the recent operations by a breakdown row', async () => {
    open('/ai-usage');
    await screen.findByText('Text AI (LLM) · nvidia/nemotron-3-nano-30b-a3b');
    expect(screen.getByText('Text AI (LLM) · vertex/gemini-2.5-flash-lite')).toBeTruthy();
    const providers = screen.getByRole('region', { name: 'By provider' });
    fireEvent.click(within(providers).getByRole('button', { name: 'nvidia' }));
    expect(screen.getByText(/Showing the loaded operations for By provider: nvidia/)).toBeTruthy();
    expect(screen.queryByText('Text AI (LLM) · vertex/gemini-2.5-flash-lite')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getByText('Text AI (LLM) · vertex/gemini-2.5-flash-lite')).toBeTruthy();
  });

  it('reads the chosen period from the ledger', async () => {
    const backend = open('/ai-usage');
    await screen.findByText('Internal AI cost', { selector: 'dt' });
    fireEvent.click(screen.getByRole('button', { name: 'This month' }));
    await vi.waitFor(() =>
      expect(usageCalls(backend).some((c) => /from=\d{4}-\d{2}-01/.test(c.url))).toBe(true),
    );
  });

  it('says so when nothing was used, and when the ledger fails', async () => {
    open('/ai-usage', (b) => {
      b.options.aiUsage = {};
    });
    expect(await screen.findByText('No AI use recorded in this period.')).toBeTruthy();
    cleanup();
    open('/ai-usage', (b) => {
      b.options.aiUsage = { org_1: { status: 500 } };
    });
    expect(await screen.findByText('AI usage could not be loaded.')).toBeTruthy();
  });

  it('opens from the Home credits panel', async () => {
    open('/');
    fireEvent.click(await screen.findByRole('link', { name: 'See AI usage and cost' }));
    expect(globalThis.location.pathname).toBe('/ai-usage');
  });

  it('without ai_usage.read, has no link, no page and reads nothing', async () => {
    const backend = open('/ai-usage', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'ai_usage.read');
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { level: 1, name: 'AI usage and cost' })).toBeNull();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).queryByText('AI usage')).toBeNull();
    expect(screen.queryByRole('link', { name: 'See AI usage and cost' })).toBeNull();
    expect(usageCalls(backend)).toHaveLength(0);
  });

  it('counts periods in whole UTC days', () => {
    const now = new Date('2026-09-29T03:00:00Z');
    expect(periodDays('today', now)).toEqual({ from: '2026-09-29', to: '2026-09-29' });
    expect(periodDays('week', now)).toEqual({ from: '2026-09-23', to: '2026-09-29' });
    expect(periodDays('month', now)).toEqual({ from: '2026-09-01', to: '2026-09-29' });
  });
});
