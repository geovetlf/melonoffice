import { detectLocale, I18nProvider, type Locale } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import { App } from './App.js';

export interface RootProps {
  readonly initialLocale?: Locale;
}

export function Root({ initialLocale }: RootProps) {
  const [locale, setLocale] = useState<Locale>(
    () => initialLocale ?? detectLocale(globalThis.navigator?.languages ?? []),
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <I18nProvider locale={locale}>
      <App locale={locale} onLocaleChange={setLocale} />
    </I18nProvider>
  );
}
