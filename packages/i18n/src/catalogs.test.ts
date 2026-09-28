import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { catalogs, SOURCE_LOCALE, SUPPORTED_LOCALES, type Locale } from './catalogs.js';
import { detectLocale } from './detect.js';
import { formattingLocale } from './I18nProvider.js';
import { pseudoLocalize, pseudoLocalizeCatalog } from './pseudo.js';

/** A value for each argument a message names (`{name}`, `{count, plural, …}`), to format it. */
function argumentsOf(message: string): Record<string, number> {
  const names = [...message.matchAll(/\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,}]/g)].map((m) => m[1]);
  return Object.fromEntries(names.map((name) => [name, 1]));
}

describe('catalogs', () => {
  it('supports English and Spanish (D-17)', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'es']);
  });

  it.each(SUPPORTED_LOCALES)('%s has exactly the same keys as the source catalog', (locale) => {
    expect(Object.keys(catalogs[locale]).sort()).toEqual(
      Object.keys(catalogs[SOURCE_LOCALE]).sort(),
    );
  });

  it.each(SUPPORTED_LOCALES)('%s has no empty messages', (locale) => {
    for (const [key, value] of Object.entries(catalogs[locale])) {
      expect(value.trim(), key).not.toBe('');
    }
  });

  it.each(SUPPORTED_LOCALES)('every %s message is valid ICU and formats', (locale: Locale) => {
    const errors: unknown[] = [];
    const intl = createIntl({ locale, messages: catalogs[locale], onError: (e) => errors.push(e) });
    for (const [id, message] of Object.entries(catalogs[locale])) {
      expect(intl.formatMessage({ id }, argumentsOf(message))).not.toBe(id);
    }
    expect(errors).toEqual([]);
  });

  it('translates the tagline into Spanish', () => {
    expect(catalogs.es['app.tagline']).toBe('Tu oficina inteligente');
    expect(catalogs.en['app.tagline']).toBe('Your intelligent office');
  });
});

describe('detectLocale', () => {
  it('matches exact and regional tags', () => {
    expect(detectLocale(['es-PE', 'en'])).toBe('es');
    expect(detectLocale(['en-GB'])).toBe('en');
  });

  it('skips unsupported languages and falls back to the default', () => {
    expect(detectLocale(['fr-FR', 'es'])).toBe('es');
    expect(detectLocale(['ja'])).toBe('es');
    expect(detectLocale([])).toBe('es');
  });
});

describe('pseudoLocalize', () => {
  it('accents and pads text but keeps ICU placeholders intact', () => {
    const result = pseudoLocalize(
      'Hello {name}, you have {count, plural, one {# task} other {# tasks}}',
    );
    expect(result).toContain('{name}');
    expect(result).toContain('{count, plural, one {# task} other {# tasks}}');
    expect(result.startsWith('[Hél')).toBe(true);
    expect(result.endsWith('~]')).toBe(true);
  });

  it('produces a catalog that still formats as valid ICU', () => {
    const messages = pseudoLocalizeCatalog(catalogs.en);
    const errors: unknown[] = [];
    const intl = createIntl({ locale: 'en', messages, onError: (e) => errors.push(e) });
    for (const [id, message] of Object.entries(messages)) {
      intl.formatMessage({ id }, argumentsOf(message));
    }
    expect(errors).toEqual([]);
  });
});

describe('formattingLocale', () => {
  it('formats with the business country when there is one (es-PE), the words staying es', () => {
    expect(formattingLocale('es', 'PE')).toBe('es-PE');
    expect(formattingLocale('en', 'PE')).toBe('en-PE');
    expect(formattingLocale('es')).toBe('es');
    expect(formattingLocale('es', 'peru')).toBe('es');
  });
});
