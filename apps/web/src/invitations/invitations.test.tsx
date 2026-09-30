import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import {
  createIdentityClient,
  IdentityError,
  SEND_CODE_URL,
  SIGN_UP_URL,
} from '../identity/identityPlatform.js';
import { createServices } from '../identity/services.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { InvitationDecision } from './InvitePage.js';
import {
  captureInvitationToken,
  clearInvitationToken,
  INVITATION_KEY,
  invitationLink,
  pendingInvitationToken,
} from './invitationToken.js';
import {
  InvitationRequestError,
  type InvitationLookup,
  type InvitationsClient,
} from './invitationsClient.js';

const TOKEN = 'a'.repeat(40) + '_-9';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearInvitationToken();
});
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const LOOKUP: InvitationLookup = {
  invitation: {
    account: { name: 'Partner A', type: 'partner' },
    mode: 'reseller',
    scopes: ['summary', 'usage', 'knowledge'],
    status: 'pending',
    expiresAt: '2026-10-07T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
  },
  person: 'invited',
  organization: { id: 'org_1', canDecide: true },
};

function fake(lookup: InvitationLookup | Error = LOOKUP) {
  const calls: unknown[][] = [];
  const client: InvitationsClient = {
    lookup: async (token) => {
      calls.push(['lookup', token]);
      if (lookup instanceof Error) throw lookup;
      return lookup;
    },
    accept: async (token, scopes, version) => {
      calls.push(['accept', token, scopes, version]);
      return {
        status:
          lookup instanceof Error ||
          lookup.organization === null ||
          lookup.organization === 'ambiguous' ||
          !lookup.organization.canDecide
            ? 'pending'
            : 'active',
      };
    },
    reject: async (token, version) => {
      calls.push(['reject', token, version]);
    },
  };
  return { client, calls };
}

const show = (client: InvitationsClient, onSignOut = vi.fn()) =>
  render(
    <I18nProvider locale="en">
      <InvitationDecision client={client} token={TOKEN} onSignOut={onSignOut} />
    </I18nProvider>,
  );

describe('the invitation link (ADR-0089)', () => {
  it('keeps the secret out of the address bar and only for this tab', () => {
    const store = memoryStore();
    expect(invitationLink('https://app.example', TOKEN)).toBe(
      `https://app.example/invite#t=${TOKEN}`,
    );
    globalThis.history.replaceState(null, '', `/invite#t=${TOKEN}`);
    expect(captureInvitationToken(store)).toBe(TOKEN);
    expect(globalThis.location.hash).toBe('');
    expect(globalThis.location.pathname).toBe('/invite');
    expect(store.data.get(INVITATION_KEY)).toBe(TOKEN);
    expect(pendingInvitationToken(store)).toBe(TOKEN);
    // A malformed fragment is ignored; a malformed stored value is not used.
    globalThis.history.replaceState(null, '', '/invite#t=short');
    store.setItem(INVITATION_KEY, 'short');
    expect(captureInvitationToken(store)).toBeUndefined();
  });
});

