import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrandSettings } from '../brand/BrandSettings.js';
import {
  createOrganizationBrandClient,
  type OrganizationBrandClient,
} from '../brand/organizationBrand.js';
import { parseRoute, paths } from '../shell/routes.js';
import {
  ConsoleRequestError,
  type ConsoleAccount,
  type ConsoleClient,
  type ConsoleCustomer,
  type ConsoleInvitation,
  type OwnBrand,
} from './consoleClient.js';
import { failureOf, lastDays, PartnerConsole } from './PartnerConsole.js';

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

function fake(
  role = 'partner.admin',
  customers: ConsoleCustomer[] = [CUSTOMER],
  invitations: ConsoleInvitation[] = [],
) {
  const calls: unknown[][] = [];
  let brand: OwnBrand = { own: { brandName: 'Kept', productName: 'Old' }, updatedAt: 'v1' };
  const client: ConsoleClient = {
    accounts: async () => [account(role)],
    members: async () => [
      { userId: 'u-1', role: 'partner.admin', status: 'active', updatedAt: 't' },
    ],
    memberInvitations: async () => [],
    inviteMember: async (_id, input) => {
      calls.push(['inviteMember', input]);
      return {
        invitation: {
          id: 'mi-1',
          email: input.email,
          role: input.role,
          status: 'pending',
          expiresAt: '2026-10-07T12:00:00.000Z',
          createdAt: 'm0',
          updatedAt: 'm1',
        },
        token: TOKEN,
      };
    },
    revokeMemberInvitation: async (_id, invitation) => {
      calls.push(['revokeMemberInvitation', invitation.id, invitation.updatedAt]);
      return { ...invitation, status: 'revoked', updatedAt: 'm2' };
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
          createdAt: '2026-09-30T12:00:00.000Z',
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

const show = (client: ConsoleClient, locale: 'en' | 'es' = 'en') =>
  render(
    <I18nProvider locale={locale}>
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
    // Only what the console can read (ADR-0097); branding only for white label.
    expect(boxes).toHaveLength(3);
    expect(within(form).queryByText(/conversations|memory|Support/)).toBeNull();
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

  it('lists every state with its dates; only a pending one can be withdrawn', async () => {
    const at = (day: string) => `2026-${day}T12:00:00.000Z`;
    const row = (email: string, status: ConsoleInvitation['status'], expires: string) => ({
      id: `inv-${status}`,
      email,
      mode: 'direct',
      scopes: [],
      status,
      expiresAt: at(expires),
      createdAt: at('09-20'),
      updatedAt: 'u',
    });
    const { client } = fake(
      'partner.admin',
      [],
      [
        row('p@example.com', 'pending', '10-05'),
        row('a@example.com', 'accepted', '09-27'),
        row('r@example.com', 'rejected', '09-27'),
        row('w@example.com', 'revoked', '09-27'),
        row('e@example.com', 'expired', '09-27'),
      ],
    );
    show(client);
    const pending = within(await screen.findByRole('listitem', { name: 'p@example.com' }));
    expect(pending.getByText(/Waiting · created Sep 20, 2026 · expires Oct 5, 2026/)).toBeTruthy();
    expect(pending.getByRole('button', { name: 'Withdraw' })).toBeTruthy();
    const expired = within(screen.getByRole('listitem', { name: 'e@example.com' }));
    expect(expired.getByText(/Expired · created Sep 20, 2026 · expired Sep 27, 2026/)).toBeTruthy();
    for (const [email, label] of [
      ['a@example.com', 'Accepted'],
      ['r@example.com', 'Declined'],
      ['w@example.com', 'Withdrawn'],
      ['e@example.com', 'Expired'],
    ] as const) {
      const item = within(screen.getByRole('listitem', { name: email }));
      expect(item.getByText(new RegExp(label))).toBeTruthy();
      expect(item.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    }
    // What the API never sends is never shown: no hash, no token.
    expect(document.body.textContent).not.toMatch(/tokenHash|#t=/);
  });

  it('says clearly why an invitation was refused', async () => {
    const { client } = fake();
    const refusals = [
      new ConsoleRequestError(409, 'invitation_exists'),
      new ConsoleRequestError(400, 'invalid_commercial_request', 'email'),
      new ConsoleRequestError(403, 'commercial_account_forbidden'),
    ];
    client.invite = async () => {
      throw refusals.shift() ?? new Error('offline');
    };
    show(client);
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ana@example.com' },
    });
    const send = screen.getByRole('button', { name: 'Create invitation' });
    for (const text of [
      /already a pending invitation for that email/,
      /That email is not valid/,
      /do not have permission/,
      /Could not reach MelonOffice/,
    ]) {
      fireEvent.click(send);
      expect(await screen.findByText(text)).toBeTruthy();
    }
    expect(screen.queryByLabelText('Invitation link')).toBeNull();
  });

  it('maps each refusal to a message and shows unknown codes as they are', () => {
    const e = (status: number, code?: string, field?: string) =>
      failureOf(new ConsoleRequestError(status, code, field));
    expect(e(409, 'commercial_limit_reached')).toEqual({ id: 'console.errors.limit' });
    expect(e(409, 'invitation_not_pending')).toEqual({ id: 'console.errors.not_pending' });
    expect(e(409, 'commercial_conflict')).toEqual({ id: 'console.errors.conflict' });
    expect(e(403, 'something_new')).toEqual({ id: 'console.errors.forbidden' });
    expect(e(400, 'invalid_commercial_request', 'scopes')).toEqual({
      id: 'console.errors.invalid',
      reason: 'scopes',
    });
    expect(e(500)).toEqual({ id: 'console.errors.other', reason: '500' });
    expect(failureOf(new TypeError('fetch failed'))).toEqual({ id: 'console.errors.network' });
  });

  it('asks for branding only for a white-label customer', async () => {
    const { client, calls } = fake();
    show(client);
    const form = (await screen.findByRole('button', { name: 'Create invitation' })).closest('form');
    if (form === null) throw new Error('no form');
    const brand = /brand/i;
    expect(within(form).queryByRole('checkbox', { name: brand })).toBeNull();
    fireEvent.change(within(form).getByLabelText('How you work with them'), {
      target: { value: 'white_label' },
    });
    fireEvent.click(within(form).getByRole('checkbox', { name: brand }));
    fireEvent.change(within(form).getByLabelText('How you work with them'), {
      target: { value: 'reseller' },
    });
    expect(within(form).queryByRole('checkbox', { name: brand })).toBeNull();
    fireEvent.change(within(form).getByLabelText('Email'), {
      target: { value: 'b@example.com' },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(calls).toContainEqual([
        'invite',
        { email: 'b@example.com', mode: 'reseller', scopes: [] },
      ]),
    );
  });

  it('copies the link, and says so when the browser cannot', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(new Error('no'));
    vi.stubGlobal('navigator', { ...globalThis.navigator, clipboard: { writeText } });
    try {
      const { client } = fake();
      show(client);
      fireEvent.change(await screen.findByLabelText('Email'), {
        target: { value: 'ana@example.com' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Copy link' }));
      expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith(`https://app.example/invite#t=${TOKEN}`);
      fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
      expect(await screen.findByText(/could not copy it/)).toBeTruthy();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('speaks Spanish', async () => {
    const { client } = fake();
    show(client, 'es');
    expect(await screen.findByRole('button', { name: 'Crear invitación' })).toBeTruthy();
    expect(screen.getByText(/No se concede nada automáticamente/)).toBeTruthy();
  });

  it('an admin invites a person by email; they join only by accepting the link', async () => {
    const { client, calls } = fake();
    vi.spyOn(globalThis, 'confirm').mockReturnValue(true);
    show(client);
    const section = within(
      (await screen.findByRole('heading', { name: 'People' })).closest('section') as HTMLElement,
    );
    const send = section.getByRole('button', { name: 'Invite to the account' });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(section.getByLabelText('Their email'), {
      target: { value: 'ana@example.com' },
    });
    fireEvent.submit(send.closest('form') as HTMLFormElement);
    const link = (await section.findByLabelText('Invitation link')) as HTMLInputElement;
    expect(link.value).toBe(`https://app.example/join#t=${TOKEN}`);
    expect(calls).toContainEqual([
      'inviteMember',
      { email: 'ana@example.com', role: 'partner.support' },
    ]);
    const row = within(await section.findByRole('listitem', { name: 'ana@example.com' }));
    fireEvent.click(row.getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(calls).toContainEqual(['revokeMemberInvitation', 'mi-1', 'm1']));
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
