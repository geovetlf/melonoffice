import { contrastRatio } from '@melonoffice/ui';
import { createContext, useContext } from 'react';

/**
 * The brand a page shows, from the API's `/v1/public/brand` for this host (ADR-0087). Only what
 * the API answers, checked again here; anything else is left as MelonOffice's own.
 */
export interface PublicBrand {
  readonly context: 'platform' | 'commercial_account' | 'organization';
  readonly productName?: string;
  readonly faviconUrl?: string;
  readonly primaryColor?: string;
}

const CONTEXTS = new Set(['platform', 'commercial_account', 'organization']);
const COLOR = /^#[0-9a-f]{6}$/;
const NAME_MAX = 80;

const httpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

export function parsePublicBrand(value: unknown): PublicBrand | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { context, brand } = value as Record<string, unknown>;
  if (typeof context !== 'string' || !CONTEXTS.has(context)) return undefined;
  const b = (typeof brand === 'object' && brand !== null ? brand : {}) as Record<string, unknown>;
  const productName =
    typeof b.productName === 'string' &&
    b.productName.length > 0 &&
    b.productName.length <= NAME_MAX
      ? b.productName
      : undefined;
  const faviconUrl = httpsUrl(b.faviconUrl);
  const primaryColor =
    typeof b.primaryColor === 'string' && COLOR.test(b.primaryColor) ? b.primaryColor : undefined;
  return Object.freeze({
    context: context as PublicBrand['context'],
    ...(productName === undefined ? {} : { productName }),
    ...(faviconUrl === undefined ? {} : { faviconUrl }),
    ...(primaryColor === undefined ? {} : { primaryColor }),
  });
}

/** The brand for this host, or nothing when the API cannot say: the page stays MelonOffice. */
export async function loadPublicBrand(
  apiUrl: string,
  host: string,
  fetcher: typeof fetch = fetch,
): Promise<PublicBrand | undefined> {
  try {
    const response = await fetcher(`${apiUrl}/v1/public/brand?host=${encodeURIComponent(host)}`);
    if (!response.ok) return undefined;
    return parsePublicBrand(await response.json());
  } catch {
    return undefined;
  }
}

/** White text on buttons stays readable (WCAG AA): a color that fails is not applied. */
const READABLE = 4.5;

/**
 * Applies a brand to the page: its title, its icon and its main color. The platform's own brand
 * changes nothing, so a MelonOffice page stays exactly as built.
 */
export function applyBrand(brand: PublicBrand, doc: Document = document): void {
  if (brand.context === 'platform') return;
  if (brand.productName !== undefined) doc.title = brand.productName;
  if (brand.faviconUrl !== undefined) {
    let link = doc.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (link === null) {
      link = doc.createElement('link');
      link.rel = 'icon';
      doc.head.append(link);
    }
    link.href = brand.faviconUrl;
  }
  if (
    brand.primaryColor !== undefined &&
    contrastRatio('#ffffff', brand.primaryColor) >= READABLE
  ) {
    doc.documentElement.style.setProperty('--mo-color-accent', brand.primaryColor);
    doc.documentElement.style.setProperty('--mo-color-focus-ring', brand.primaryColor);
  }
}

/** The brand the app shows; absent means MelonOffice's own. */
export const BrandContext = createContext<PublicBrand | undefined>(undefined);

export const useBrand = (): PublicBrand | undefined => useContext(BrandContext);
