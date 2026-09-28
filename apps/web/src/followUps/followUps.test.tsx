import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { followUpErrorKey } from './FollowUps.js';
import { FollowUpRequestError } from './followUpsClient.js';

afterEach(cleanup);

const MANAGE = ['contact.manage', 'follow_up.read', 'follow_up.manage'];

function open(at: string, configure?: (backend: ReturnType<typeof fakeBackend>) => void) {
  globalThis.history.replaceState(null, '', at);
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push(...MANAGE);
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const followUp = (id: string, when: string, extra: Record<string, unknown> = {}) => ({
  id,
  contactId: 'contact_1',
  contactName: 'Juan Pérez',
  opportunityId: null,
  assignee: 'you',
  type: 'call',
  title: `Call ${id}`,
  description: null,
  scheduledAt: '2026-09-28T15:00:00.000Z',
  timeZone: 'America/Lima',
  date: '2026-09-28',
  time: '10:00',
  when,
  days: 0,
  status: 'scheduled',
  source: 'manual',
  cancelReason: null,
  failure: null,
  revision: 1,
  ...extra,
});

const posts = (backend: ReturnType<typeof fakeBackend>, suffix: string) =>
  backend
    .apiCalls()
    .filter((c) => c.method === 'POST' && c.url.includes('/follow-ups') && c.url.endsWith(suffix))
    .map((c) => JSON.parse(String(c.body)) as Record<string, unknown>);

describe('follow-ups in the Comercial office (C5)', () => {
  it('lists what is overdue and due today, and marks one done', async () => {
    const backend = open('/office/sales', (b) => {
      b.options.followUps.org_1 = [
        followUp('f1', 'overdue', { date: '2026-09-27', status: 'due' }),
        followUp('f2', 'today'),
        followUp('f3', 'upcoming', { source: 'gia', date: '2026-09-30' }),
      ];
    });
    const region = await screen.findByRole('region', { name: 'Follow-ups' });
    expect(await within(region).findByRole('heading', { name: /Overdue/ })).toBeTruthy();
    expect(within(region).getByRole('heading', { name: /Today/ })).toBeTruthy();
    const overdue = within(within(region).getByRole('listitem', { name: 'Call f1' }));
    expect(overdue.getByText(/Due now/)).toBeTruthy();
    expect(overdue.getByRole('link', { name: 'Juan Pérez' }).getAttribute('href')).toBe(
      '/office/sales?contact=contact_1',
    );
    expect(within(region).getByRole('listitem', { name: 'Call f3' }).textContent).toContain(
      'Suggested by GIA',
    );
    fireEvent.click(overdue.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(within(region).queryByRole('listitem', { name: 'Call f1' })).toBeNull(),
    );
    expect(posts(backend, '/f1/complete')).toEqual([{ revision: 1 }]);
  });

  it('says there are none, and only a role that may read them sees them', async () => {
    open('/office/sales');
    const region = await screen.findByRole('region', { name: 'Follow-ups' });
    expect(await within(region).findByText('No pending follow-ups.')).toBeTruthy();
    cleanup();
    open('/office/sales', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => !p.startsWith('follow_up.'));
    });
    await screen.findByRole('region', { name: 'Customers and leads' });
    expect(screen.queryByRole('region', { name: 'Follow-ups' })).toBeNull();
  });

  it('schedules one from a contact: the time is required, never filled in', async () => {
    const backend = open('/office/sales?contact=contact_1', (b) => {
      b.options.customers.org_1 = [
        {
          id: 'contact_1',
          displayName: 'Juan Pérez',
          phone: '+51987111222',
          email: null,
          origin: 'user',
          revision: 1,
          commercial: {
            stage: 'lead',
            owner: null,
            source: 'manual',
            consent: 'unknown',
            consentAt: null,
            nextAction: { text: 'Call f9', dueOn: '2026-09-29', followUpId: 'f9' },
            stageChangedAt: '2026-09-28T12:00:00Z',
          },
          createdAt: '2026-09-28T12:00:00Z',
          updatedAt: '2026-09-28T12:00:00Z',
        },
      ];
    });
    const card = within(await screen.findByRole('article'));
    // Its next action comes from a follow-up: shown, not edited here.
    expect(await card.findByText(/from a scheduled follow-up/)).toBeTruthy();
    const upcoming = within(await card.findByRole('region', { name: 'Upcoming follow-ups' }));
    fireEvent.click(await upcoming.findByRole('button', { name: 'Schedule a follow-up' }));
    fireEvent.change(upcoming.getByLabelText('What to do'), { target: { value: 'Llamar a Juan' } });
    fireEvent.change(upcoming.getByLabelText('Day'), { target: { value: '2026-09-29' } });
    const schedule = upcoming.getByRole('button', { name: 'Schedule' });
    expect(schedule.matches(':disabled')).toBe(true);
    expect(upcoming.getByText('What time? Write the time to schedule it.')).toBeTruthy();
    fireEvent.change(upcoming.getByLabelText('Time'), { target: { value: '10:00' } });
    fireEvent.click(schedule);
    expect(await upcoming.findByRole('listitem', { name: 'Llamar a Juan' })).toBeTruthy();
    expect(posts(backend, '/follow-ups')).toEqual([
      {
        requestKey: expect.any(String),
        contactId: 'contact_1',
        type: 'follow_up',
        title: 'Llamar a Juan',
        date: '2026-09-29',
        time: '10:00',
        source: 'manual',
      },
    ]);
  });

  it('names each refusal in words', () => {
    const error = (code: string, field?: string) => new FollowUpRequestError(409, code, field);
    expect(followUpErrorKey(error('invalid_request', 'date_in_past'))).toBe(
      'followUps.error.field.date_in_past',
    );
    expect(followUpErrorKey(error('invalid_request', 'other'))).toBe(
      'followUps.error.invalid_request',
    );
    expect(followUpErrorKey(error('follow_up_limit_reached'))).toBe(
      'followUps.error.follow_up_limit_reached',
    );
    expect(followUpErrorKey(error('something_new'))).toBe('followUps.error.generic');
    expect(followUpErrorKey(new Error('x'))).toBe('followUps.error.generic');
  });
});

