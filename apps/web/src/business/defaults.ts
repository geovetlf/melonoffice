/**
 * Starting values for a new business profile (ADR-0048). MelonOffice starts in Peru: when the
 * browser says nothing more precise, the form proposes Peru, soles (PEN) and America/Lima. They
 * are only suggestions the owner sees and can change; the API checks every value again.
 */

export const HOME_COUNTRY = 'PE';
export const HOME_TIME_ZONE = 'America/Lima';

/**
 * The official currency of the countries the form can suggest one for (ISO 4217). A country not
 * listed gets no suggestion: the owner picks the currency.
 */
export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  PE: 'PEN',
  AR: 'ARS',
  BO: 'BOB',
  CL: 'CLP',
  CO: 'COP',
  CR: 'CRC',
  DO: 'DOP',
  EC: 'USD',
  ES: 'EUR',
  GT: 'GTQ',
  HN: 'HNL',
  MX: 'MXN',
  NI: 'NIO',
  PA: 'PAB',
  PY: 'PYG',
  SV: 'USD',
  US: 'USD',
  UY: 'UYU',
};

/** The country a browser language names (`es-PE` → `PE`), when the form knows its currency. */
function countryOfLanguages(languages: readonly string[]): string | undefined {
  for (const tag of languages) {
    const region = tag.split('-')[1]?.toUpperCase();
    if (region !== undefined && COUNTRY_CURRENCY[region] !== undefined) return region;
  }
  return undefined;
}

export interface StartingValues {
  readonly country: string;
  readonly currency: string;
  readonly timeZone: string;
}

export function startingValues(
  languages: readonly string[],
  deviceTimeZone: string,
): StartingValues {
  const country = countryOfLanguages(languages) ?? HOME_COUNTRY;
  return {
    country,
    currency: COUNTRY_CURRENCY[country] ?? '',
    timeZone: deviceTimeZone === '' ? HOME_TIME_ZONE : deviceTimeZone,
  };
}

/**
 * The currency after the country changes: the new country's, unless the owner had already chosen
 * a currency of their own (one that is not the old country's suggestion).
 */
export function currencyAfterCountryChange(from: string, to: string, currency: string): string {
  const suggested = COUNTRY_CURRENCY[from];
  const chosenByOwner = currency !== '' && currency !== suggested;
  return chosenByOwner ? currency : (COUNTRY_CURRENCY[to] ?? currency);
}
