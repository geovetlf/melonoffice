import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

/** A signed-in owner whose business is described, on the Home. */
function open(configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.businessProfiles.org_1 = {
    businessType: 'restaurant',
    country: 'PE',
    currency: 'PEN',
    timeZone: 'America/Lima',
    city: 'Lima',
    salesChannels: [],
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

const panel = () => screen.findByRole('region', { name: 'Recent activity' });
const reads = (backend: ReturnType<typeof fakeBackend>) =>
  backend
    .apiCalls()
    .map((call) => call.url)
    .filter((url) => url.includes('/activity'));

describe("the Home's activity (ADR-0049)", () => {
  it('says there is no activity yet, and never shows an example', async () => {
    open();
    const region = await panel();
    expect(await within(region).findByText('No activity yet today.')).toBeTruthy();
    expect(within(region).queryByText('Example')).toBeNull();
  });

  it('shows what the audit trail recorded, who did it, and links a conversation', async () => {
    const now = Date.now();
    open((backend) => {
      backend.options.activity.org_1 = [
        {
          id: 'e2',
          at: new Date(now - 5 * 60_000).toISOString(),
          action: 'conversation.message_received',
          result: 'success',
          actor: 'contact',
          link: { kind: 'conversation', id: 'c1' },
        },
        {
          id: 'e1',
          at: new Date(now - 2 * 3_600_000).toISOString(),
          action: 'organization.profile_updated',
          result: 'success',
          actor: 'you',
        },
        {
          id: 'e0',
          at: new Date(now - 3 * 3_600_000).toISOString(),
          action: 'channel.connection_failed',
          result: 'failure',
          actor: 'system',
        },
      ];
    });
    const region = await panel();
    const link = await within(region).findByRole('link', { name: /A message arrived/ });
    expect(link.getAttribute('href')).toBe('/conversations');
    expect(link.textContent).toContain('A customer');
    expect(within(region).getByText('The business profile was updated')).toBeTruthy();
    expect(within(region).getByText('A channel connection failed · failed')).toBeTruthy();
  });

  it('reads today, this week and this month on request', async () => {
    const backend = open();
    const region = await panel();
    await within(region).findByText('No activity yet today.');
    const week = within(region).getByRole('button', { name: 'This week' });
    expect(week.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(week);
    expect(week.getAttribute('aria-pressed')).toBe('true');
    expect(await within(region).findByText('No activity yet this week.')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'This month' }));
    expect(await within(region).findByText('No activity yet this month.')).toBeTruthy();
    expect(reads(backend).map((url) => url.split('?')[1])).toEqual([
      'period=today',
      'period=week',
      'period=month',
    ]);
  });

  it('says it could not load, rather than showing nothing happened', async () => {
    open((backend) => {
      backend.options.activityFails = true;
    });
    const region = await panel();
    expect(
      await within(region).findByText('We could not load the activity. Try again later.'),
    ).toBeTruthy();
    expect(within(region).queryByText(/No activity yet/)).toBeNull();
  });

  it('reads nothing for a role without activity.read', async () => {
    const backend = open((b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'activity.read');
    });
    const region = await panel();
    expect(
      await within(region).findByText("Your role does not show the office's activity."),
    ).toBeTruthy();
    expect(within(region).queryByRole('group', { name: 'Period' })).toBeNull();
    await waitFor(() => expect(reads(backend)).toEqual([]));
  });
});
