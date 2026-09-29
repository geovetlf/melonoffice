import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const METRICS = [
  {
    id: 'sales.won_value',
    unit: 'currency',
    entity: 'currency',
    frequencies: ['day', 'week', 'month'],
    departments: ['sales', 'leadership', 'finance', 'research'],
    readable: true,
  },
  {
    id: 'leads.new',
    unit: 'count',
    entity: 'source_kind',
    frequencies: ['day', 'week', 'month'],
    departments: ['sales', 'marketing', 'leadership', 'research'],
    readable: true,
  },
  {
    id: 'conversations.new',
    unit: 'count',
    entity: 'channel',
    frequencies: ['day', 'week', 'month'],
    departments: ['operations', 'sales', 'marketing', 'leadership', 'research'],
    // The person may not read conversations: never shown.
    readable: false,
  },
];

const day = (i: number) => {
  const date = new Date(Date.UTC(2026, 7, 29 + i));
  return date.toISOString().slice(0, 10);
};

/** 30 recorded days of S/100 a day, the same before, 12 of 28 days for a projection. */
const SALES_DAYS = {
  metric: 'sales.won_value',
  unit: 'currency',
  entity: 'PEN',
  frequency: 'day',
  timeZone: 'America/Lima',
  from: '2026-08-29',
  to: '2026-09-27',
  points: Array.from({ length: 30 }, (_, i) => ({ period: day(i), value: i < 18 ? 0 : 250 })),
  total: 3000,
  average: 100,
  previousTotal: 2000,
  current: { period: '2026-09-28', value: 150 },
  firstRecord: '2026-09-16',
  readiness: { ready: false, problem: 'insufficient_data', have: 12, need: 28, shortOf: 'periods' },
};

const LEADS_DAYS = {
  ...SALES_DAYS,
  metric: 'leads.new',
  unit: 'count',
  entity: 'all',
  total: 7,
  previousTotal: null,
  current: { period: '2026-09-28', value: 0 },
  readiness: {
    ready: false,
    problem: 'insufficient_data',
    have: 3,
    need: 5,
    shortOf: 'active_periods',
  },
};

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push('report.read', 'opportunity.read');
  backend.options.metrics = {
    org_1: {
      list: METRICS,
      histories: {
        'sales.won_value:day': SALES_DAYS,
        'sales.won_value:week': { ...SALES_DAYS, frequency: 'week', total: 2100 },
        'leads.new:day': LEADS_DAYS,
        'leads.new:week': { ...LEADS_DAYS, frequency: 'week' },
      },
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

const metricCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.apiCalls().filter((c) => c.url.includes('/metrics'));

describe('Reports (ADR-0060): what was recorded, never a projection', () => {
  it('shows each readable metric with its total, comparison, day so far and projection readiness', async () => {
    open('/reports');
    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeTruthy();
    const sales = await screen.findByRole('article', { name: 'Sales won (value)' });
    expect(await within(sales).findByText(/PEN\s?3,000\.00/)).toBeTruthy();
    expect(within(sales).getByText('Last 30 days (Aug 29 – Sep 27)')).toBeTruthy();
    expect(
      within(sales).getByText(/\+50% against the same stretch before \(PEN\s?2,000\.00\)\./),
    ).toBeTruthy();
    expect(within(sales).getByText(/Today so far: PEN\s?150\.00/)).toBeTruthy();
    expect(
      within(sales).getByText('To project: 12 of the 28 days of history needed.'),
    ).toBeTruthy();
    expect(within(sales).getByRole('img', { name: 'Last 30 days (Aug 29 – Sep 27)' })).toBeTruthy();
    const leads = screen.getByRole('article', { name: 'New leads and customers' });
    expect(await within(leads).findByText('No earlier records to compare with.')).toBeTruthy();
    expect(
      within(leads).getByText('To project: 3 of the 5 days with activity needed.'),
    ).toBeTruthy();
    // Labelled as recorded figures, and nothing the person may not read.
    expect(screen.getByText('Figures recorded in MelonOffice, not projections.')).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'New conversations' })).toBeNull();
  });

  it('reads weeks when asked, from the API, without adding up anything itself', async () => {
    const backend = open('/reports');
    const sales = await screen.findByRole('article', { name: 'Sales won (value)' });
    await within(sales).findByText(/PEN\s?3,000\.00/);
    fireEvent.click(screen.getByRole('button', { name: 'week' }));
    expect(await within(sales).findByText(/PEN\s?2,100\.00/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'week' }).getAttribute('aria-pressed')).toBe('true');
    expect(metricCalls(backend).some((c) => c.url.includes('frequency=week'))).toBe(true);
  });

  it('says which company information is missing and opens the company memory', async () => {
    open('/reports', (b) => {
      const reports = b.options.metrics.org_1;
      if (reports === undefined) throw new Error('no reports');
      reports.histories['sales.won_value:day'] = {
        error: 'invalid_request',
        field: 'business_context',
        status: 400,
      };
      reports.histories['leads.new:day'] = { error: 'internal', status: 500 };
    });
    const sales = await screen.findByRole('article', { name: 'Sales won (value)' });
    expect(
      await within(sales).findByText(
        'Counting by day needs the company information and its time zone.',
      ),
    ).toBeTruthy();
    const leads = screen.getByRole('article', { name: 'New leads and customers' });
    expect(await within(leads).findByText('This report could not be loaded.')).toBeTruthy();
    fireEvent.click(within(sales).getByRole('link', { name: 'Open Company memory' }));
    expect(globalThis.location.pathname).toBe('/memory');
  });

  it("puts each department's metrics in its office, and no section where none serves it", async () => {
    open('/office/marketing');
    const section = await screen.findByRole('region', { name: 'Reports' });
    expect(
      await within(section).findByRole('article', { name: 'New leads and customers' }),
    ).toBeTruthy();
    expect(within(section).queryByRole('article', { name: 'Sales won (value)' })).toBeNull();
    cleanup();
    open('/office/operations');
    await screen.findByRole('heading', { level: 1 });
    // Operations is served only by conversations, which this person may not read.
    await vi.waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Reports' })).toBeNull();
  });

  it('without report.read, Reports stays a coming tool and nothing is read', async () => {
    const backend = open('/reports', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'report.read');
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('heading', { level: 1, name: 'Reports' })).toBeNull();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).queryByRole('link', { name: /Reports/ })).toBeNull();
    expect(metricCalls(backend)).toHaveLength(0);
  });
});
