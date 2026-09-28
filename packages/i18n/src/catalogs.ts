import en from './locales/en.json' with { type: 'json' };
import es from './locales/es.json' with { type: 'json' };

/**
 * Message catalogs, keyed by BCP 47 language tag. English is the source
 * catalog. Adding a language (e.g. it, zh, ru, ja) means adding a JSON file
 * and one entry here; nothing else in the application changes (D-17).
 */
export const catalogs = {
  en,
  es,
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

export type Locale = keyof typeof catalogs;
export type MessageId = keyof (typeof catalogs)['en'];
export type Messages = Readonly<Record<MessageId, string>>;

export const SOURCE_LOCALE: Locale = 'en';
/**
 * The language when the browser asks for none MelonOffice speaks. MelonOffice starts in Peru
 * (ADR-0048), so it is Spanish; English stays the source catalog.
 */
export const DEFAULT_LOCALE: Locale = 'es';
export const SUPPORTED_LOCALES = Object.freeze(Object.keys(catalogs) as Locale[]);

export function isSupportedLocale(value: string): value is Locale {
  return Object.hasOwn(catalogs, value);
}

export function getMessages(locale: Locale): Messages {
  return catalogs[locale];
}
