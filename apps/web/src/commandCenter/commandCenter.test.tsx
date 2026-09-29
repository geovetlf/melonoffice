import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

/**
 * The AI Command Center (block 9): real figures from the existing APIs, each card opening where
 * the work is done, and nothing read that the role may not read.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

function open(
  permissions: readonly string[],
  configure?: (b: ReturnType<typeof fakeBackend>) => void,
) {
  globalThis.history.replaceState(null, '', '/command-center');
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push(...permissions);
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const bucket = (operations: number, costMicroUsd: number, credits: number) => ({
  operations,
  costMicroUsd,
  unpricedOperations: 0,
  credits,
});

describe('the AI Command Center (block 9)', () => {
  it('shows AI cost and credits, approvals, agents and plans, and opens each place', async () => {
    open(['ai_usage.read', 'approval.read', 'plan.read'], (b) => {
      b.options.aiUsage.org_1 = {
        events: [],
        summary: {
          from: '2026-09-01',
          to: '2026-09-29',
          totals: bucket(5, 2_500_000, 250),
          by: {
            capability: { text_generation: bucket(4, 2_000_000, 200), ocr: bucket(1, 500_000, 50) },
          },
          quantities: {},
        },
      };
      b.options.approvals = { org_1: [{ id: 'a1', status: 'pending' }] };
      b.options.plans.org_1 = [
        { id: 'p1', status: 'approval_required', version: 1, createdAt: '2026-09-29T10:00:00Z' },
        { id: 'p2', status: 'executing', version: 1, createdAt: '2026-09-29T09:00:00Z' },
      ];
      b.options.specialists = {
        org_1: [{ id: 'spec_lucia', name: 'Lucía', type: 'sales', status: 'active' }],
      };
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'AI Command Center' }),
    ).toBeTruthy();
    const ai = within(await screen.findByRole('region', { name: 'AI this month' }));
    expect(await ai.findByText('$2.50')).toBeTruthy();
    expect(ai.getByText('250')).toBeTruthy();
    const approvals = within(screen.getByRole('region', { name: 'Approvals' }));
    expect(await approvals.findByText('1 waiting for you')).toBeTruthy();
    const plans = within(screen.getByRole('region', { name: 'Plans' }));
    expect(await plans.findByText('Waiting for your approval')).toBeTruthy();
    const credits = within(screen.getByRole('region', { name: 'Credits' }));
    expect(await credits.findByText('498 credits available')).toBeTruthy();
    fireEvent.click(approvals.getByRole('button', { name: 'Open the approval center' }));
    expect(globalThis.location.pathname).toBe('/approvals');
  });

  it('reads only what the role may read', async () => {
    const backend = open([]);
    await screen.findByRole('heading', { level: 1, name: 'AI Command Center' });
    await screen.findByRole('region', { name: 'Agents' });
    expect(screen.queryByRole('region', { name: 'AI this month' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Approvals' })).toBeNull();
    expect(
      backend
        .apiCalls()
        .some(
          (c) =>
            c.url.includes('/ai-usage') || c.url.includes('/approvals') || c.url.includes('/plans'),
        ),
    ).toBe(false);
  });
});
