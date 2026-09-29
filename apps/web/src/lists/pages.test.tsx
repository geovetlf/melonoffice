import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

afterEach(cleanup);

/** A signed-in owner in the Comercial office, with pages of `pageSize` records. */
function open(pageSize: number, configure: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', '/office/sales');
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push(
    'contact.manage',
    'opportunity.read',
    'opportunity.manage',
    'follow_up.read',
    'follow_up.manage',
  );
  backend.options.pageSize = pageSize;
  configure(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const lead = (n: number) => ({
  id: `contact_${n}`,
  displayName: `Lead ${n}`,
  phone: `+5198711122${n}`,
  email: null,
  origin: 'user',
  revision: 1,
  commercial: {
    stage: 'lead',
    owner: null,
    source: 'manual',
    consent: 'unknown',
    consentAt: null,
    nextAction: null,
    stageChangedAt: '2026-09-28T12:00:00Z',
  },
  createdAt: '2026-09-28T12:00:00Z',
  updatedAt: '2026-09-28T12:00:00Z',
});

const opportunity = (n: number, stageId: string) => ({
  id: `opp_${n}`,
  contactId: 'contact_1',
  contactName: 'Lead 1',
  stageId,
  status: 'open',
  title: `Sale ${n}`,
  value: null,
  probability: 10,
  owner: null,
  expectedCloseOn: null,
  nextAction: null,
  lostReason: null,
  closedAt: null,
  revision: 1,
  updatedAt: '2026-09-28T12:00:00Z',
});

const followUp = (n: number) => ({
  id: `f${n}`,
  contactId: 'contact_1',
  contactName: 'Lead 1',
  opportunityId: null,
  assignee: 'you',
  type: 'call',
  title: `Call ${n}`,
  description: null,
  scheduledAt: '2026-09-29T15:00:00.000Z',
  timeZone: 'America/Lima',
  date: '2026-09-29',
  time: '10:00',
  when: 'upcoming',
  days: 1,
  status: 'scheduled',
  source: 'manual',
  cancelReason: null,
  failure: null,
  revision: 1,
});

const calls = (backend: ReturnType<typeof fakeBackend>, path: string) =>
  backend.apiCalls().filter((c) => c.method === 'GET' && c.url.includes(path));

describe("Comercial's lists, one page at a time (ADR-0061)", () => {
  it('shows the first page of contacts and loads the next with the cursor the API gave', async () => {
    const backend = open(2, (b) => {
      b.options.customers.org_1 = [1, 2, 3, 4, 5].map(lead);
    });
    const region = await screen.findByRole('region', { name: 'Customers and leads' });
    await within(region).findByText('Lead 1');
    expect(within(region).getByText('Lead 2')).toBeTruthy();
    expect(within(region).queryByText('Lead 3')).toBeNull();
    // The tab counts all the leads, not the page.
    expect(within(region).getByRole('tab', { name: /Leads/ }).textContent).toContain('5');
    fireEvent.click(within(region).getByRole('button', { name: 'Load more' }));
    expect(await within(region).findByText('Lead 4')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Load more' }));
    expect(await within(region).findByText('Lead 5')).toBeTruthy();
    // The last page: no button, and each lead shown once.
    expect(within(region).queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(within(region).getAllByText(/^Lead \d$/)).toHaveLength(5);
    const reads = calls(backend, '/customers?stage=lead');
    expect(reads.map((c) => new URL(c.url).searchParams.get('cursor'))).toEqual([
      null,
      'page:2',
      'page:4',
    ]);
  });

  it('says so when the next page fails, and keeps what is shown', async () => {
    const backend = open(2, (b) => {
      b.options.customers.org_1 = [1, 2, 3].map(lead);
    });
    const region = await screen.findByRole('region', { name: 'Customers and leads' });
    await within(region).findByText('Lead 2');
    backend.options.nextPagesFail = true;
    fireEvent.click(within(region).getByRole('button', { name: 'Load more' }));
    expect(
      await within(region).findByText('The next page could not be loaded. Try again.'),
    ).toBeTruthy();
    // Nothing shown is lost, and the button stays to try again.
    expect(within(region).getByRole('button', { name: 'Load more' })).toBeTruthy();
    expect(within(region).getByText('Lead 1')).toBeTruthy();
    expect(within(region).getByText('Lead 2')).toBeTruthy();
  });

  it('counts each board column from the totals, and loads more opportunities into it', async () => {
    open(2, (b) => {
      b.options.customers.org_1 = [lead(1)];
      b.options.opportunities.org_1 = [
        opportunity(1, 'new'),
        opportunity(2, 'new'),
        opportunity(3, 'new'),
      ];
    });
    const region = await screen.findByRole('region', { name: 'Opportunities' });
    await within(region).findByText('Sale 1');
    const column = within(region).getByRole('region', { name: 'New' });
    // Three in the stage in all, two on the first page.
    expect(within(column).getByRole('heading').textContent).toContain('3');
    expect(within(column).queryByText('Sale 3')).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Load more' }));
    expect(await within(column).findByText('Sale 3')).toBeTruthy();
    expect(within(region).queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('pages the pending follow-ups, with the group counts of all of them', async () => {
    open(2, (b) => {
      b.options.followUps.org_1 = [1, 2, 3].map(followUp);
    });
    const region = await screen.findByRole('region', { name: 'Follow-ups' });
    const heading = await within(region).findByRole('heading', { name: /Next days/ });
    expect(heading.textContent).toContain('3');
    expect(within(region).queryByRole('listitem', { name: 'Call 3' })).toBeNull();
    fireEvent.click(within(region).getByRole('button', { name: 'Load more' }));
    expect(await within(region).findByRole('listitem', { name: 'Call 3' })).toBeTruthy();
  });
});
