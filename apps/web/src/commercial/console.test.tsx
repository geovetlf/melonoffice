import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandSettings } from '../brand/BrandSettings.js';
import {
  createOrganizationBrandClient,
  type OrganizationBrandClient,
} from '../brand/organizationBrand.js';
import { parseRoute, paths } from '../shell/routes.js';
import type {
  ConsoleAccount,
  ConsoleClient,
  ConsoleCustomer,
  ConsoleInvitation,
  OwnBrand,
} from './consoleClient.js';
import { lastDays, PartnerConsole } from './PartnerConsole.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TOKEN = 'b'.repeat(43);
const NOW = new Date('2026-09-30T12:00:00.000Z');

const account = (role: string, type: 'partner' | 'agency' = 'partner'): ConsoleAccount => ({
  id: 'acc-1',
  type,
  name: 'Partner A',
  status: 'active',
  limits: { customers: 5, members: 3 },
  role,
});

const CUSTOMER: ConsoleCustomer = {
  organizationId: 'org-1',
  mode: 'white_label',
  scopes: ['summary', 'usage', 'billing', 'branding'],
  name: 'Tenant A',
};

function fake(role = 'partner.admin', customers: ConsoleCustomer[] = [CUSTOMER]) {
  const calls: unknown[][] = [];
  const invitations: ConsoleInvitation[] = [];
  let brand: OwnBrand = { own: { brandName: 'Kept', productName: 'Old' }, updatedAt: 'v1' };
  const client: ConsoleClient = {
    accounts: async () => [account(role)],
    members: async () => [
      { userId: 'u-1', role: 'partner.admin', status: 'active', updatedAt: 't' },
    ],
    addMember: async (_id, userId, r) => {
      calls.push(['addMember', userId, r]);
      return { userId, role: r, status: 'active', updatedAt: 't2' };
    },
    revokeMember: async (_id, userId) => {
      calls.push(['revokeMember', userId]);
    },
    customers: async () => ({ customers, pending: [] }),
    summary: async (_id, org) => {
      calls.push(['summary', org]);
      return { organization: { id: org, name: 'Tenant A', status: 'active' }, plan: 'emprendedor' };
    },
    usage: async (_id, org, from, to) => {
      calls.push(['usage', org, from, to]);
      return {
        from,
        to,
        totals: { operations: 3, credits: 12 },
        byCapability: { assist: { operations: 3, credits: 12 } },
      };
    },
    billing: async (_id, org) => {
      calls.push(['billing', org]);
      return {
        billedTo: 'commercial_account',
        subscription: { plan: 'emprendedor', status: 'active', planInForce: true },
      };
    },
    invitations: async () => invitations,
    invite: async (_id, input) => {
      calls.push(['invite', input]);
      return {
        invitation: {
          id: 'inv-1',
          email: input.email,
          mode: input.mode,
          scopes: input.scopes,
          status: 'pending',
          expiresAt: '2026-10-07T12:00:00.000Z',
          createdAt: 'c',
          updatedAt: 'u1',
        },
        token: TOKEN,
      };
    },
    revokeInvitation: async (_id, i) => {
      calls.push(['revokeInvitation', i.id, i.updatedAt]);
      return { ...i, status: 'revoked', updatedAt: 'u2' };
    },
    accountBrand: async () => ({ own: null, updatedAt: null }),
    saveAccountBrand: async (_id, config, version) => {
      calls.push(['saveAccountBrand', config, version]);
      return { own: config, updatedAt: 'a1' };
    },
    customerBrand: async () => brand,
    saveCustomerBrand: async (_id, org, config, version) => {
      calls.push(['saveCustomerBrand', org, config, version]);
      brand = { own: config, updatedAt: 'v2' };
      return brand;
    },
  };
  return { client, calls };
}

const show = (client: ConsoleClient) =>
  render(
    <I18nProvider locale="en">
      <PartnerConsole client={client} origin="https://app.example" now={() => NOW} />
    </I18nProvider>,
  );

