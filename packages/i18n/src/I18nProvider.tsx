import type { ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import { getMessages, SOURCE_LOCALE, type Locale, type Messages } from './catalogs.js';

export interface I18nProviderProps {
  readonly locale: Locale;
  /** Overrides the catalog, e.g. with pseudo-localised messages in tests. */
  readonly messages?: Messages;
  /**
   * The country whose conventions dates, numbers and money follow (ISO 3166-1, e.g. `PE` gives
   * `es-PE`). The words stay the language's own catalog.
   */
  readonly region?: string;
  readonly children: ReactNode;
}

export function I18nProvider({ locale, messages, region, children }: I18nProviderProps) {
  return (
    <IntlProvider
      locale={formattingLocale(locale, region)}
      defaultLocale={SOURCE_LOCALE}
      messages={messages ?? getMessages(locale)}
    >
      {children}
    </IntlProvider>
  );
}

/** The tag Intl formats with: the language, plus the country when it is a valid one. */
export function formattingLocale(locale: Locale, region?: string): string {
  if (region === undefined || !/^[A-Z]{2}$/.test(region)) return locale;
  try {
    return Intl.getCanonicalLocales(`${locale}-${region}`)[0] ?? locale;
  } catch {
    return locale;
  }
}
