import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommercialAdmin } from './CommercialAdmin.js';
import {
  PlatformRequestError,
  type CommercialAccountView,
  type DomainView,
  type NewCommercialAccount,
  type PlatformClient,
} from './platformClient.js';

afterEach(cleanup);

const ME = '11111111-0000-4000-8000-000000000001';
const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';

const PARTNER: CommercialAccountView = {
  id: 'acc-9',
  type: 'partner',
  name: 'Partner Z',
  status: 'active',
  limits: { customers: 5, members: 2 },
  updatedAt: 'v0',
};

function fake(accounts: CommercialAccountView[] = []) {
  const created: NewCommercialAccount[] = [];
  const moves: [string, string][] = [];
  const changes: unknown[] = [];
  let version = 0;
  const client = {
    commercialAccounts: async () => accounts,
    setAccountStatus: async (a: CommercialAccountView, status: string, confirmName?: string) => {
      changes.push({ id: a.id, from: a.updatedAt, status, confirmName });
      if (status === 'closed' && confirmName !== a.name) {
        throw new PlatformRequestError(400, 'close_not_confirmed');
      }
      version += 1;
      return { ...a, status, updatedAt: `v${version}` };
    },
    setAccountLimits: async (a: CommercialAccountView, limits: CommercialAccountView['limits']) => {
      changes.push({ id: a.id, from: a.updatedAt, limits });
      if (limits !== null && limits.members < 1) {
        throw new PlatformRequestError(400, 'invalid_commercial_request', 'limits');
      }
      version += 1;
      return { ...a, limits, updatedAt: `v${version}` };
    },
    createCommercialAccount: async (input: NewCommercialAccount) => {
      if (input.name === 'Taken') {
        throw new PlatformRequestError(400, 'invalid_commercial_request', 'name');
      }
      created.push(input);
      return {
        id: 'acc-1',
        type: input.type,
        name: input.name,
        status: 'active',
        limits: input.limits,
        updatedAt: 'v0',
      };
    },
    domains: async (): Promise<DomainView[]> => [
      {
        hostname: 'app.a.example',
        target: { type: 'organization', organizationId: ORG },
        status: 'pending_verification',
        updatedAt: 't0',
      },
    ],
    createDomain: async (hostname: string, target: DomainView['target']) => ({
      hostname,
      target,
      status: 'pending_verification' as const,
      updatedAt: 't1',
    }),
    setDomainStatus: async (d: DomainView, status: DomainView['status']) => {
      moves.push([d.hostname, status]);
      return { ...d, status, updatedAt: 't2' };
    },
  } as unknown as PlatformClient;
  return { client, created, moves, changes };
}

const show = (client: PlatformClient) =>
  render(
    <I18nProvider locale="en">
      <CommercialAdmin client={client} currentUserId={ME} />
    </I18nProvider>,
  );

/** Submits the new account form, as pressing its button does. */
const create = () => {
  const form = screen.getByRole('button', { name: 'Create account' }).closest('form');
  if (form === null) throw new Error('no form');
  fireEvent.submit(form);
};

