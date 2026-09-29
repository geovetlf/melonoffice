import { detectLocale, I18nProvider, type Locale } from '@melonoffice/i18n';
import { useEffect, useState } from 'react';
import { App, type AppProps } from './App.js';
import { applyBrand, BrandContext, loadPublicBrand, type PublicBrand } from './brand/brand.js';
import { loadConfig } from './identity/config.js';
import { createServices, type IdentityServices } from './identity/services.js';

export interface RootProps {
  readonly initialLocale?: Locale;
  /** Where the sign-in services come from; by default, the site's `/config.json`. */
  readonly loadIdentity?: () => Promise<IdentityServices | undefined>;
  /** The brand for this host (ADR-0087); by default, asked of the API from `/config.json`. */
  readonly loadBrand?: () => Promise<PublicBrand | undefined>;
}

async function fromSiteConfig(): Promise<IdentityServices | undefined> {
  const config = await loadConfig();
  return config === undefined ? undefined : createServices(config);
}

async function fromSiteBrand(): Promise<PublicBrand | undefined> {
  const config = await loadConfig();
  return config === undefined
    ? undefined
    : loadPublicBrand(config.apiUrl, globalThis.location.hostname);
}

export function Root({
  initialLocale,
  loadIdentity = fromSiteConfig,
  loadBrand = fromSiteBrand,
}: RootProps) {
  const [locale, setLocale] = useState<Locale>(
    () => initialLocale ?? detectLocale(globalThis.navigator?.languages ?? []),
  );
  const [identity, setIdentity] = useState<AppProps['identity']>('loading');
  const [brand, setBrand] = useState<PublicBrand | undefined>(undefined);

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

  // A host with an active domain shows its owner's brand; any other host, MelonOffice's.
  useEffect(() => {
    let live = true;
    loadBrand()
      .catch(() => undefined)
      .then((found) => {
        if (!live || found === undefined || found.context === 'platform') return;
        applyBrand(found);
        setBrand(found);
      });
    return () => {
      live = false;
    };
  }, [loadBrand]);

  return (
    <I18nProvider locale={locale}>
      <BrandContext.Provider value={brand}>
        <App identity={identity} locale={locale} onLocaleChange={setLocale} />
      </BrandContext.Provider>
    </I18nProvider>
  );
}
