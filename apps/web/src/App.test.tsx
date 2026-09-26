import { pseudoLocalizeCatalog, catalogs, I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { Root } from './Root.js';

afterEach(cleanup);

describe('placeholder page', () => {
  it('renders in English', () => {
    render(<Root initialLocale="en" />);
    expect(screen.getByRole('heading', { level: 1, name: 'MelonOffice' })).toBeTruthy();
    expect(screen.getByText('Your intelligent office')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'English', pressed: true })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('renders in Spanish', () => {
    render(<Root initialLocale="es" />);
    expect(screen.getByText('Tu oficina inteligente')).toBeTruthy();
    expect(screen.getByText('Idioma')).toBeTruthy();
    expect(document.documentElement.lang).toBe('es');
  });

  it('switches language without reloading', () => {
    render(<Root initialLocale="en" />);
    fireEvent.click(screen.getByRole('button', { name: 'Español' }));
    expect(screen.getByText('Tu oficina inteligente')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Español', pressed: true })).toBeTruthy();
  });

  it('shows no hard-coded text: every visible string comes from the catalog', () => {
    const messages = pseudoLocalizeCatalog(catalogs.en);
    render(
      <I18nProvider locale="en" messages={messages}>
        <App locale="en" onLocaleChange={vi.fn()} />
      </I18nProvider>,
    );
    const textNodes = [...document.body.querySelectorAll('h1, p, span, button')]
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean);
    expect(textNodes.length).toBeGreaterThan(0);
    for (const text of textNodes) expect(text, text).toMatch(/^\[.*\]$/);
  });
});