describe("the platform administrator's partners and domains (ADR-0088)", () => {
  it('creates an account with its first admin and limits, and shows what the API refuses', async () => {
    const { client, created } = fake();
    show(client);
    expect(await screen.findByText('There are no commercial accounts yet.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Taken' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use my id' }));
    expect((screen.getByLabelText('First admin (user id)') as HTMLInputElement).value).toBe(ME);
    fireEvent.change(screen.getByLabelText('Most customers'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Most people'), { target: { value: '3' } });
    create();
    expect(await screen.findByText('Refused: invalid_commercial_request: name')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Partner A' } });
    create();
    expect(await screen.findByText('Partner A')).toBeTruthy();
    expect(created).toEqual([
      {
        type: 'reseller',
        name: 'Partner A',
        adminUserId: ME,
        limits: { customers: 5, members: 3 },
      },
    ]);
  });

  it('offers only a reseller or a white label, and asks a white label how many resellers (ADR-0098)', async () => {
    const { client, created } = fake();
    show(client);
    await screen.findByText('There are no commercial accounts yet.');
    const kind = screen.getByLabelText('Kind') as HTMLSelectElement;
    expect([...kind.options].map((o) => o.value)).toEqual(['reseller', 'white_label']);
    expect(screen.queryByLabelText('Most resellers')).toBeNull();
    fireEvent.change(kind, { target: { value: 'white_label' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use my id' }));
    fireEvent.change(screen.getByLabelText('Most customers'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Most people'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Most resellers'), { target: { value: '2' } });
    create();
    const row = within(await screen.findByRole('listitem', { name: 'Acme' }));
    expect(row.getByText(/up to 2 resellers/)).toBeTruthy();
    expect(created).toEqual([
      {
        type: 'white_label',
        name: 'Acme',
        adminUserId: ME,
        limits: { customers: 5, members: 3, resellers: 2 },
      },
    ]);
  });

  it('moves a domain only to the statuses the API allows: verified before active', async () => {
    const { client, moves } = fake();
    show(client);
    const row = within(await screen.findByRole('listitem', { name: 'app.a.example' }));
    expect(row.queryByRole('button', { name: 'Activate' })).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Mark verified' }));
    fireEvent.click(await row.findByRole('button', { name: 'Activate' }));
    expect(await row.findByText(/^Active/)).toBeTruthy();
    expect(moves).toEqual([
      ['app.a.example', 'verified'],
      ['app.a.example', 'active'],
    ]);
  });

  it('suspends and reactivates an account from the version shown, and changes its limits', async () => {
    const { client, changes } = fake([PARTNER]);
    show(client);
    const row = within(await screen.findByRole('listitem', { name: 'Partner Z' }));
    expect(row.getByText(/Active/)).toBeTruthy();
    fireEvent.click(row.getByRole('button', { name: 'Suspend' }));
    expect(await row.findByText(/Suspended/)).toBeTruthy();
    expect(row.queryByRole('button', { name: 'Suspend' })).toBeNull();
    fireEvent.click(row.getByRole('button', { name: 'Reactivate' }));
    expect(await row.findByRole('button', { name: 'Suspend' })).toBeTruthy();
    fireEvent.click(row.getByRole('button', { name: 'Change limits' }));
    fireEvent.change(row.getByLabelText('Most people'), { target: { value: '0' } });
    fireEvent.submit(
      row.getByRole('button', { name: 'Save limits' }).closest('form') as HTMLElement,
    );
    expect(await row.findByText('Refused: invalid_commercial_request: limits')).toBeTruthy();
    fireEvent.change(row.getByLabelText('Most people'), { target: { value: '4' } });
    fireEvent.submit(
      row.getByRole('button', { name: 'Save limits' }).closest('form') as HTMLElement,
    );
    expect(await row.findByText(/up to 5 customers and 4 people/)).toBeTruthy();
    expect(changes).toEqual([
      { id: 'acc-9', from: 'v0', status: 'suspended', confirmName: undefined },
      { id: 'acc-9', from: 'v1', status: 'active', confirmName: undefined },
      { id: 'acc-9', from: 'v2', limits: { customers: 5, members: 0 } },
      { id: 'acc-9', from: 'v2', limits: { customers: 5, members: 4 } },
    ]);
  });

  it('closes an account only after its exact name is typed, and then offers nothing more', async () => {
    const { client, changes } = fake([PARTNER]);
    show(client);
    const row = within(await screen.findByRole('listitem', { name: 'Partner Z' }));
    fireEvent.click(row.getByRole('button', { name: 'Close' }));
    const closeForGood = row.getByRole('button', { name: 'Close for good' }) as HTMLButtonElement;
    expect(closeForGood.disabled).toBe(true);
    fireEvent.change(row.getByLabelText('Type Partner Z to close it'), {
      target: { value: 'partner z' },
    });
    expect(closeForGood.disabled).toBe(true);
    expect(changes).toEqual([]);
    fireEvent.change(row.getByLabelText('Type Partner Z to close it'), {
      target: { value: 'Partner Z' },
    });
    fireEvent.click(closeForGood);
    expect(await row.findByText(/Closed/)).toBeTruthy();
    expect(row.queryByRole('button')).toBeNull();
    expect(changes).toEqual([
      { id: 'acc-9', from: 'v0', status: 'closed', confirmName: 'Partner Z' },
    ]);
  });
});
