import type {
  BusinessProfile,
  BusinessTypeId,
  EmployeeRange,
  IsoTimestamp,
  OrganizationId,
  SalesChannel,
  UserId,
} from '@melonoffice/domain';
import type { BusinessTypeCatalogue } from './catalogue.js';
import { BusinessError } from './errors.js';

export const EMPLOYEE_RANGES = [
  '1',
  '2_5',
  '6_10',
  '11_50',
  '51_plus',
] as const satisfies readonly EmployeeRange[];

export const SALES_CHANNELS = [
  'physical_store',
  'whatsapp',
  'social_media',
  'website',
  'marketplace',
  'delivery_apps',
  'phone',
  'in_person',
] as const satisfies readonly SalesChannel[];

export const MAX_CITY_LENGTH = 100;
export const MAX_TEXT_LENGTH = 500;

/** What a person may send: exactly these keys, and nothing about who or when. */
export const PROFILE_FIELDS = [
  'businessType',
  'country',
  'currency',
  'timeZone',
  'city',
  'employees',
  'salesChannels',
  'offering',
  'needs',
  'notes',
] as const;

const invalid = (field: string): never => {
  throw new BusinessError('invalid_profile', field);
};

// Codes Intl names that are not countries or territories: groupings and private-use codes.
const NOT_COUNTRIES = new Set(['EU', 'EZ', 'UN', 'QO', 'XA', 'XB', 'ZZ']);
const regions = new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });

/** An ISO 3166-1 alpha-2 country or territory code, e.g. `PE`. */
export function isCountry(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Z]{2}$/.test(value) || NOT_COUNTRIES.has(value)) {
    return false;
  }
  return regions.of(value) !== undefined;
}

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/** An ISO 4217 currency code, e.g. `PEN`. */
export const isCurrency = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z]{3}$/.test(value) && CURRENCIES.has(value);

/** An IANA time zone, e.g. `America/Lima`, or `UTC`. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(value: unknown, field: string, max: number, singleLine: boolean): string {
  if (typeof value !== 'string') return invalid(field);
  const clean = value.normalize('NFC').trim();
  if (
    clean.length === 0 ||
    [...clean].length > max ||
    CONTROL.test(clean) ||
    (singleLine && /[\n\r\t]/.test(clean))
  ) {
    return invalid(field);
  }
  return clean;
}

/** The profile's content, as a person may set it. */
export type ProfileContent = Omit<
  BusinessProfile,
  'organizationId' | 'revision' | 'createdAt' | 'updatedAt' | 'updatedBy'
>;

/**
 * Checks what a person sent. Unknown keys, and anything that is not exactly the expected shape,
 * are refused with the field's name, never with its value. An empty optional field is absent.
 */
export function checkProfileContent(
  input: unknown,
  catalogue: BusinessTypeCatalogue,
): ProfileContent {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) invalid('body');
  const body = input as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(key)) invalid(key);
  }
  const present = (key: string) => {
    const value = body[key];
    return (
      value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '')
    );
  };

  if (typeof body.businessType !== 'string' || catalogue.find(body.businessType) === undefined) {
    invalid('businessType');
  }
  if (!isCountry(body.country)) invalid('country');
  if (!isCurrency(body.currency)) invalid('currency');
  if (!isTimeZone(body.timeZone)) invalid('timeZone');
  if (!present('city')) invalid('city');
  const city = text(body.city, 'city', MAX_CITY_LENGTH, true);

  let salesChannels: SalesChannel[] | undefined;
  if (present('salesChannels')) {
    const list = body.salesChannels;
    if (
      !Array.isArray(list) ||
      list.length > SALES_CHANNELS.length ||
      new Set(list).size !== list.length ||
      !list.every((c) => (SALES_CHANNELS as readonly unknown[]).includes(c))
    ) {
      invalid('salesChannels');
    }
    // Stored in the catalogue's order, so the same choice is always the same record.
    salesChannels = SALES_CHANNELS.filter((c) => (list as unknown[]).includes(c));
  }
  if (present('employees') && !(EMPLOYEE_RANGES as readonly unknown[]).includes(body.employees)) {
    invalid('employees');
  }

  return Object.freeze({
    businessType: body.businessType as BusinessTypeId,
    country: body.country as string,
    currency: body.currency as string,
    timeZone: body.timeZone as string,
    city,
    ...(present('employees') ? { employees: body.employees as EmployeeRange } : {}),
    ...(salesChannels === undefined || salesChannels.length === 0
      ? {}
      : { salesChannels: Object.freeze(salesChannels) }),
    ...(present('offering')
      ? { offering: text(body.offering, 'offering', MAX_TEXT_LENGTH, false) }
      : {}),
    ...(present('needs') ? { needs: text(body.needs, 'needs', MAX_TEXT_LENGTH, false) } : {}),
    ...(present('notes') ? { notes: text(body.notes, 'notes', MAX_TEXT_LENGTH, false) } : {}),
  });
}

/** Builds the next stored profile: the first one at revision 1, or the next revision. */
export function nextProfile(
  organizationId: OrganizationId,
  current: BusinessProfile | undefined,
  content: ProfileContent,
  by: UserId,
  now: IsoTimestamp,
): BusinessProfile {
  const at =
    current !== undefined && Date.parse(current.updatedAt) > Date.parse(now)
      ? current.updatedAt
      : now;
  return Object.freeze({
    ...content,
    organizationId,
    revision: (current?.revision ?? 0) + 1,
    createdAt: current?.createdAt ?? at,
    updatedAt: at,
    updatedBy: by,
  });
}

/** Whether two profiles say the same thing, ignoring who wrote them and when. */
export function sameContent(a: ProfileContent, b: ProfileContent): boolean {
  const pick = (p: ProfileContent) =>
    JSON.stringify(PROFILE_FIELDS.map((key) => (p as Record<string, unknown>)[key] ?? null));
  return pick(a) === pick(b);
}

/**
 * Checks a stored profile before it is trusted: a record that fails is refused, never repaired.
 * A business type that has since left the catalogue is kept as it is.
 */
export function checkStoredProfile(profile: BusinessProfile): BusinessProfile {
  const { organizationId, revision, createdAt, updatedAt, updatedBy, ...content } = profile;
  if (typeof organizationId !== 'string' || organizationId.length === 0) invalid('organizationId');
  if (!Number.isSafeInteger(revision) || revision < 1) invalid('revision');
  if (Number.isNaN(Date.parse(createdAt)) || Number.isNaN(Date.parse(updatedAt))) invalid('at');
  if (typeof updatedBy !== 'string' || updatedBy.length === 0) invalid('updatedBy');
  const known = {
    find: (id: string) =>
      /^[a-z][a-z0-9_]{0,63}$/.test(id)
        ? { id: id as BusinessTypeId, nameKey: '' as never, departmentPriority: [] }
        : undefined,
    types: [],
  };
  checkProfileContent(content, known);
  return profile;
}
