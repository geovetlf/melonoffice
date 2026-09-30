import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CreditGrant } from './CreditGrant.js';
import {
  PlatformRequestError,
  type CreditGrantResult,
  type GrantReason,
  type PlatformClient,
  type PlatformOrganizationView,
} from './platformClient.js';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const ORG = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SUSPENDED = 'bbbbbbbb-0000-4000-8000-00000000000b';

interface Sent {
  readonly organizationId: string;
  readonly amount: number;
  readonly reason: GrantReason;
  readonly idempotencyKey: string;
}

/** A client that grants once per key, as the API does, and can lose its first answer. */
function fake({ loseFirstAnswer = false } = {}) {
  const sent: Sent[] = [];
  const granted = new Map<string, CreditGrantResult>();
  let balance = 100;
  let lost = loseFirstAnswer;
  const client = {
    organization: async (id: string): Promise<PlatformOrganizationView> => {
      if (id === ORG) {
        return {
          organization: { id, name: 'Acme', status: 'active' },
          credits: { balance, updatedAt: 't0' },
        };
      }
      if (id === SUSPENDED) {
        return {
          organization: { id, name: 'Paused Co', status: 'suspended' },
          credits: { balance: 0, updatedAt: 't0' },
        };
      }
      throw new PlatformRequestError(404, 'organization_not_found');
    },
    grantCredits: async (
      organizationId: string,
      grant: Omit<Sent, 'organizationId'>,
    ): Promise<CreditGrantResult> => {
      sent.push({ organizationId, ...grant });
      const first = granted.get(grant.idempotencyKey);
      if (first !== undefined) return { ...first, replayed: true };
      balance += grant.amount;
      const result: CreditGrantResult = {
        grant: {
          id: `g-${granted.size + 1}`,
          organizationId,
          amount: grant.amount,
          reason: grant.reason,
          idempotencyKey: grant.idempotencyKey,
          balanceAfter: balance,
          createdAt: 't1',
        },
        balance,
        replayed: false,
      };
      granted.set(grant.idempotencyKey, result);
      if (lost) {
        lost = false;
        throw new TypeError('network');
      }
      return result;
    },
  } as unknown as PlatformClient;
  return { client, sent, balance: () => balance };
}

const show = (client: PlatformClient) =>
  render(
    <I18nProvider locale="en">
      <CreditGrant client={client} />
    </I18nProvider>,
  );

const findOrganization = async (id: string) => {
  fireEvent.change(screen.getByLabelText('Organization id'), { target: { value: id } });
  fireEvent.submit(screen.getByRole('button', { name: 'Find' }).closest('form') as HTMLElement);
  return screen.findByLabelText('organization');
};

const review = (amount: string, reason?: GrantReason) => {
  fireEvent.change(screen.getByLabelText('Credits to add'), { target: { value: amount } });
  if (reason !== undefined) {
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: reason } });
  }
  fireEvent.submit(screen.getByRole('button', { name: 'Review' }).closest('form') as HTMLElement);
};

describe("the platform administrator's manual credit grant (ADR-0091)", () => {
  it('names the organization and asks for confirmation before adding anything', async () => {
    const { client, sent } = fake();
    show(client);
    expect((await findOrganization(ORG)).textContent).toContain('Acme');
    expect(screen.getByText(/100 credits now/)).toBeTruthy();
    review('250', 'courtesy');
    expect(screen.getByText('Add 250 credits to Acme? Reason: Courtesy.')).toBeTruthy();
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(await screen.findByText('Added 250 credits. The balance is now 350.')).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ organizationId: ORG, amount: 250, reason: 'courtesy' });
    expect(sent[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('cancelling sends nothing, and each new grant gets its own key', async () => {
    const { client, sent } = fake();
    show(client);
    await findOrganization(ORG);
    review('10');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(sent).toEqual([]);
    review('10');
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    await screen.findByText(/Added 10 credits/);
    review('10');
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    await screen.findByText(/balance is now 120/);
    expect(new Set(sent.map((s) => s.idempotencyKey)).size).toBe(2);
  });

  it('a double click or a lost answer sends the same key again and adds the credits once', async () => {
    const { client, sent, balance } = fake({ loseFirstAnswer: true });
    show(client);
    await findOrganization(ORG);
    review('40', 'manual_purchase');
    const add = screen.getByRole('button', { name: 'Add credits' });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(await screen.findByText('Refused: network')).toBeTruthy();
    // The grant is still waiting to be confirmed, with the same key.
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    expect(
      await screen.findByText(
        'This grant had already been made, so nothing was added again. Balance: 140.',
      ),
    ).toBeTruthy();
    expect(sent).toHaveLength(2);
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
    expect(balance()).toBe(140);
  });

  it('a refresh before the answer keeps the grant and its key', async () => {
    const { client, sent, balance } = fake({ loseFirstAnswer: true });
    const first = show(client);
    await findOrganization(ORG);
    review('7', 'testing');
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    await screen.findByText('Refused: network');
    first.unmount();

    show(client);
    expect(screen.getByText(/was not confirmed before the page reloaded/)).toBeTruthy();
    expect(screen.getByText(`Add 7 credits to ${ORG}? Reason: Testing.`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add credits' }));
    await screen.findByText(/nothing was added again/);
    expect(sent[0]?.idempotencyKey).toBe(sent[1]?.idempotencyKey);
    expect(balance()).toBe(107);
    expect(sessionStorage.length).toBe(0);
  });

  it('shows clear refusals and offers no grant to a suspended organization', async () => {
    const { client, sent } = fake();
    show(client);
    fireEvent.change(screen.getByLabelText('Organization id'), { target: { value: 'nope' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Find' }).closest('form') as HTMLElement);
    expect(await screen.findByText('Refused: organization_not_found')).toBeTruthy();
    expect((await findOrganization(SUSPENDED)).textContent).toContain(
      'Suspended, cannot receive credits',
    );
    expect(screen.queryByLabelText('Credits to add')).toBeNull();
    expect(sent).toEqual([]);
  });
});
