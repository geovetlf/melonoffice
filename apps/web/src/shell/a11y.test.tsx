import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';

/** The shell's accessibility (phase 6): what every signed-in page shares. */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

function open() {
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
}

describe('the search box', () => {
  it('controls its results only while they are shown, and never names a missing element', async () => {
    open();
    const search = await screen.findByRole('searchbox');
    expect(search.hasAttribute('aria-controls')).toBe(false);
    fireEvent.change(search, { target: { value: 'co' } });
    const controlled = search.getAttribute('aria-controls');
    expect(controlled).not.toBeNull();
    expect(document.getElementById(controlled ?? '')).not.toBeNull();
    fireEvent.change(search, { target: { value: '' } });
    expect(search.hasAttribute('aria-controls')).toBe(false);
  });
});

describe('the skip link', () => {
  it('is the first stop and moves focus to the main content', async () => {
    open();
    const skip = await screen.findByRole('link', { name: 'Skip to content' });
    const focusable = document.querySelectorAll(
      'a[href], button, input, select, textarea, summary',
    );
    expect(focusable[0]).toBe(skip);
    fireEvent.click(skip);
    const main = screen.getByRole('main');
    expect(main.id).toBe('main');
    expect(document.activeElement).toBe(main);
  });
});