describe('deciding on an invitation (ADR-0089)', () => {
  it('an owner grants only what they tick, nothing by default', async () => {
    const { client, calls } = fake();
    show(client);
    expect(await screen.findByText(/Partner A \(Partner\) invites your company/)).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, false, false]);
    expect(screen.getByText("(your company's own content)")).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /name, status and plan/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(await screen.findByText(/It sees only what you ticked/)).toBeTruthy();
    expect(calls.at(-1)).toEqual(['accept', TOKEN, ['summary'], LOOKUP.invitation.updatedAt]);
  });

  it('a member who is not the owner sends it to the owner, choosing nothing', async () => {
    const { client, calls } = fake({ ...LOOKUP, organization: { id: 'org_1', canDecide: false } });
    show(client);
    fireEvent.click(await screen.findByRole('button', { name: 'Send to my owner' }));
    expect(await screen.findByText(/Sent to your company's owner/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(calls.at(-1)).toEqual(['accept', TOKEN, [], LOOKUP.invitation.updatedAt]);
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
    expect(await screen.findByText('Declined. Nothing was shared.')).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(calls.at(-1)).toEqual(['reject', TOKEN, LOOKUP.invitation.updatedAt]);
  });

  it('says why it cannot be answered: another email, a closed invitation, a bad link', async () => {
    const signOut = vi.fn();
    show(fake({ ...LOOKUP, person: 'not_invited_person', organization: null }).client, signOut);
    expect(await screen.findByText(/sent to another email/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalled();
    cleanup();
    show(fake({ ...LOOKUP, invitation: { ...LOOKUP.invitation, status: 'expired' } }).client);
    expect(await screen.findByText(/This invitation expired/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    cleanup();
    show(fake(new InvitationRequestError(404, 'invitation_not_found')).client);
    expect(await screen.findByText(/link is incomplete/)).toBeTruthy();
  });
});

describe('an invited person without a session (ADR-0089)', () => {
  function start() {
    globalThis.history.replaceState(null, '', `/invite#t=${TOKEN}`);
    const backend = fakeBackend();
    const identityCalls: { url: string; body: string }[] = [];
    const invitationCalls: string[] = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      const body = typeof init.body === 'string' ? init.body : '';
      if (url === `${SIGN_UP_URL}?key=${KEY}` || url === `${SEND_CODE_URL}?key=${KEY}`) {
        identityCalls.push({ url, body });
        backend.options.validTokens.add('id-new');
        backend.options.validRefresh.add('refresh-new');
        return Response.json(
          url.startsWith(SIGN_UP_URL)
            ? { idToken: 'id-new', refreshToken: 'refresh-new', expiresIn: '3600' }
            : { email: 'ana@example.com' },
        );
      }
      if (url.startsWith(`${API}/v1/invitations/`)) {
        const action = url.slice(`${API}/v1/invitations/`.length);
        invitationCalls.push(`${action} ${body}`);
        return action === 'lookup'
          ? Response.json(LOOKUP)
          : Response.json({ relationship: { status: 'active' } });
      }
      return backend.fetch(input, init);
    };
    const services = createServices({ apiUrl: API, identityApiKey: KEY }, fetcher, memoryStore());
    render(
      <I18nProvider locale="en">
        <App identity={services} locale="en" onLocaleChange={vi.fn()} />
      </I18nProvider>,
    );
    return { identityCalls, invitationCalls };
  }

  it('signs in, comes back to the invitation and accepts it', async () => {
    const { invitationCalls } = start();
    fireEvent.click(await screen.findByRole('button', { name: 'I have an account: sign in' }));
    expect(globalThis.location.pathname).toBe('/login');
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ana@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(globalThis.location.pathname).toBe('/invite'));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText(/It sees only what you ticked/)).toBeTruthy();
    expect(invitationCalls[0]).toBe(`lookup {"token":"${TOKEN}"}`);
    expect(invitationCalls[1]).toContain('"scopes":[]');
    // Taken: the secret is gone from this tab.
    expect(pendingInvitationToken()).toBeUndefined();
  });

  it('creates the account and asks Identity Platform to verify its email', async () => {
    const { identityCalls } = start();
    fireEvent.change(await screen.findByLabelText('Email'), {
      target: { value: 'ana@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-new-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(identityCalls.map((c) => c.url.split('?')[0])).toEqual([SIGN_UP_URL, SEND_CODE_URL]);
    expect(JSON.parse(identityCalls[1]?.body ?? '{}')).toEqual({
      requestType: 'VERIFY_EMAIL',
      idToken: 'id-new',
    });
  });
});

describe('Identity Platform accounts (ADR-0089)', () => {
  it('signs up and explains a taken email or a weak password', async () => {
    const answers = [
      Response.json({ idToken: 'i', refreshToken: 'r', expiresIn: '3600' }),
      Response.json({ error: { message: 'EMAIL_EXISTS' } }, { status: 400 }),
      Response.json(
        { error: { message: 'WEAK_PASSWORD : Password should be at least 6 characters' } },
        { status: 400 },
      ),
    ];
    const client = createIdentityClient(
      KEY,
      async () => answers.shift() as Response,
      () => 0,
    );
    expect(await client.signUp('a@example.com', 'secret1')).toEqual({
      idToken: 'i',
      refreshToken: 'r',
      expiresAt: 3_600_000,
    });
    await expect(client.signUp('a@example.com', 'x')).rejects.toEqual(
      new IdentityError('email_exists'),
    );
    await expect(client.signUp('a@example.com', 'x')).rejects.toEqual(
      new IdentityError('weak_password'),
    );
  });
});
