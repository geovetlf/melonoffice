import { detectLocale, I18nProvider, type Locale } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import { App, type AppProps } from './App.js';
import { loadConfig } from './identity/config.js';
import { createServices, type IdentityServices } from './identity/services.js';

export interface RootProps {
  readonly initialLocale?: Locale;
  /** Where the sign-in services come from; by default, the site's `/config.json`. */
  readonly loadIdentity?: () => Promise<IdentityServices | undefined>;
}

async function fromSiteConfig(): Promise<IdentityServices | undefined> {
  const config = await loadConfig();
  return config === undefined ? undefined : createServices(config);
}

export function Root({ initialLocale, loadIdentity = fromSiteConfig }: RootProps) {
  const [locale, setLocale] = useState<Locale>(
    () => initialLocale ?? detectLocale(globalThis.navigator?.languages ?? []),
  );
  const [identity, setIdentity] = useState<AppProps['identity']>('loading');

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let live = true;
    loadIdentity()
      .catch(() => undefined)
      .then((services) => {
        if (live) setIdentity(services);
      });
    return () => {
      live = false;
    };
  }, [loadIdentity]);

  return (
    <I18nProvider locale={locale}>
      <App identity={identity} locale={locale} onLocaleChange={setLocale} />
    </I18nProvider>
  );
}
