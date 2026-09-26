import type { ReactNode } from 'react';
import { IntlProvider } from 'react-intl';
import { getMessages, SOURCE_LOCALE, type Locale, type Messages } from './catalogs.js';

export interface I18nProviderProps {
  readonly locale: Locale;
  /** Overrides the catalog, e.g. with pseudo-localised messages in tests. */
  readonly messages?: Messages;
  readonly children: ReactNode;
}

export function I18nProvider({ locale, messages, children }: I18nProviderProps) {
  return (
    <IntlProvider
      locale={locale}
      defaultLocale={SOURCE_LOCALE}
      messages={messages ?? getMessages(locale)}
    >
      {children}
    </IntlProvider>
  );
}