describe("GIA's follow-up proposal (C5)", () => {
  const answer = (proposal: Record<string, unknown> | null) => ({
    answer: 'Te preparé el seguimiento. Confírmalo para programarlo.',
    department: 'sales',
    screen: null,
    proposedAction: null,
    proposedFacts: 0,
    links: [],
    proposedFollowUp: proposal,
    context: { facts: 1, activity: true, commercial: true, missing: [] },
    replayed: false,
    generatedBy: 'ai',
  });
  const proposal = {
    contactId: 'contact_1',
    contactLabel: 'Juan Pérez',
    opportunityId: null,
    opportunityLabel: null,
    type: 'call',
    title: 'Llamar a Juan',
    date: '2026-09-29',
    time: null,
    timeZone: 'America/Lima',
  };
  async function ask() {
    const chat = await screen.findByRole('region', { name: 'Talk to GIA' });
    fireEvent.change(within(chat).getByRole('textbox', { name: 'Your message to GIA' }), {
      target: { value: 'Recuérdame llamar a Juan mañana' },
    });
    fireEvent.click(within(chat).getByRole('button', { name: 'Send' }));
    return within(chat);
  }

  it('asks for the time, schedules only when the person confirms, and says so after', async () => {
    const backend = open('/gia', (b) => {
      b.options.gia = answer(proposal);
    });
    const chat = await ask();
    expect(
      await chat.findByText(
        'I prepared this follow-up for Juan Pérez. Nothing is scheduled until you confirm it.',
      ),
    ).toBeTruthy();
    // Nothing scheduled yet, and no time was invented.
    expect(posts(backend, '/follow-ups')).toEqual([]);
    expect((chat.getByLabelText('Time') as HTMLInputElement).value).toBe('');
    const confirm = chat.getByRole('button', { name: 'Confirm and schedule' });
    expect(confirm.matches(':disabled')).toBe(true);
    fireEvent.change(chat.getByLabelText('Time'), { target: { value: '10:00' } });
    fireEvent.click(confirm);
    expect(await chat.findByText(/Scheduled: Llamar a Juan, 2026-09-29 at 10:00\./)).toBeTruthy();
    expect(posts(backend, '/follow-ups')).toEqual([
      expect.objectContaining({
        contactId: 'contact_1',
        type: 'call',
        time: '10:00',
        source: 'gia',
      }),
    ]);
  });

  it('never says it scheduled what the API refused, and a discard schedules nothing', async () => {
    const backend = open('/gia', (b) => {
      b.options.gia = answer({ ...proposal, time: '10:00' });
      b.options.followUpFails = { error: 'follow_up_not_scheduled', status: 503 };
    });
    const chat = await ask();
    fireEvent.click(await chat.findByRole('button', { name: 'Confirm and schedule' }));
    expect(await chat.findByRole('alert')).toBeTruthy();
    expect(chat.queryByText(/Scheduled:/)).toBeNull();
    fireEvent.click(chat.getByRole('button', { name: 'Discard' }));
    expect(await chat.findByText('Follow-up discarded. Nothing was scheduled.')).toBeTruthy();
    expect(backend.options.followUps.org_1 ?? []).toEqual([]);
  });

  it('tells a role that may not schedule follow-ups, with no form', async () => {
    open('/gia', (b) => {
      b.options.permissions = b.options.permissions.filter((p) => p !== 'follow_up.manage');
      b.options.gia = answer(proposal);
    });
    const chat = await ask();
    expect(await chat.findByText('Your role cannot schedule follow-ups.')).toBeTruthy();
    expect(chat.queryByRole('button', { name: 'Confirm and schedule' })).toBeNull();
  });
});
