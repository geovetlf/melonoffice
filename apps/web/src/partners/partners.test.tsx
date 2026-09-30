import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRoute, paths } from '../shell/routes.js';
import { PartnersPage } from './PartnersPage.js';
import type { CustomerScope, PartnersClient, Relationship } from './partnersClient.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PENDING: Relationship = {
  commercialAccountId: 'acc-a',
  mode: 'white_label',
  status: 'pending',
  scopes: ['summary', 'usage', 'knowledge'],
  updatedAt: '2026-09-29T10:00:00.000Z',
  account: { name: 'Partner A', type: 'partner' },
};
const ACTIVE: Relationship = {
  commercialAccountId: 'acc-b',
  mode: 'agency',
  status: 'active',
  scopes: ['summary', 'usage'],
  updatedAt: '2026-09-29T11:00:00.000Z',
  account: { name: 'Agency B', type: 'agency' },
};

function fake(list: Relationship[]) {
  const calls: [string, string, readonly CustomerScope[]][] = [];
  const client: PartnersClient = {
    list: async () => list,
    accept: async (r, scopes) => {
      calls.push(['accept', r.commercialAccountId, scopes]);
      return { ...r, status: 'active', scopes, updatedAt: 'later' };
    },
    setScopes: async (r, scopes) => {
      calls.push(['scopes', r.commercialAccountId, scopes]);
      return { ...r, scopes, updatedAt: 'later' };
    },
    end: async (r) => {
      calls.push(['end', r.commercialAccountId, []]);
      return { ...r, status: 'ended', scopes: [], updatedAt: 'later' };
    },
  };
  return { client, calls };
}

const show = (client: PartnersClient, canManage = true) =>
  render(
    <I18nProvider locale="en">
      <PartnersPage client={client} canManage={canManage} />
    </I18nProvider>,
  );

describe('Partners and agencies (ADR-0088)', () => {
  it('has its own address in Settings', () => {
    expect(parseRoute(paths.partners())).toEqual({ kind: 'partners' });
  });

  it('accepts a request with only what the owner ticks, never more than was asked', async () => {
    const { client, calls } = fake([PENDING]);
    show(client);
    const card = within(await screen.findByRole('listitem', { name: 'Partner A' }));
    expect(card.getByText(/White label/)).toBeTruthy();
    // Nothing is ticked by default; company memory is flagged as the company's own content.
    const boxes = card.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, false, false]);
    expect(card.getByText("(your company's own content)")).toBeTruthy();
    fireEvent.click(card.getByRole('checkbox', { name: /how much AI/i }));
    fireEvent.click(card.getByRole('button', { name: 'Accept' }));
    expect(await card.findByText(/Active/)).toBeTruthy();
    expect(calls).toEqual([['accept', 'acc-a', ['usage']]]);
    expect(card.getAllByRole('checkbox')).toHaveLength(1);
  });

  it('narrows or ends an active relationship, after asking to confirm the end', async () => {
    const { client, calls } = fake([ACTIVE]);
    show(client);
    const card = within(await screen.findByRole('listitem', { name: 'Agency B' }));
    const save = card.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(card.getByRole('checkbox', { name: /name, status and plan/i }));
    fireEvent.click(save);
    await vi.waitFor(() => expect(card.getAllByRole('checkbox')).toHaveLength(1));
    expect(calls).toEqual([['scopes', 'acc-b', ['usage']]]);
    const confirm = vi
      .spyOn(globalThis, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    fireEvent.click(card.getByRole('button', { name: 'End' }));
    expect(calls).toHaveLength(1);
    fireEvent.click(card.getByRole('button', { name: 'End' }));
    expect(await screen.findByRole('heading', { name: 'Ended' })).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(calls.at(-1)).toEqual(['end', 'acc-b', []]);
  });

  it('shows but lets no one change anything without relationship.manage', async () => {
    show(fake([PENDING]).client, false);
    const card = within(await screen.findByRole('listitem', { name: 'Partner A' }));
    expect(card.queryByRole('button')).toBeNull();
    expect(card.getAllByRole('checkbox')[0]?.matches(':disabled')).toBe(true);
  });

  it('says so when nobody asked', async () => {
    show(fake([]).client);
    expect(
      await screen.findByText('No partner or agency has asked to reach your company.'),
    ).toBeTruthy();
  });
});
