import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { officeDepartments } from '../office/departments.js';
import type { DepartmentView } from '../office/officeClient.js';
import { parseRoute, paths } from '../shell/routes.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

/** A signed-in session (resumed after a reload), opened at `at`. */
function open(at = '/', configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const owner = (backend: ReturnType<typeof fakeBackend>) =>
  backend.options.permissions.push('organization.update');

const RESTAURANT = {
  businessType: 'restaurant',
  country: 'PE',
  currency: 'PEN',
  timeZone: 'America/Lima',
  city: 'Lima',
  employees: null,
  salesChannels: ['whatsapp'],
  offering: null,
  needs: null,
  notes: null,
  updatedAt: '2026-09-28T12:00:00Z',
};

const field = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;

describe('the business route (ADR-0048)', () => {
  it('lives under Settings', () => {
    expect(parseRoute('/settings/business')).toEqual({ kind: 'business_profile' });
    expect(paths.business()).toBe('/settings/business');
  });
});

describe('the first step of a new organization (ADR-0048)', () => {
  it('asks the owner to describe the business before the Home, then shows the Home', async () => {
    const backend = open('/', owner);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Set up your business' }),
    ).toBeTruthy();
    // The name is the organization's own, shown and not edited here.
    expect(
      ((await screen.findByRole('textbox', { name: 'Business name' })) as HTMLInputElement).value,
    ).toBe('Acme');
    // The time zone starts as the device's own.
    expect(field('Time zone').value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    await waitFor(() => expect(field('Type of business').options.length).toBeGreaterThan(1));
    fireEvent.change(field('Type of business'), { target: { value: 'restaurant' } });
    fireEvent.change(field('Country'), { target: { value: 'PE' } });
    fireEvent.change(field('Currency'), { target: { value: 'PEN' } });
    fireEvent.change(field('Time zone'), { target: { value: 'America/Lima' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'City' }), {
      target: { value: '  Lima ' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'WhatsApp' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Physical store' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your office is ready to work' }),
    ).toBeTruthy();
    const put = backend.apiCalls().find((call) => call.method === 'PUT');
    // Only what was filled in, trimmed; channels in the catalogue's order; nothing empty.
    expect(JSON.parse(put?.body ?? '{}')).toEqual({
      businessType: 'restaurant',
      country: 'PE',
      currency: 'PEN',
      timeZone: 'America/Lima',
      city: 'Lima',
      salesChannels: ['physical_store', 'whatsapp'],
    });
  });

  it('does not stop a member who cannot describe it', async () => {
    open('/');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your office is ready to work' }),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Set up your business' })).toBeNull();
  });

  it('shows the Home once the business is described', async () => {
    open('/', (backend) => {
      owner(backend);
      backend.options.businessProfiles.org_1 = RESTAURANT;
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Your office is ready to work' }),
    ).toBeTruthy();
  });
});

describe('Settings → Business (ADR-0048)', () => {
  it('shows the saved profile, and says what the API refused', async () => {
    open('/settings/business', (backend) => {
      owner(backend);
      backend.options.businessProfiles.org_1 = RESTAURANT;
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your business' })).toBeTruthy();
    await waitFor(() => expect(field('Country').value).toBe('PE'));
    expect(field('Currency').value).toBe('PEN');
    expect(field('Time zone').value).toBe('America/Lima');
    expect((screen.getByRole('checkbox', { name: 'WhatsApp' }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.change(field('Country'), { target: { value: 'AQ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Check the “Country” field.');
  });

  it('is read-only for a member without organization.update', async () => {
    open('/settings/business', (backend) => {
      backend.options.businessProfiles.org_1 = RESTAURANT;
    });
    expect(await screen.findByText('Only the owner can change these details.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('orders the rooms by the kind of business, with the Board on top and none hidden', async () => {
    open('/', (backend) => {
      backend.options.businessProfiles.org_1 = RESTAURANT;
    });
    await screen.findByRole('heading', { level: 1, name: 'Your office is ready to work' });
    const nav = screen.getByRole('navigation', { name: 'Office' });
    await waitFor(() =>
      expect(
        within(nav)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual([
        'Home',
        'GIA',
        'Board',
        'Commercial',
        'Operations',
        'Marketing',
        'Finance',
        'Research',
      ]),
    );
  });
});

describe('the suggested order', () => {
  const department = (typeId: string | null): DepartmentView => ({
    id: `org_1_${typeId ?? 'custom'}`,
    origin: typeId === null ? 'custom' : 'catalog',
    typeId,
    nameKey: null,
    shortNameKey: null,
    name: typeId === null ? 'Legal' : null,
    status: 'active',
    description: null,
  });

  it('only arranges: departments it does not name keep their place, after the rest', () => {
    const { headquarters, floor } = officeDepartments(
      [department('leadership'), department(null), department('finance'), department('sales')],
      ['sales', 'finance', 'leadership'],
    );
    expect(headquarters.map((d) => d.typeId)).toEqual(['leadership']);
    expect(floor.map((d) => d.typeId)).toEqual(['sales', 'finance', null]);
  });
});
