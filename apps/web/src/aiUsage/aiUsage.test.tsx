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

const bucket = (operations: number, credits: number) => ({ operations, credits });

/** Three calls, two charged 1 credit each, as the API gives a company its usage (ADR-0082). */
const SUMMARY = {
  from: '2026-09-29',
  to: '2026-09-29',
  totals: bucket(3, 2),
  by: {
    capability: { llm: bucket(3, 2) },
    department: { org_1_marketing: bucket(1, 0) },
    task_type: { summary: bucket(2, 2) },
  },
  quantities: {},
};

const event = (id: string, credits: number, departmentId?: string) => ({
  id,
  occurredAt: '2026-09-29T12:00:00.000Z',
  capability: 'llm',
  outcome: 'completed',
  credits,
  attribution: { actor: 'user', ...(departmentId === undefined ? {} : { departmentId }) },
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
      events: [event('e1', 1), event('e2', 0, 'org_1_marketing')],
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

describe('AI usage and credits (ADR-0074, ADR-0081, ADR-0082)', () => {
  it('shows credits and operations by capability and department, never provider, model or internal cost', async () => {
    open('/ai-usage');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'AI usage and credits' }),
    ).toBeTruthy();
    const credits = await screen.findByText('Credits used', { selector: 'dt' });
    expect(within(credits.parentElement as HTMLElement).getByText('2')).toBeTruthy();
    const capability = screen.getByRole('region', { name: 'By capability' });
    expect(within(capability).getByRole('button', { name: 'Text AI (LLM)' })).toBeTruthy();
    expect(screen.queryByText('Internal AI cost')).toBeNull();
    expect(screen.queryByRole('region', { name: 'By provider' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'By model' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/\$|vertex|gemini|nvidia/i);
  });

  it('filters the recent operations by a breakdown row', async () => {
    open('/ai-usage');
    const department = await screen.findByRole('region', { name: 'By department' });
    expect(await screen.findAllByText('Text AI (LLM)', { selector: 'span' })).toHaveLength(2);
    fireEvent.click(within(department).getAllByRole('button')[0] as HTMLElement);
    expect(screen.getByText(/Showing the loaded operations for By department/)).toBeTruthy();
    expect(screen.getAllByText('Text AI (LLM)', { selector: 'span' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(screen.getAllByText('Text AI (LLM)', { selector: 'span' })).toHaveLength(2);
  });

  it('reads the chosen period from the ledger', async () => {
    const backend = open('/ai-usage');
    await screen.findByText('Credits used', { selector: 'dt' });
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
    fireEvent.click(await screen.findByRole('link', { name: 'See AI usage and credits' }));
    expect(globalThis.location.pathname).toBe('/ai-usage');
  });

  it('without ai_usage.read, has no link, no page and reads nothing', async () => {
    const backend = open('/ai-usage', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'ai_usage.read');
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { level: 1, name: 'AI usage and credits' })).toBeNull();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).queryByText('AI usage')).toBeNull();
    expect(screen.queryByRole('link', { name: 'See AI usage and credits' })).toBeNull();
    expect(usageCalls(backend)).toHaveLength(0);
  });

  it('counts periods in whole UTC days', () => {
    const now = new Date('2026-09-29T03:00:00Z');
    expect(periodDays('today', now)).toEqual({ from: '2026-09-29', to: '2026-09-29' });
    expect(periodDays('week', now)).toEqual({ from: '2026-09-23', to: '2026-09-29' });
    expect(periodDays('month', now)).toEqual({ from: '2026-09-01', to: '2026-09-29' });
  });
});
