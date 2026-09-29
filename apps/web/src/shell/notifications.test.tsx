import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

/**
 * The bell: approvals, plans waiting for approval and follow-ups due, read with the person's own
 * permissions, each opening where it is done. Nothing invented: with nothing waiting it says so.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

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

const followUp = (id: string, when: string) => ({
  id,
  contactId: 'ct_1',
  contactName: 'Juan Pérez',
  title: `Llamar ${id}`,
  when,
  days: when === 'overdue' ? -2 : 0,
  status: 'scheduled',
});

describe('the bell', () => {
  it('counts what waits on the person and opens where each is done', async () => {
    open(['approval.read', 'plan.read', 'follow_up.read'], (b) => {
      b.options.approvals = {
        org_1: [
          { id: 'a1', status: 'pending' },
          { id: 'a2', status: 'approved' },
        ],
      };
      b.options.plans.org_1 = [
        { id: 'p1', status: 'approval_required', version: 1, createdAt: '2026-09-29T10:00:00Z' },
        { id: 'p2', status: 'executing', version: 1, createdAt: '2026-09-29T09:00:00Z' },
      ];
      b.options.followUps.org_1 = [
        followUp('f1', 'overdue'),
        followUp('f2', 'today'),
        followUp('f3', 'upcoming'),
      ];
    });
    const bell = await screen.findByLabelText('Notifications, 4 waiting');
    const menu = bell.closest('details') as HTMLDetailsElement;
    fireEvent.click(bell);
    const panel = within(menu);
    expect(await panel.findByText('1 approval waiting for you')).toBeTruthy();
    expect(panel.getByText('1 plan waiting for your approval')).toBeTruthy();
    expect(panel.getByText('2 follow-ups due today or overdue')).toBeTruthy();
    fireEvent.click(panel.getByRole('button', { name: '1 plan waiting for your approval' }));
    expect(globalThis.location.pathname).toBe('/automations');
  });

  it('says nothing needs the person, and what could not be checked', async () => {
    open(['approval.read'], (b) => {
      b.options.approvals = { org_1: [{ id: 'a2', status: 'approved' }] };
    });
    const bell = await screen.findByLabelText('Notifications');
    fireEvent.click(bell);
    expect(await screen.findByText('Nothing needs you right now.')).toBeTruthy();
    cleanup();
    open(['approval.read', 'plan.read'], (b) => {
      b.options.approvals = { org_1: [{ id: 'a1', status: 'pending' }] };
      // The plans read fails.
      b.options.plans = undefined as never;
    });
    fireEvent.click(await screen.findByLabelText('Notifications, 1 waiting'));
    expect(await screen.findByText('Plans could not be checked.')).toBeTruthy();
  });

  it('reads nothing a role cannot read', async () => {
    const backend = open([]);
    fireEvent.click(await screen.findByLabelText('Notifications'));
    expect(await screen.findByText('Your role has nothing to follow here.')).toBeTruthy();
    expect(backend.apiCalls().some((c) => /\/(approvals|plans|follow-ups)/.test(c.url))).toBe(
      false,
    );
  });
});
