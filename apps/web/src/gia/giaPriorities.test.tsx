import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { prioritiesOf } from './giaClient.js';

afterEach(cleanup);

function open(priorities: unknown) {
  globalThis.history.replaceState(null, '', '/gia');
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.gia = {
    answer: 'Atiende primero el seguimiento a Juan: venció hace 2 días.',
    department: 'sales',
    screen: null,
    proposedAction: null,
    proposedFacts: 0,
    links: [],
    proposedFollowUp: null,
    proposedAgentTask: null,
    priorities,
    context: { facts: 1, activity: true, commercial: true, missing: [] },
    replayed: false,
    generatedBy: 'ai',
  };
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

/** The Decision Engine's ranking as the API returns it with GIA's answer (ADR-0065). */
const RANKING = {
  decisionId: `dec_${'a'.repeat(32)}`,
  items: [
    {
      priority: 'high',
      outcome: 'follow_up_required',
      reasons: [
        { code: 'follow_up_overdue', params: { days: 2, title: 'Llamar a Juan' } },
        {
          code: 'open_opportunity',
          params: { title: 'Equipos', amountMinor: 1_200_000, currency: 'PEN' },
        },
      ],
      link: { kind: 'follow_up', id: 'fu_1', label: 'Llamar a Juan' },
      recommendedAction: { code: 'contact_customer', action: null },
      requiredApproval: false,
    },
    {
      priority: 'low',
      outcome: 'lead_without_follow_up',
      reasons: [{ code: 'lead_without_follow_up', params: { days: 1 } }],
      link: { kind: 'contact', id: 'contact_ana', label: 'Ana' },
      recommendedAction: { code: 'schedule_follow_up', action: 'follow_up.schedule' },
      requiredApproval: true,
    },
  ],
};

async function ask() {
  const chat = await screen.findByRole('region', { name: 'Talk to GIA' });
  fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
    target: { value: '¿Qué debería atender primero hoy?' },
  });
  fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
  return within(chat);
}

describe('GIA shows what to attend to first, as the Decision Engine ranked it', () => {
  it('shows each decision with its reason, data, link and next step, and runs nothing', async () => {
    const backend = open(RANKING);
    const chat = await ask();
    const list = await chat.findByRole('region', { name: 'What to attend to first' });
    const items = within(list)
      .getAllByRole('listitem')
      .filter((li) => li.tagName === 'LI');
    expect(within(list).getByText('Follow-up required', { exact: false })).toBeTruthy();
    expect(within(list).getByText('High priority')).toBeTruthy();
    expect(within(list).getByText('“Llamar a Juan” was due 2 days ago')).toBeTruthy();
    expect(
      within(list).getByText(/About the open sale “Equipos” · Value: PEN\s?12,000\.00/),
    ).toBeTruthy();
    expect(within(list).getByText('Next step: contact the customer')).toBeTruthy();
    // The second item needs approval, and says so.
    expect(within(list).getByText('· Requires approval')).toBeTruthy();
    expect(within(list).getByText('Next step: schedule a follow-up')).toBeTruthy();
    expect(items.length).toBeGreaterThanOrEqual(2);
    // Its link opens the record; nothing was posted besides the question.
    const posts = backend.apiCalls().filter((c) => c.method === 'POST');
    expect(posts.every((c) => c.url.endsWith('/gia/messages'))).toBe(true);
  });

  it('shows nothing when the answer is not about a ranking', async () => {
    open(null);
    const chat = await ask();
    expect(
      await chat.findByText('Atiende primero el seguimiento a Juan: venció hace 2 días.'),
    ).toBeTruthy();
    expect(chat.queryByRole('region', { name: 'What to attend to first' })).toBeNull();
  });

  it('keeps only well-formed items and codes from the API', () => {
    expect(
      prioritiesOf({ items: [{ outcome: 'Bad Code' }, 'x', { outcome: 'closing_soon' }] }),
    ).toEqual([
      {
        priority: null,
        outcome: 'closing_soon',
        reasons: [],
        link: null,
        nextStep: null,
        requiredApproval: false,
      },
    ]);
    expect(prioritiesOf(null)).toEqual([]);
  });
});
