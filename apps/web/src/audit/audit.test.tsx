import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

/**
 * The audit history (ADR-0147): the API's events as it gives them, newest first, a page at a
 * time, with details on demand. Read only: the page offers nothing that changes an event.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const item = (id: string, at: string, extra: Record<string, unknown> = {}) => ({
  id,
  at,
  action: 'specialist.version_created',
  category: 'specialist',
  result: 'success',
  actor: { kind: 'you' },
  target: { type: 'specialist' },
  details: { version: 2 },
  ...extra,
});

const EVENTS = [
  item('e3', '2026-10-04T12:00:00.000Z', {
    action: 'plan.step_declined',
    category: 'planning',
    actor: { kind: 'agent', onBehalfOf: 'you' },
    target: { type: 'plan', link: { kind: 'plan', id: 'plan-1' } },
    details: { reason: 'rejected', step: 'campaign' },
  }),
  item('e2', '2026-10-04T11:00:00.000Z', {
    action: 'tool.approval_rejected',
    category: 'tool',
    actor: { kind: 'member' },
    target: { type: 'approval' },
    details: { tool: 'message_send' },
  }),
  item('e1', '2026-10-04T10:00:00.000Z', {
    action: 'authorization.check',
    category: 'authorization',
    result: 'denied',
    target: undefined,
    details: { permission: 'plan.create', reason: 'permission_not_granted' },
  }),
];

function open(
  configure?: (backend: ReturnType<typeof fakeBackend>) => void,
  permissions?: readonly string[],
) {
  globalThis.history.replaceState(null, '', '/audit');
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  if (permissions !== undefined) backend.options.permissions = [...permissions];
  backend.options.auditTrail = { org_1: EVENTS.map((e) => ({ ...e })) };
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const trailCalls = (backend: ReturnType<typeof fakeBackend>) =>
  backend.apiCalls().filter((c) => c.url.includes('/audit-trail'));

describe('The audit history (ADR-0147)', () => {
  it('lists events newest first with when, who, what, on what and how it ended', async () => {
    open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit history' })).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Audit history' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText(/A plan step was not approved/)).toBeTruthy();
    expect(within(rows[0] as HTMLElement).getByText(/An agent, for you/)).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText(/Another person in your company/)).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText('Refused')).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).getByRole('link', { name: /Audit history/ })).toBeTruthy();
  });

  it('shows an event’s details on demand, with what each code means', async () => {
    open();
    const list = await screen.findByRole('list', { name: 'Audit history' });
    const first = within(list).getAllByRole('listitem')[0] as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: 'Details' }));
    expect(within(first).getByText('rejected by a person')).toBeTruthy();
    expect(within(first).getByText('campaign')).toBeTruthy();
    expect(within(first).getByRole('link', { name: 'Plan' })).toBeTruthy();
    fireEvent.click(within(first).getByRole('button', { name: 'Hide details' }));
    expect(within(first).queryByText('rejected by a person')).toBeNull();
  });

  it('loads older events a page at a time with the API’s cursor', async () => {
    const backend = open((b) => {
      b.options.auditTrailPageSize = 2;
    });
    const list = await screen.findByRole('list', { name: 'Audit history' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Show older events' }));
    expect(await within(list).findByText(/A permission was checked/)).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Show older events' })).toBeNull();
    expect(trailCalls(backend).map((c) => new URL(c.url).searchParams.get('cursor'))).toEqual([
      null,
      '2',
    ]);
  });

  it('filters by type of event and days, as the server checks them', async () => {
    const backend = open();
    await screen.findByRole('list', { name: 'Audit history' });
    fireEvent.change(screen.getByLabelText('Type of event'), { target: { value: 'tool' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-10-04' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    const list = await screen.findByRole('list', { name: 'Audit history' });
    expect(await within(list).findByText('An approval was rejected')).toBeTruthy();
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    const last = trailCalls(backend).at(-1);
    const params = new URL(last?.url ?? API).searchParams;
    expect([params.get('category'), params.get('from'), params.get('to')]).toEqual([
      'tool',
      '2026-10-01',
      '2026-10-04',
    ]);
  });

  it('says when nothing was recorded', async () => {
    open((b) => {
      b.options.auditTrail = { org_1: [] };
    });
    expect(await screen.findByText('Nothing was recorded in these days.')).toBeTruthy();
  });

  it('says plainly what went wrong when the API refuses the days', async () => {
    open((b) => {
      b.options.auditTrailFails = { status: 400, error: 'invalid_period' };
    });
    expect(await screen.findByText(/Check the days/)).toBeTruthy();
  });

  it('offers nothing that changes or removes an event', async () => {
    const backend = open();
    await screen.findByRole('list', { name: 'Audit history' });
    expect(screen.queryByRole('button', { name: /delete|remove|edit/i })).toBeNull();
    expect(trailCalls(backend).every((c) => c.method === 'GET')).toBe(true);
  });

  it('without activity.read, has no link, no page and reads nothing', async () => {
    const backend = open(undefined, ['department.read', 'specialist.read']);
    expect(await screen.findByText(/not found|doesn’t exist|does not exist/i)).toBeTruthy();
    const sidebar = screen.getByRole('navigation', { name: 'Tools' });
    expect(within(sidebar).queryByRole('link', { name: /Audit history/ })).toBeNull();
    expect(trailCalls(backend)).toEqual([]);
  });
});
