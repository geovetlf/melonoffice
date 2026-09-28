import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { minorDigits, toMinor } from './OpportunitiesSection.js';

afterEach(cleanup);

const ALL = ['contact.manage', 'opportunity.read', 'opportunity.manage', 'pipeline.manage'];

/** A signed-in owner, in the Comercial office. */
function open(configure?: (backend: ReturnType<typeof fakeBackend>) => void, at = '/office/sales') {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push(...ALL);
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const section = () => screen.findByRole('region', { name: 'Opportunities' });

const lead = {
  id: 'contact_1',
  displayName: 'Rosa',
  phone: '+51987111222',
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
};

const opportunity = (id: string, stageId: string, extra: Record<string, unknown> = {}) => ({
  id,
  contactId: 'contact_1',
  contactName: 'Rosa',
  stageId,
  status: 'open',
  title: `Sale ${id}`,
  value: { amountMinor: 150050, currency: 'PEN' },
  probability: 50,
  owner: null,
  expectedCloseOn: null,
  nextAction: null,
  lostReason: null,
  closedAt: null,
  revision: 1,
  updatedAt: '2026-09-28T12:00:00Z',
  ...extra,
});

describe('opportunities in the Comercial office (C2)', () => {
  it('says there are none yet and that the stages are only proposed', async () => {
    open();
    const region = await section();
    expect(await within(region).findByText('You have no open opportunities yet.')).toBeTruthy();
    expect(within(region).getByText(/proposed for your kind of business/)).toBeTruthy();
  });

  it('shows each open stage with its opportunities, and their value', async () => {
    open((b) => {
      b.options.opportunities.org_1 = [opportunity('o1', 'proposal'), opportunity('o2', 'new')];
    });
    const region = await section();
    const proposal = await within(region).findByRole('region', { name: 'Proposal' });
    expect(within(proposal).getByRole('button', { name: /Sale o1/ })).toBeTruthy();
    expect(within(proposal).getAllByText(/1,500\.50/).length).toBe(2); // column total and row
    const fresh = within(region).getByRole('region', { name: 'New' });
    expect(within(fresh).getByRole('button', { name: /Sale o2/ })).toBeTruthy();
    expect(within(region).getByText(/2 open/)).toBeTruthy();
  });

  it('opens an opportunity for a lead, in soles', async () => {
    const backend = open((b) => {
      b.options.customers.org_1 = [lead];
    });
    const region = await section();
    fireEvent.click(await within(region).findByRole('button', { name: 'New opportunity' }));
    const form = within(region).getByRole('form', { name: 'New opportunity' });
    await within(form).findByRole('option', { name: 'Rosa' });
    fireEvent.change(within(form).getByLabelText('Contact'), { target: { value: 'contact_1' } });
    fireEvent.change(within(form).getByLabelText('What is being sold'), {
      target: { value: 'Cena de empresa' },
    });
    fireEvent.change(within(form).getByLabelText(/^Value/), { target: { value: '1500.5' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(region).findByRole('heading', { name: 'Cena de empresa', level: 3 }),
    ).toBeTruthy();
    const post = backend
      .apiCalls()
      .find((c) => c.method === 'POST' && c.url.endsWith('/opportunities'));
    expect(JSON.parse(String(post?.body))).toEqual({
      contactId: 'contact_1',
      title: 'Cena de empresa',
      stageId: 'new',
      value: { amountMinor: 150050 },
    });
  });

  it('asks for a reason before marking an opportunity lost', async () => {
    const backend = open((b) => {
      b.options.opportunities.org_1 = [opportunity('o1', 'proposal')];
    });
    const region = await section();
    fireEvent.click(await within(region).findByRole('button', { name: /Sale o1/ }));
    const card = within(await within(region).findByRole('article'));
    fireEvent.change(await card.findByLabelText('Move to'), { target: { value: 'lost' } });
    const confirm = card.getByRole('button', { name: 'Mark as lost' });
    expect(confirm.matches(':disabled')).toBe(true);
    fireEvent.change(card.getByLabelText('Why it was lost'), { target: { value: 'price' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(backend.apiCalls().some((c) => c.method === 'PATCH')).toBe(true));
    const patch = backend.apiCalls().find((c) => c.method === 'PATCH');
    expect(JSON.parse(String(patch?.body))).toEqual({
      revision: 1,
      stageId: 'lost',
      lostReason: 'price',
    });
    fireEvent.click(within(region).getByRole('tab', { name: 'Lost' }));
    expect(await within(region).findByRole('button', { name: /Sale o1/ })).toBeTruthy();
  });

  it('shows the history from the audit trail', async () => {
    open((b) => {
      b.options.opportunities.org_1 = [opportunity('o1', 'new')];
    });
    const region = await section();
    fireEvent.click(await within(region).findByRole('button', { name: /Sale o1/ }));
    const card = within(await within(region).findByRole('article'));
    expect(await card.findByText(/Opened/)).toBeTruthy();
    expect(card.getByText('No conversations with this contact yet.')).toBeTruthy();
  });

  it('edits the stages: renames one and adds another', async () => {
    const backend = open();
    const region = await section();
    fireEvent.click(await within(region).findByRole('button', { name: 'Edit stages' }));
    const form = within(region).getByRole('form', { name: 'Edit stages' });
    const names = within(form).getAllByLabelText('Stage name');
    fireEvent.change(names[0] as HTMLElement, { target: { value: 'Primer contacto' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add stage' }));
    const all = within(form).getAllByLabelText('Stage name');
    fireEvent.change(all[all.length - 1] as HTMLElement, { target: { value: 'Demo' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(backend.apiCalls().some((c) => c.method === 'PUT')).toBe(true));
    const put = backend.apiCalls().find((c) => c.method === 'PUT');
    expect(JSON.parse(String(put?.body))).toEqual({
      revision: 0,
      stages: [
        { id: 'new', name: 'Primer contacto', probability: 10 },
        { id: 'contacted', probability: 25 },
        { id: 'proposal', probability: 50 },
        { id: 'negotiation', probability: 75 },
        { name: 'Demo', probability: 50 },
        { id: 'won' },
        { id: 'lost' },
      ],
    });
  });

  it('lets a role with only opportunity.read look, not change', async () => {
    open((b) => {
      b.options.permissions = b.options.permissions.filter(
        (p) => p !== 'opportunity.manage' && p !== 'pipeline.manage',
      );
      b.options.opportunities.org_1 = [opportunity('o1', 'new')];
    });
    const region = await section();
    expect(within(region).queryByRole('button', { name: 'New opportunity' })).toBeNull();
    expect(within(region).queryByRole('button', { name: 'Edit stages' })).toBeNull();
    fireEvent.click(await within(region).findByRole('button', { name: /Sale o1/ }));
    const card = within(await within(region).findByRole('article'));
    expect((await card.findByLabelText('Move to')).matches(':disabled')).toBe(true);
  });

  it('is not shown without opportunity.read', async () => {
    open((b) => {
      b.options.permissions = b.options.permissions.filter((p) => !p.startsWith('opportunity.'));
    });
    await screen.findByRole('region', { name: 'Customers and leads' });
    expect(screen.queryByRole('region', { name: 'Opportunities' })).toBeNull();
  });

  it('turns typed amounts into minor units of the currency', () => {
    expect(minorDigits('PEN')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(toMinor('1500.5', 'PEN')).toBe(150050);
    expect(toMinor('1500,50', 'PEN')).toBe(150050);
    expect(toMinor('12', 'JPY')).toBe(12);
    expect(toMinor('1.234', 'PEN')).toBeUndefined();
    expect(toMinor('abc', 'PEN')).toBeUndefined();
  });
});
