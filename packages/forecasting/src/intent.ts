import type { ForecastFrequency } from './periods.js';

/**
 * What a person asked for, read by fixed rules from their own words (ADR-0059), in Spanish and
 * English. No model decides whether a forecast runs, which metric or how far: a forecast costs
 * credits and is a figure people act on, so only what the person said starts one.
 *
 * - `forecast`: a metric MelonOffice records, with its horizon.
 * - `unsupported`: a forecast of something MelonOffice has no records of (orders, products,
 *   stock, campaigns). GIA says so; no other metric stands in for it.
 */
export type ForecastIntent =
  | {
      readonly kind: 'forecast';
      readonly metric: string;
      readonly frequency: ForecastFrequency;
      readonly horizon: number;
      /** The person asked how something is trending rather than for a figure. */
      readonly trend: boolean;
    }
  | {
      readonly kind: 'unsupported';
      readonly subject: 'orders' | 'products' | 'inventory' | 'campaigns';
    };

const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[¿?¡!.,;:()"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Words that ask for a projection or a trend. Without one (or a "how much" about a coming
 * period, below), nothing is a forecast request: "my next follow-up about the sale" is not one.
 */
const FUTURE = [
  /\bproyect/,
  /\bpronostic/,
  /\bprevision/,
  /\bpredic/,
  /\bestim/,
  /\bvenderemos\b/,
  /\bvenderan\b/,
  /\besperamos\b/,
  /\besperar\b/,
  /\btendencia/,
  /\bcomo viene/,
  /\bcomo van\b/,
  /\bevolucion/,
  /\bforecast/,
  /\bproject/,
  /\bpredict/,
  /\bexpect/,
  /\btrend/,
  /\bevolv/,
  /\bwill we\b/,
  /\bcrecimiento\b|\bcrec(en|iendo)\b|\bgrowth\b|\bgrowing\b/,
];

/** "How much / how many" about a coming period is a forecast request too. */
const QUANTITY = /\bcuant[oa]s?\b|\bhow (much|many)\b/;
const COMING = /\bproxim[oa]s?\b|\bsiguientes?\b|\bnext\b|\bcoming\b/;

const TREND = [
  /\btendencia/,
  /\bcomo viene/,
  /\bcomo van\b/,
  /\bevolucion/,
  /\btrend/,
  /\bevolv/,
  /\bcrecimiento\b/,
  /\bgrowth\b/,
];

/** Subjects with no records yet, checked before the metrics so "pedidos" never reads as sales. */
const UNSUPPORTED: readonly [RegExp, 'orders' | 'products' | 'inventory' | 'campaigns'][] = [
  [/\bpedidos?\b|\bordenes\b|\borders?\b/, 'orders'],
  [/\bproductos?\b|\bproducts?\b/, 'products'],
  [/\binventario\b|\bstock\b|\binventory\b/, 'inventory'],
  [/\bcampanas?\b|\bcampaigns?\b/, 'campaigns'],
];

const METRICS: readonly [RegExp, string][] = [
  [/\b(cuantas|numero de|cantidad de) ventas\b|\bhow many (sales|deals)\b/, 'sales.won_count'],
  [
    /\bleads?\b|\bprospectos?\b|\bclientes nuevos\b|\bcontactos nuevos\b|\bnew customers\b/,
    'leads.new',
  ],
  [
    /\bconversaciones\b|\bmensajes\b|\bconsultas\b|\bchats?\b|\bconversations?\b|\binquir/,
    'conversations.new',
  ],
  [
    /\boportunidades\b|\bnegocios nuevos\b|\bdemanda\b|\bopportunit|\bdeals?\b|\bdemand\b/,
    'opportunities.new',
  ],
  [/\bvent|\bvender|\bingreso|\bfactur|\brevenue\b|\bsales?\b|\bsell\b/, 'sales.won_value'],
];

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1,
  una: 1,
  uno: 1,
  one: 1,
  dos: 2,
  two: 2,
  tres: 3,
  three: 3,
  cuatro: 4,
  four: 4,
  cinco: 5,
  five: 5,
  seis: 6,
  six: 6,
  siete: 7,
  seven: 7,
  ocho: 8,
  eight: 8,
  nueve: 9,
  nine: 9,
  diez: 10,
  ten: 10,
  doce: 12,
  twelve: 12,
  quince: 15,
  fifteen: 15,
};

const count = (word: string): number | undefined =>
  /^\d{1,3}$/.test(word) ? Number(word) : NUMBER_WORDS[word];

/** The horizon the words name; 30 days when they name none. */
function horizonOf(text: string): { frequency: ForecastFrequency; horizon: number } {
  const n = String.raw`(\d{1,3}|${Object.keys(NUMBER_WORDS).join('|')})`;
  const days = new RegExp(`\\b${n} (dias|days)\\b`).exec(text);
  if (days !== null) return { frequency: 'day', horizon: count(days[1] as string) ?? 30 };
  const weeks = new RegExp(`\\b${n} (semanas|weeks)\\b`).exec(text);
  if (weeks !== null) return { frequency: 'week', horizon: count(weeks[1] as string) ?? 4 };
  const months = new RegExp(`\\b${n} (meses|months)\\b`).exec(text);
  if (months !== null) return { frequency: 'month', horizon: count(months[1] as string) ?? 3 };
  // Years are counted in months: the engine refuses what is beyond its longest horizon.
  const years = new RegExp(`\\b${n} (anos|years)\\b`).exec(text);
  if (years !== null) return { frequency: 'month', horizon: (count(years[1] as string) ?? 1) * 12 };
  if (/\bproximo ano\b|\bnext year\b/.test(text)) {
    return { frequency: 'month', horizon: 12 };
  }
  if (/\b(proxima|esta) semana\b|\bnext week\b|\bthis week\b/.test(text)) {
    return { frequency: 'day', horizon: 7 };
  }
  if (/\btrimestre\b|\bquarter\b/.test(text)) return { frequency: 'day', horizon: 90 };
  return { frequency: 'day', horizon: 30 };
}

export function forecastIntentOf(message: string): ForecastIntent | undefined {
  const text = normalize(message);
  const asks = FUTURE.some((re) => re.test(text)) || (QUANTITY.test(text) && COMING.test(text));
  if (!asks) return undefined;
  for (const [re, subject] of UNSUPPORTED) {
    if (re.test(text)) return Object.freeze({ kind: 'unsupported', subject });
  }
  const metric = METRICS.find(([re]) => re.test(text))?.[1];
  if (metric === undefined) return undefined;
  return Object.freeze({
    kind: 'forecast',
    metric,
    ...horizonOf(text),
    trend: TREND.some((re) => re.test(text)),
  });
}
