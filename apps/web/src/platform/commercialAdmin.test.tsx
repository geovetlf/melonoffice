import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CommercialAdmin } from './CommercialAdmin.js';
import {
  PlatformRequestError,
  type DomainView,
  type NewCommercialAccount,
  type PlatformClient,
} from './platformClient.js';

afterEach(cleanup);

const ME = '11111111-0000-4000-8000-000000000001';
const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';

function fake() {
  const created: NewCommercialAccount[] = [];
  const moves: [string, string][] = [];
  const client = {
    commercialAccounts: async () => [],
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
  return { client, created, moves };
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
    expect(await screen.findByText('There are no partner or agency accounts yet.')).toBeTruthy();
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
      { type: 'partner', name: 'Partner A', adminUserId: ME, limits: { customers: 5, members: 3 } },
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
});
