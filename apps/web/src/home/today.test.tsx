import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

/**
 * Today's work on the Home (block 8): the real follow-ups due and the approvals waiting, each
 * opening where it is done. Never an example.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

const followUp = (id: string, when: string, extra: Record<string, unknown> = {}) => ({
  id,
  contactId: 'ct_1',
  contactName: 'Juan Pérez',
  opportunityId: null,
  assignee: 'you',
  type: 'call',
  title: `Llamar ${id}`,
  description: null,
  scheduledAt: '2026-09-28T15:00:00Z',
  timeZone: 'America/Lima',
  date: '2026-09-28',
  time: '10:00',
  when,
  days: when === 'overdue' ? -2 : when === 'today' ? 0 : 3,
  status: 'scheduled',
  source: 'manual',
  cancelReason: null,
  failure: null,
  revision: 1,
  ...extra,
});

function open(
  permissions: readonly string[],
  configure?: (b: ReturnType<typeof fakeBackend>) => void,
) {
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  backend.options.permissions.push(...permissions);
  configure?.(backend);
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  return backend;
}

const today = () => screen.findByRole('region', { name: "Today's tasks" });

describe("the Home's work for today (block 8)", () => {
  it('lists overdue and today follow-ups and waiting approvals, and opens each', async () => {
    open(['follow_up.read', 'approval.read'], (b) => {
      b.options.followUps.org_1 = [
        followUp('fu_1', 'overdue'),
        followUp('fu_2', 'today'),
        followUp('fu_3', 'upcoming'),
      ];
      b.options.approvals = {
        org_1: [
          { id: 'a1', status: 'pending' },
          { id: 'a2', status: 'approved' },
        ],
      };
    });
    const panel = within(await today());
    expect(await panel.findByText('1 approval waiting for you')).toBeTruthy();
    expect(panel.getByText('Llamar fu_1')).toBeTruthy();
    expect(panel.getByText('Juan Pérez · overdue by 2 days')).toBeTruthy();
    expect(panel.getByText('Llamar fu_2')).toBeTruthy();
    expect(panel.queryByText('Llamar fu_3')).toBeNull();
    expect(panel.queryByText('Example')).toBeNull();

    fireEvent.click(panel.getByText('Llamar fu_2'));
    expect(globalThis.location.pathname + globalThis.location.search).toBe(
      '/office/sales?view=follow-ups&followUp=fu_2',
    );
  });

  it('says nothing is due when there is nothing', async () => {
    open(['follow_up.read', 'approval.read'], (b) => {
      b.options.approvals = { org_1: [] };
    });
    expect(await within(await today()).findByText('Nothing due today.')).toBeTruthy();
  });

  it('reads neither follow-ups nor approvals without their permissions', async () => {
    const backend = open([]);
    expect(await within(await today()).findByText('Nothing here for your role.')).toBeTruthy();
    expect(
      backend.apiCalls().some((c) => c.url.includes('/follow-ups') || c.url.includes('/approvals')),
    ).toBe(false);
  });
});

/** The shortcut listens once GIA's chat is available, which may come after the Home renders. */
const pressUntilOpen = (key: { key: string; ctrlKey?: boolean; metaKey?: boolean }) =>
  waitFor(() => {
    if (screen.queryByRole('dialog', { name: 'Ask GIA' }) === null) {
      fireEvent.keyDown(globalThis.window, key);
    }
    return screen.getByRole('dialog', { name: 'Ask GIA' });
  });

describe('Ctrl+K asks GIA from anywhere (block 8)', () => {
  it('opens a box, sends only on Enter, and opens the GIA workplace', async () => {
    const backend = open([]);
    await today();
    const dialog = within(await pressUntilOpen({ key: 'k', ctrlKey: true }));
    const input = dialog.getByRole('textbox');
    fireEvent.change(input, { target: { value: '¿Cómo van las ventas?' } });
    expect(backend.apiCalls().some((c) => c.url.includes('/gia'))).toBe(false);
    fireEvent.submit(input);
    expect(globalThis.location.pathname).toBe('/gia');
    expect(screen.queryByRole('dialog', { name: 'Ask GIA' })).toBeNull();
    expect(await screen.findByText('Hoy no hubo actividad en tu oficina.')).toBeTruthy();
  });

  it('closes with Escape without sending', async () => {
    const backend = open([]);
    await today();
    await pressUntilOpen({ key: 'k', metaKey: true });
    fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Ask GIA' })).toBeNull();
    expect(backend.apiCalls().some((c) => c.method === 'POST' && c.url.includes('/gia'))).toBe(
      false,
    );
  });
});

describe('the Home quick actions', () => {
  it('open only real screens the person may use, and none of tools that do not exist', async () => {
    open(['specialist.read', 'ai_usage.read', 'document.upload']);
    const quick = within(await screen.findByRole('list', { name: 'Quick actions' }));
    expect(quick.getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Upload a file for GIA to read',
      'Ask an agent',
      'See AI usage',
    ]);
    expect(screen.queryByText('Send an email')).toBeNull();
    fireEvent.click(quick.getByRole('link', { name: 'Ask an agent' }));
    expect(globalThis.location.pathname).toBe('/agents');
  });

  it('the attach button uploads in Documents, and only with document.upload', async () => {
    open(['document.upload']);
    fireEvent.click(await screen.findByRole('button', { name: 'Upload a file for GIA to read' }));
    expect(globalThis.location.pathname).toBe('/documents');
    cleanup();
    globalThis.history.replaceState(null, '', '/');
    open([]);
    await today();
    expect(screen.queryByRole('button', { name: 'Upload a file for GIA to read' })).toBeNull();
  });
});
