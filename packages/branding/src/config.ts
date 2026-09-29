import { isCountry, isCurrency, isTimeZone } from '@melonoffice/business';
import type { BrandConfig, BrandLevel } from '@melonoffice/domain';
import { BrandingError } from './errors.js';

/** The languages the product has. Kept equal to `@melonoffice/i18n`'s by a test in the API. */
export const BRAND_LANGUAGES: readonly string[] = Object.freeze(['en', 'es']);

/**
 * The customer's own facts. Only the customer's level sets them: a partner presents the product,
 * it does not decide where the customer is, what currency it uses or what its company is called.
 */
export const CUSTOMER_FACT_FIELDS = Object.freeze([
  'company',
  'timeZone',
  'currency',
  'country',
] as const satisfies readonly (keyof BrandConfig)[]);

const NAME_MAX = 80;
const SHORT_MAX = 40;
const MESSAGE_MAX = 280;
const LONG_MAX = 500;
const URL_MAX = 2048;
// No control characters: a brand text is shown as is, never interpreted.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const COLOR = /^#[0-9a-f]{6}$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const PHONE = /^\+?[0-9][0-9 ().-]{4,31}$/;

type Input = Record<string, unknown>;

const invalid = (field: string): never => {
  throw new BrandingError('invalid_brand_config', field);
};

const isObject = (value: unknown): value is Input =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return invalid(field);
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > max || CONTROL.test(trimmed)) invalid(field);
  return trimmed;
}

/** An https address without credentials. Nothing else is ever put in a page. */
function https(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > URL_MAX) return invalid(field);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(field);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') invalid(field);
  return url.toString();
}

/** A nested group: known keys only, each checked; an empty group is left out. */
function group<T extends object>(
  value: unknown,
  field: string,
  checks: Record<string, (value: unknown, field: string) => unknown>,
): T | undefined {
  if (!isObject(value)) return invalid(field);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const check = checks[key];
    if (check === undefined) invalid(`${field}.${key}`);
    else if (entry !== undefined && entry !== null) out[key] = check(entry, `${field}.${key}`);
  }
  return Object.keys(out).length === 0 ? undefined : (Object.freeze(out) as T);
}

const TOP: Record<string, (value: unknown, field: string) => unknown> = {
  brandName: (v, f) => text(v, f, NAME_MAX),
  productName: (v, f) => text(v, f, NAME_MAX),
  assistantName: (v, f) => text(v, f, SHORT_MAX),
  agentNaming: (v, f) => {
    if (!isObject(v)) return invalid(f);
    const keys = Object.keys(v);
    if (keys.some((k) => k !== 'singular' && k !== 'plural')) invalid(f);
    return Object.freeze({
      singular: text(v.singular, `${f}.singular`, SHORT_MAX),
      plural: text(v.plural, `${f}.plural`, SHORT_MAX),
    });
  },
  logoUrl: https,
  faviconUrl: https,
  primaryColor: (v, f) => (typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : invalid(f)),
  secondaryColor: (v, f) => (typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : invalid(f)),
  login: (v, f) =>
    group(v, f, {
      title: (x, g) => text(x, g, NAME_MAX),
      message: (x, g) => text(x, g, MESSAGE_MAX),
    }),
  email: (v, f) =>
    group(v, f, {
      senderName: (x, g) => text(x, g, NAME_MAX),
      footer: (x, g) => text(x, g, LONG_MAX),
    }),
  notifications: (v, f) => group(v, f, { senderName: (x, g) => text(x, g, NAME_MAX) }),
  supportContact: (v, f) =>
    group(v, f, {
      email: (x, g) => (typeof x === 'string' && EMAIL.test(x) ? x : invalid(g)),
      phone: (x, g) => (typeof x === 'string' && PHONE.test(x) ? x : invalid(g)),
      url: https,
    }),
  company: (v, f) =>
    group(v, f, {
      legalName: (x, g) => text(x, g, 120),
      address: (x, g) => text(x, g, 300),
      website: https,
    }),
  links: (v, f) => group(v, f, { legal: https, privacy: https, terms: https }),
  defaultLanguage: (v, f) => (BRAND_LANGUAGES.includes(v as string) ? v : invalid(f)),
  timeZone: (v, f) => (isTimeZone(v) ? v : invalid(f)),
  currency: (v, f) => (isCurrency(v) ? v : invalid(f)),
  country: (v, f) => (isCountry(v) ? v : invalid(f)),
};

/**
 * A brand configuration as its owner sends it, checked field by field (ADR-0087). Unknown fields
 * are refused, not ignored. Only the customer's own level may set the customer's facts. The error
 * names the field, never the value.
 */
export function parseBrandConfig(value: unknown, level: BrandLevel): BrandConfig {
  if (!isObject(value)) return invalid('config');
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const check = TOP[key];
    if (check === undefined) invalid(key);
    if (
      level !== 'organization' &&
      (CUSTOMER_FACT_FIELDS as readonly string[]).includes(key) &&
      entry !== undefined &&
      entry !== null
    ) {
      invalid(key);
    }
    if (entry === undefined || entry === null) continue;
    const checked = check?.(entry, key);
    if (checked !== undefined) out[key] = checked;
  }
  return Object.freeze(out) as BrandConfig;
}
