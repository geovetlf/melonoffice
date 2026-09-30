import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStore } from '../identity/testing.js';
import { JoinDecision } from './JoinPage.js';
import {
  captureInvitationToken,
  clearInvitationToken,
  INVITATION_KEY,
  JOIN,
  JOIN_KEY,
  joinLink,
  pendingInvitationToken,
} from './invitationToken.js';
import { InvitationRequestError } from './invitationsClient.js';
import type { JoinClient, JoinLookup } from './joinClient.js';

const TOKEN = 'c'.repeat(40) + '_-7';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearInvitationToken(undefined, JOIN);
});
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const LOOKUP: JoinLookup = {
  invitation: {
    account: { name: 'Partner A', type: 'partner' },
    role: 'partner.support',
    status: 'pending',
    expiresAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  },
  person: 'invited',
};

function fake(lookup: JoinLookup | Error = LOOKUP, refuse?: Error) {
  const calls: unknown[][] = [];
  const client: JoinClient = {
    lookup: async (token) => {
      calls.push(['lookup', token]);
      if (lookup instanceof Error) throw lookup;
      return lookup;
    },
    accept: async (token, version) => {
      calls.push(['accept', token, version]);
      if (refuse !== undefined) throw refuse;
    },
    reject: async (token, version) => {
      calls.push(['reject', token, version]);
    },
  };
  return { client, calls };
}

const show = (client: JoinClient, onSignOut = vi.fn()) =>
  render(
    <I18nProvider locale="en">
      <JoinDecision client={client} token={TOKEN} onSignOut={onSignOut} />
    </I18nProvider>,
  );

describe('the link to join an account (ADR-0093)', () => {
  it('is its own link, kept apart from a company invitation', () => {
    const store = memoryStore();
    expect(joinLink('https://app.example', TOKEN)).toBe(`https://app.example/join#t=${TOKEN}`);
    globalThis.history.replaceState(null, '', `/join#t=${TOKEN}`);
    expect(captureInvitationToken(store, JOIN)).toBe(TOKEN);
    expect(globalThis.location.hash).toBe('');
    expect(store.data.get(JOIN_KEY)).toBe(TOKEN);
    expect(store.data.get(INVITATION_KEY)).toBeUndefined();
    expect(pendingInvitationToken(store, JOIN)).toBe(TOKEN);
    expect(pendingInvitationToken(store)).toBeUndefined();
  });
});

describe('deciding whether to join (ADR-0093)', () => {
  it('shows the account and the role, and joins only when the person accepts', async () => {
    const { client, calls } = fake();
    show(client);
    expect(await screen.findByText(/Partner A \(Partner\) invites you to join/)).toBeTruthy();
    expect(calls.map((c) => c[0])).toEqual(['lookup']);
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    expect(await screen.findByText(/You are now part of the account/)).toBeTruthy();
    expect(calls.at(-1)).toEqual(['accept', TOKEN, LOOKUP.invitation.updatedAt]);
  });

  it('declines only after confirming', async () => {
    const { client, calls } = fake();
    const confirm = vi
      .spyOn(globalThis, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    show(client);
    const decline = await screen.findByRole('button', { name: 'Decline' });
    fireEvent.click(decline);
    expect(calls.map((c) => c[0])).toEqual(['lookup']);
    fireEvent.click(decline);
    expect(await screen.findByText('Declined. You did not join.')).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(calls.at(-1)).toEqual(['reject', TOKEN, LOOKUP.invitation.updatedAt]);
  });

  it('says why it cannot join: another email, a closed invitation, a full or inactive account', async () => {
    const signOut = vi.fn();
    show(fake({ ...LOOKUP, person: 'not_invited_person' }).client, signOut);
    expect(await screen.findByText(/sent to another email/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalled();
    cleanup();
    show(fake({ ...LOOKUP, invitation: { ...LOOKUP.invitation, status: 'revoked' } }).client);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Join' })).toBeNull();
    cleanup();
    show(fake(LOOKUP, new InvitationRequestError(409, 'commercial_limit_reached')).client);
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    expect(await screen.findByText(/cannot take more people/)).toBeTruthy();
    cleanup();
    show(fake(LOOKUP, new InvitationRequestError(409, 'commercial_account_inactive')).client);
    fireEvent.click(await screen.findByRole('button', { name: 'Join' }));
    expect(await screen.findByText(/not active right now/)).toBeTruthy();
    cleanup();
    show(fake(new InvitationRequestError(404, 'invitation_not_found')).client);
    expect(await screen.findByText(/link is incomplete/)).toBeTruthy();
  });
});
