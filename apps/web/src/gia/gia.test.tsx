import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
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

describe("GIA's Workplace (ADR-0050)", () => {
  it('is entered from the Home through GIA, with her face', async () => {
    open('/');
    await screen.findByRole('heading', { level: 1 });
    const card = document.querySelector<HTMLAnchorElement>('a.gia-card');
    if (card === null) throw new Error('no GIA card');
    expect(card.querySelector('svg.gia-avatar')).toBeTruthy();
    fireEvent.click(card);
    const title = await screen.findByRole('heading', { level: 1, name: 'GIA' });
    expect(globalThis.location.pathname).toBe('/gia');
    // Keyboard users land on the page's title.
    expect(document.activeElement).toBe(title);
  });

  it('shows her desk, state, capabilities and limits, without simulating anything', async () => {
    open('/gia');
    await screen.findByRole('heading', { level: 1, name: 'GIA' });
    expect(screen.getByRole('figure', { name: "GIA's desk" })).toBeTruthy();
    expect(screen.getByText('Available: ask GIA about your business')).toBeTruthy();
    const capabilities = screen.getByRole('region', { name: 'What GIA does' });
    expect(within(capabilities).queryByText('Soon')).toBeNull();
    expect(within(capabilities).getByText('Send messages to customers')).toBeTruthy();
    expect(
      within(capabilities).getByText(
        'What you tell GIA about your business is kept only as a proposal until you confirm it.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Actions' }).textContent).toContain(
      'Nothing runs without your approval.',
    );
  });

  it("shows only GIA's own history, or says there is none", async () => {
    open('/gia', (backend) => {
      backend.options.activity.org_1 = [
        {
          id: 'e1',
          at: new Date().toISOString(),
          action: 'organization.profile_updated',
          result: 'success',
          actor: 'you',
        },
      ];
    });
    const history = await screen.findByRole('region', { name: "GIA's history" });
    expect(
      await within(history).findByText('GIA has not done anything yet in this period.'),
    ).toBeTruthy();
    expect(within(history).queryByText('The business profile was updated')).toBeNull();
    cleanup();
    open('/gia', (backend) => {
      backend.options.activity.org_1 = [
        {
          id: 'e2',
          at: new Date().toISOString(),
          action: 'conversation.ai_summary_requested',
          result: 'success',
          actor: 'gia',
          link: { kind: 'conversation', id: 'c1' },
        },
      ];
    });
    const again = await screen.findByRole('region', { name: "GIA's history" });
    expect(
      await within(again).findByRole('link', { name: /A conversation summary was requested/ }),
    ).toBeTruthy();
  });

  it('answers in her chat, marked as AI, with where to go and what to confirm (ADR-0052)', async () => {
    const backend = open('/gia', (b) => {
      b.options.gia = {
        answer: 'Tienes un mensaje nuevo de un cliente.',
        department: 'sales',
        screen: 'conversations',
        proposedAction: 'Responder al cliente',
        proposedFacts: 1,
        context: { facts: 2, activity: true, missing: [] },
        replayed: false,
        generatedBy: 'ai',
      };
    });
    const chat = await screen.findByRole('region', { name: 'Talk to GIA' });
    expect(
      within(chat).getByText('Each message to GIA uses 1 credit.', { exact: false }),
    ).toBeTruthy();
    fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: '¿Algo nuevo?' },
    });
    fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
    expect(await within(chat).findByText('Tienes un mensaje nuevo de un cliente.')).toBeTruthy();
    expect(within(chat).getByText('This is for Commercial.')).toBeTruthy();
    expect(within(chat).getByText('Suggestion (you do it): Responder al cliente')).toBeTruthy();
    expect(
      within(chat).getByText('GIA noted 1 fact about your business for you to confirm.', {
        exact: false,
      }),
    ).toBeTruthy();
    // They wait in the company memory, where a person confirms them (ADR-0056).
    expect(
      within(chat).getByRole('link', { name: 'Review in Company memory' }).getAttribute('href'),
    ).toBe('/memory');
    expect(within(chat).getByText('Answer generated by AI. Check it before you act.')).toBeTruthy();
    const go = within(chat).getByRole('link', { name: 'Go to Communications' });
    expect(go.getAttribute('href')).toBe('/conversations');

    // The next message carries the chat so far; nothing else is sent.
    fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: '¿Y ayer?' },
    });
    fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
    await within(chat).findAllByText('Tienes un mensaje nuevo de un cliente.');
    const sent = backend
      .apiCalls()
      .filter((c) => c.url.endsWith('/gia/messages'))
      .map((c) => JSON.parse(c.body ?? '{}') as { history: unknown[]; requestKey: string });
    expect(sent[1]?.history).toEqual([
      { role: 'person', text: '¿Algo nuevo?' },
      { role: 'gia', text: 'Tienes un mensaje nuevo de un cliente.' },
    ]);
    expect(sent[0]?.requestKey).not.toBe(sent[1]?.requestKey);
  });

  it('offers to add what she does not know yet to the company memory (ADR-0056)', async () => {
    open('/gia', (b) => {
      b.options.gia = {
        answer: 'Todavía no tengo registrados tus horarios de atención. ¿Cuáles son?',
        department: null,
        screen: 'business_profile',
        proposedAction: null,
        proposedFacts: 0,
        context: { facts: 2, activity: false, missing: ['areas'] },
        replayed: false,
        generatedBy: 'ai',
      };
    });
    const chat = await screen.findByRole('region', { name: 'Talk to GIA' });
    fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: 'Hola' },
    });
    fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
    const add = await within(chat).findByRole('link', { name: 'Add to Company memory' });
    expect(add.getAttribute('href')).toBe('/memory');
  });

  it('says plainly when there are no credits, or the role cannot talk to her', async () => {
    open('/gia', (b) => {
      b.options.gia = { error: 'ai_credits_insufficient', status: 409 };
    });
    const chat = await screen.findByRole('region', { name: 'Talk to GIA' });
    fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: 'Hola' },
    });
    fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
    expect((await within(chat).findByRole('alert')).textContent).toBe(
      'Your organization has no credits left for GIA.',
    );
    cleanup();
    open('/gia', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'gia.ask');
    });
    const none = await screen.findByRole('region', { name: 'Talk to GIA' });
    expect(within(none).queryByRole('textbox')).toBeNull();
    expect(within(none).getByText('Your role cannot talk to GIA.')).toBeTruthy();
  });

  it('keeps the avatar decorative where her name is written, and named where it is alone', async () => {
    open('/gia');
    await screen.findByRole('heading', { level: 1, name: 'GIA' });
    for (const svg of document.querySelectorAll('.gia-workplace svg.gia-avatar')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('links an answer about sales to the real records in Comercial, and changes nothing (C4)', async () => {
    const backend = open('/gia', (b) => {
      b.options.permissions.push('opportunity.read');
      b.options.opportunities.org_1 = [
        {
          id: 'opp_boda',
          contactId: 'contact_1',
          contactName: 'Ana',
          stageId: 'proposal',
          status: 'open',
          title: 'Catering boda',
          value: { amountMinor: 1_200_000, currency: 'PEN' },
          probability: 50,
          owner: null,
          expectedCloseOn: null,
          nextAction: { text: 'Enviar cotización', dueOn: '2026-09-25' },
          lostReason: null,
          closedAt: null,
          revision: 1,
          updatedAt: '2026-09-28T12:00:00Z',
        },
      ];
      b.options.gia = {
        answer:
          'Hoy atiende primero Catering boda (S/ 12,000.00): la próxima acción venció hace 3 días.',
        department: 'sales',
        screen: null,
        proposedAction: 'Enviar la cotización desde Comercial',
        proposedFacts: 0,
        links: [
          { kind: 'opportunity', id: 'opp_boda', label: 'Catering boda' },
          { kind: 'leads' },
          { kind: 'pipeline' },
          { kind: 'contact', id: 'contact_1', label: 'Ana' },
          // Not a link the app knows: never shown.
          { kind: 'campaign', id: 'x' },
        ],
        context: { facts: 1, activity: true, commercial: true, missing: [] },
        replayed: false,
        generatedBy: 'ai',
      };
    });
    const chat = await screen.findByRole('region', { name: 'Talk to GIA' });
    fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: '¿Qué debería atender hoy?' },
    });
    fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
    const links = within(await within(chat).findByRole('list', { name: 'Where to see it' }));
    expect(links.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['See opportunity: Catering boda', '/office/sales?opportunity=opp_boda'],
      ['See leads', '/office/sales?stage=lead'],
      ['See pipeline', '/office/sales?view=pipeline'],
      ['See contact: Ana', '/office/sales?contact=contact_1'],
    ]);

    // The link opens that opportunity's card in the Comercial office.
    fireEvent.click(links.getByRole('link', { name: 'See opportunity: Catering boda' }));
    const region = await screen.findByRole('region', { name: 'Opportunities' });
    const card = within(await within(region).findByRole('article'));
    expect(await card.findByText('Catering boda', { exact: false })).toBeTruthy();
    // Reading and following links wrote nothing.
    expect(
      backend.apiCalls().filter((c) => c.method !== 'GET' && !c.url.endsWith('/gia/messages')),
    ).toEqual([]);
  });

  it('opens the leads tab from GIA’s link (C4)', async () => {
    open('/office/sales?stage=customer', (b) => {
      b.options.permissions.push('opportunity.read');
    });
    const region = await screen.findByRole('region', { name: 'Customers and leads' });
    expect(
      (await within(region).findByRole('tab', { name: /Customers/ })).getAttribute('aria-selected'),
    ).toBe('true');
  });
});
