import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { todayIn } from './CustomersSection.js';

afterEach(cleanup);

/** A signed-in owner, in the Comercial office. */
function open(configure?: (backend: ReturnType<typeof fakeBackend>) => void, at = '/office/sales') {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push('contact.manage');
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const section = () => screen.findByRole('region', { name: 'Customers and leads' });

const lead = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  displayName: name,
  phone: '+51987111222',
  email: null,
  origin: 'channel',
  revision: 1,
  commercial: {
    stage: 'lead',
    owner: null,
    source: 'channel',
    consent: 'unknown',
    consentAt: null,
    nextAction: null,
    stageChangedAt: '2026-09-28T12:00:00Z',
    ...extra,
  },
  createdAt: '2026-09-28T12:00:00Z',
  updatedAt: '2026-09-28T12:00:00Z',
});

describe('customers and leads in the Comercial office (C1)', () => {
  it('says there are no customers yet, and never shows an example', async () => {
    open();
    const region = await section();
    expect(await within(region).findByText('You have no customers registered yet.')).toBeTruthy();
    expect(within(region).getByRole('tab', { name: /Leads/ }).textContent).toContain('0');
  });

  it('is only in the Comercial office', async () => {
    open(undefined, '/office/marketing');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Customers and leads' })).toBeNull();
  });

  it('is not shown to a role that cannot read contacts', async () => {
    open((b) => {
      b.options.permissions = b.options.permissions.filter((p) => !p.startsWith('contact.'));
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: 'Customers and leads' })).toBeNull();
  });

  it('registers a contact as a lead, and points to the existing one on a duplicate', async () => {
    const backend = open((b) => {
      b.options.customers.org_1 = [lead('contact_w', 'Rosa')];
    });
    const region = await section();
    fireEvent.click(await within(region).findByRole('button', { name: 'Register a contact' }));
    const form = within(region).getByRole('form', { name: 'Register a contact' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Rosa M.' } });
    fireEvent.change(within(form).getByLabelText('Phone'), {
      target: { value: '+51 987 111 222' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(form).findByText('A contact with that phone or email already exists.'),
    ).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Open the existing contact' }));
    expect(await within(region).findByRole('heading', { name: 'Rosa', level: 3 })).toBeTruthy();

    fireEvent.click(within(region).getByRole('button', { name: 'Register a contact' }));
    const again = within(region).getByRole('form', { name: 'Register a contact' });
    fireEvent.change(within(again).getByLabelText('Name'), { target: { value: 'Luis' } });
    fireEvent.change(within(again).getByLabelText('Email'), {
      target: { value: 'luis@example.com' },
    });
    fireEvent.click(within(again).getByRole('button', { name: 'Save' }));
    expect(await within(region).findByRole('heading', { name: 'Luis', level: 3 })).toBeTruthy();
    expect(backend.options.customers.org_1?.length).toBe(2);
  });

  it('asks for a phone or an email before registering', async () => {
    const backend = open();
    const region = await section();
    fireEvent.click(await within(region).findByRole('button', { name: 'Register a contact' }));
    const form = within(region).getByRole('form', { name: 'Register a contact' });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'Ana' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Write a name and a phone or an email.')).toBeTruthy();
    expect(
      backend.apiCalls().some((c) => c.method === 'POST' && c.url.endsWith('/customers')),
    ).toBe(false);
  });

  it('moves a lead to customers, takes it and keeps a note', async () => {
    const backend = open((b) => {
      b.options.customers.org_1 = [lead('contact_w', 'Rosa')];
    });
    const region = await section();
    fireEvent.click(await within(region).findByRole('button', { name: /Rosa/ }));
    const card = within(await within(region).findByRole('article'));
    fireEvent.click(await card.findByRole('button', { name: "I'll handle it" }));
    expect(await card.findByText('You')).toBeTruthy();
    fireEvent.change(card.getByLabelText('Add note'), { target: { value: 'Prefiere entrega' } });
    fireEvent.click(card.getByRole('button', { name: 'Add note' }));
    expect(await card.findByText('Prefiere entrega')).toBeTruthy();
    fireEvent.change(card.getByLabelText('Stage'), { target: { value: 'customer' } });
    await waitFor(() =>
      expect(within(region).getByRole('tab', { name: /Customers/ }).textContent).toContain('1'),
    );
    const patches = backend.apiCalls().filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => JSON.parse(String(c.body)) as unknown)).toEqual([
      { revision: 1, ownerId: expect.any(String) },
      { revision: 2, stage: 'customer' },
    ]);
  });

  it('marks a next action that is overdue', async () => {
    open((b) => {
      b.options.customers.org_1 = [
        lead('contact_w', 'Rosa', { nextAction: { text: 'Llamar', dueOn: '2020-01-01' } }),
      ];
    });
    const region = await section();
    const row = await within(region).findByRole('button', { name: /Rosa/ });
    expect(row.textContent).toContain('Overdue');
  });

  it('lets a role with only contact.read look, not change', async () => {
    open((b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'contact.manage');
      b.options.customers.org_1 = [lead('contact_w', 'Rosa')];
    });
    const region = await section();
    expect(within(region).queryByRole('button', { name: 'Register a contact' })).toBeNull();
    fireEvent.click(await within(region).findByRole('button', { name: /Rosa/ }));
    const card = within(await within(region).findByRole('article'));
    expect((await card.findByLabelText('Stage')).matches(':disabled')).toBe(true);
    expect(card.queryByRole('button', { name: 'Add note' })).toBeNull();
  });

  it("computes today in the business's time zone", () => {
    const at = new Date('2026-09-29T03:00:00Z'); // still the 28th in Lima
    expect(todayIn('America/Lima', at)).toBe('2026-09-28');
    expect(todayIn('UTC', at)).toBe('2026-09-29');
  });
});
