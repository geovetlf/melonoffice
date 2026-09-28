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
    expect(
      screen.getByText('Getting ready: the conversation with GIA arrives in the next phase'),
    ).toBeTruthy();
    const capabilities = screen.getByRole('region', { name: 'What GIA will do' });
    expect(within(capabilities).getAllByText('Soon').length).toBe(4);
    expect(within(capabilities).getByText('Send messages to customers')).toBeTruthy();
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

  it('keeps the avatar decorative where her name is written, and named where it is alone', async () => {
    open('/gia');
    await screen.findByRole('heading', { level: 1, name: 'GIA' });
    for (const svg of document.querySelectorAll('.gia-workplace svg.gia-avatar')) {
      expect(svg.getAttribute('aria-hidden')).toBe('true');
    }
  });
});
