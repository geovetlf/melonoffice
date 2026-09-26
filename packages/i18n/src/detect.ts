import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from './catalogs.js';

/**
 * Picks the first supported locale from the user's preferred languages,
 * matching on the base language ("es-PE" → "es"). Falls back to the default.
 */
export function detectLocale(preferred: readonly string[]): Locale {
  for (const tag of preferred) {
    const normalized = tag.trim().toLowerCase();
    if (isSupportedLocale(normalized)) return normalized;
    const base = normalized.split('-')[0] ?? '';
    if (isSupportedLocale(base)) return base;
  }
  return DEFAULT_LOCALE;
}
