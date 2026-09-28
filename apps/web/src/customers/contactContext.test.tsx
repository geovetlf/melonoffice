import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

afterEach(cleanup);

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push('contact.manage', 'opportunity.read');
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

/** The contact of the fake inbox's conversation `c1`, as Comercial knows it. */
const juan = {
  id: 'contact-c1',
  displayName: 'Juan Pérez',
  phone: '+51987111222',
  email: null,
  origin: 'channel',
  revision: 2,
  commercial: {
    stage: 'customer',
    owner: 'you',
    source: 'channel',
    consent: 'unknown',
    consentAt: null,
    nextAction: { text: 'Send the quote', dueOn: '2020-01-02' },
    stageChangedAt: '2026-09-28T12:00:00Z',
  },
  createdAt: '2026-09-28T12:00:00Z',
  updatedAt: '2026-09-28T12:00:00Z',
};

const context = {
  conversations: [
    { id: 'c1', channel: 'whatsapp', status: 'open', lastMessageAt: '2026-09-28T15:00:00Z' },
  ],
  opportunities: [
    {
      id: 'o1',
      title: 'Birthday dinner',
      status: 'open',
      value: { amountMinor: 150050, currency: 'PEN' },
      probability: 50,
      owner: 'you',
      expectedCloseOn: '2026-10-15',
      nextAction: null,
      lostReason: null,
      stage: { id: 'quote', kind: 'open', name: null, nameKey: 'pipeline.stage.quote' },
      updatedAt: '2026-09-28T14:00:00Z',
    },
    {
      id: 'o2',
      title: 'Company lunch',
      status: 'lost',
      value: null,
      probability: 0,
      owner: null,
      expectedCloseOn: null,
      nextAction: null,
      lostReason: 'price',
      stage: { id: 'lost', kind: 'lost', name: null, nameKey: 'pipeline.stage.lost' },
      updatedAt: '2026-09-28T13:00:00Z',
    },
  ],
  history: [
    {
      id: 'e2',
      at: '2026-09-28T14:00:00Z',
      action: 'opportunity.created',
      transition: { from: 'none', to: 'quote' },
      reason: null,
      actor: 'you',
      opportunityId: 'o1',
    },
    {
      id: 'e1',
      at: '2026-09-28T13:00:00Z',
      action: 'contact.stage_changed',
      transition: { from: 'lead', to: 'customer' },
      reason: null,
      actor: 'member',
      opportunityId: null,
    },
  ],
};

describe("a contact's commercial context (C3)", () => {
  it('opens the card from a link and shows conversations, opportunities and history', async () => {
    open('/office/sales?contact=contact-c1', (b) => {
      b.options.customers.org_1 = [juan];
      b.options.contactContext['contact-c1'] = context;
    });
    const card = within(await screen.findByRole('article', { name: 'Juan Pérez' }));
    const conversations = within(await card.findByRole('region', { name: 'Conversations' }));
    const link = conversations.getByRole('link', { name: /WhatsApp · Open/ });
    expect(link.getAttribute('href')).toBe('/conversations?c=c1');

    const opportunities = within(card.getByRole('region', { name: 'Opportunities' }));
    const birthday = within(opportunities.getByRole('listitem', { name: 'Birthday dinner' }));
    expect(birthday.getByText(/Quote/)).toBeTruthy();
    expect(birthday.getByText(/1,500\.50/)).toBeTruthy();
    expect(birthday.getByText(/50% likely/)).toBeTruthy();
    const lunch = within(opportunities.getByRole('listitem', { name: 'Company lunch' }));
    expect(lunch.getByText(/Lost/)).toBeTruthy();
    expect(lunch.getByText(/Price/)).toBeTruthy();

    const history = within(card.getByRole('region', { name: 'History' }));
    expect(history.getByText(/Opened · Birthday dinner/)).toBeTruthy();
    expect(history.getByText(/Stage changed \(Lead → Customer\)/)).toBeTruthy();
  });

  it('says a part is hidden when the role may not read it, instead of "none"', async () => {
    open('/office/sales?contact=contact-c1', (b) => {
      b.options.customers.org_1 = [juan];
      b.options.contactContext['contact-c1'] = {
        conversations: null,
        opportunities: null,
        history: [],
      };
    });
    const card = within(await screen.findByRole('article', { name: 'Juan Pérez' }));
    expect(await card.findByText('Your role cannot read conversations.')).toBeTruthy();
    expect(card.getByText('Your role cannot see opportunities.')).toBeTruthy();
  });

  it('shows the commercial context beside a conversation, with a link to the card', async () => {
    open('/conversations?c=c1', (b) => {
      b.options.customers.org_1 = [juan];
      b.options.contactContext['contact-c1'] = context;
    });
    const summary = within(await screen.findByRole('region', { name: 'Commercial context' }));
    expect(summary.getByText('Customer')).toBeTruthy();
    expect(summary.getByText(/Overdue/)).toBeTruthy();
    expect(summary.getByText(/Send the quote/)).toBeTruthy();
    // Only the open opportunity: the lost one stays on the card.
    expect(summary.getByText(/Birthday dinner/)).toBeTruthy();
    expect(summary.queryByText(/Company lunch/)).toBeNull();
    const link = summary.getByRole('link', { name: 'Open the full card in Comercial' });
    expect(link.getAttribute('href')).toBe('/office/sales?contact=contact-c1');
    fireEvent.click(link);
    expect(globalThis.location.pathname + globalThis.location.search).toBe(
      '/office/sales?contact=contact-c1',
    );
  });

  it('shows no commercial context to a role that may not read contacts', async () => {
    open('/conversations?c=c1', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => !p.startsWith('contact.'));
      b.options.customers.org_1 = [juan];
    });
    expect(await screen.findByRole('heading', { name: 'Juan Pérez', level: 2 })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Commercial context' })).toBeNull();
  });
});