describe('the partner console (ADR-0090)', () => {
  it('has its own addresses', () => {
    expect(parseRoute(paths.partnerConsole())).toEqual({ kind: 'partnerConsole' });
    expect(parseRoute(paths.brand())).toEqual({ kind: 'brand' });
    expect(lastDays(NOW)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('an admin opens a customer and sees only what it granted: summary, usage, billing, brand', async () => {
    const { client, calls } = fake();
    show(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/Tenant A · active · emprendedor/)).toBeTruthy();
    expect(await screen.findByText(/3 operations, 12 credits/)).toBeTruthy();
    expect(await screen.findByText(/Billed to you/)).toBeTruthy();
    expect(calls).toContainEqual(['usage', 'org-1', '2026-09-01', '2026-09-30']);
    // The white-label brand keeps its other fields and names the version read.
    const name = await screen.findAllByLabelText('Product name');
    const customerName = name[0] as HTMLInputElement;
    expect(customerName.value).toBe('Old');
    fireEvent.change(customerName, { target: { value: 'Acme Office' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save brand' })[0] as HTMLElement);
    await waitFor(() =>
      expect(calls).toContainEqual([
        'saveCustomerBrand',
        'org-1',
        { brandName: 'Kept', productName: 'Acme Office' },
        'v1',
      ]),
    );
  });

  it('support reads, but never sees billing, invites, adds people or edits a brand', async () => {
    const { client, calls } = fake('partner.support');
    show(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/3 operations, 12 credits/)).toBeTruthy();
    expect(screen.queryByText(/Billed to/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create invitation' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save brand' })).toBeNull();
    expect(calls.map((c) => c[0])).not.toContain('billing');
  });

  it('a customer that granted nothing shows nothing to open', async () => {
    const { client, calls } = fake('partner.admin', [
      { organizationId: 'org-2', mode: 'reseller', scopes: [], name: null },
    ]);
    show(client);
    expect(await screen.findByText('Customer (name not shared)')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(await screen.findByText(/shares nothing you can open/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('invites by email asking only what was ticked, and shows the link once', async () => {
    const { client, calls } = fake();
    show(client);
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ana@example.com' },
    });
    const form = screen.getByRole('button', { name: 'Create invitation' }).closest('form');
    if (form === null) throw new Error('no form');
    const boxes = within(form).getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.every((b) => !b.checked)).toBe(true);
    fireEvent.click(within(form).getByRole('checkbox', { name: /name, status and plan/ }));
    fireEvent.submit(form);
    const link = (await screen.findByLabelText('Invitation link')) as HTMLInputElement;
    expect(link.value).toBe(`https://app.example/invite#t=${TOKEN}`);
    expect(calls).toContainEqual([
      'invite',
      { email: 'ana@example.com', mode: 'direct', scopes: ['summary'] },
    ]);
    const row = within(await screen.findByRole('listitem', { name: 'ana@example.com' }));
    expect(row.getByText(/Waiting/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Invitation link')).toBeNull();
    // Withdrawing asks first.
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    fireEvent.click(row.getByRole('button', { name: 'Withdraw' }));
    expect(await row.findByText(/Withdrawn/)).toBeTruthy();
    expect(calls).toContainEqual(['revokeInvitation', 'inv-1', 'u1']);
  });

  it('an admin adds a person by user id with one of the account’s roles', async () => {
    const { client, calls } = fake();
    show(client);
    const add = await screen.findByRole('button', { name: 'Add' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Their MelonOffice user id'), {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.click(add);
    await waitFor(() =>
      expect(calls).toContainEqual([
        'addMember',
        '11111111-1111-4111-8111-111111111111',
        'partner.support',
      ]),
    );
  });
});

describe("the owner's brand (ADR-0090)", () => {
  function brandClient() {
    const saves: unknown[][] = [];
    const client: OrganizationBrandClient = {
      read: async () => ({
        own: { supportContact: { email: 'help@acme.example' } },
        updatedAt: null,
        shown: undefined,
      }),
      save: async (config, version) => {
        saves.push([config, version]);
        return { own: config, updatedAt: 'v1' };
      },
    };
    return { client, saves };
  }

  it('saves the fields shown and keeps the rest; says when a color is not readable', async () => {
    const { client, saves } = brandClient();
    const onSaved = vi.fn();
    render(
      <I18nProvider locale="en">
        <BrandSettings client={client} canEdit onSaved={onSaved} />
      </I18nProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Product name'), {
      target: { value: 'Acme' },
    });
    fireEvent.change(screen.getByLabelText('Main color (#rrggbb)'), {
      target: { value: '#ffff00' },
    });
    expect(screen.getByText(/saved but not applied/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save brand' }));
    expect(await screen.findByText('Saved.')).toBeTruthy();
    expect(saves).toEqual([
      [
        {
          supportContact: { email: 'help@acme.example' },
          productName: 'Acme',
          primaryColor: '#ffff00',
        },
        null,
      ],
    ]);
    expect(onSaved).toHaveBeenCalled();
  });

  it('without brand.manage it is shown, not changed', async () => {
    render(
      <I18nProvider locale="en">
        <BrandSettings client={brandClient().client} canEdit={false} onSaved={vi.fn()} />
      </I18nProvider>,
    );
    const input = (await screen.findByLabelText('Product name')) as HTMLInputElement;
    expect(input.matches(':disabled')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Save brand' })).toBeNull();
  });
});

describe("an organization's brand inside the app (ADR-0090)", () => {
  const answer = (body: unknown) => async () => Response.json(body);

  it('shows nothing new while only the platform brand applies', async () => {
    const client = createOrganizationBrandClient(
      answer({ brand: { productName: 'MelonOffice' }, levels: [], own: null, updatedAt: null }),
      'org-1',
    );
    expect((await client.read()).shown).toBeUndefined();
  });

  it('shows the merged brand once a level is stored, checked again here', async () => {
    const client = createOrganizationBrandClient(
      answer({
        brand: { productName: 'Acme Office', primaryColor: '#123456', faviconUrl: 'javascript:x' },
        levels: ['white_label'],
        own: null,
        updatedAt: null,
      }),
      'org-1',
    );
    expect((await client.read()).shown).toEqual({
      context: 'organization',
      productName: 'Acme Office',
      primaryColor: '#123456',
    });
  });
});
