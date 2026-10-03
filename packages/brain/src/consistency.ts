import type { KnowledgeItem, KnowledgeValue } from '@melonoffice/domain';
import { sensitivityAllows, type PurposeAccess } from './catalogue.js';

/**
 * Deterministic checks of a text against Company Brain's facts (G-1, ADR-0131): no model is asked
 * and nothing is charged. Only figures are compared: an amount of money, or a number with a unit,
 * that a text gives for something the company memory records with another figure. Anything this
 * cannot read with certainty (no currency, no unit, a label it does not find) is left alone, so a
 * contradiction it reports is one a person can see in the text.
 */

/** A fact with a figure, as the check reads it. */
export interface FigureFact {
  readonly id: string;
  /** What the text must name for the figure to be about it, e.g. `Combo Familiar`. */
  readonly label: string;
  readonly value: Extract<KnowledgeValue, { type: 'money' | 'number' }>;
  /** Whether a person confirmed it, or MelonOffice calculated or imported it. */
  readonly confirmed: boolean;
}

/** One figure in the text that disagrees with a fact. */
export interface FigureContradiction {
  readonly factId: string;
  readonly label: string;
  /** The fact's figure, as text, e.g. `PEN 25.00` or `30 min`. */
  readonly recorded: string;
  /** The figure the text gives, as written. */
  readonly stated: string;
  readonly confirmed: boolean;
}

/** Currencies whose amounts have no minor unit; every other one has two. */
const NO_MINOR_UNIT = new Set(['CLP', 'JPY', 'KRW', 'PYG', 'VND', 'XAF', 'XOF']);

/** Lowercase, without accents, with runs of spaces as one. */
const fold = (text: string): string =>
  text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ');

/** Sentences: a line, or text up to `;`, `!`, `?` or a full stop that is not a decimal point. */
const sentencesOf = (text: string): string[] =>
  fold(text)
    .split(/[\n;!?]|\.(?!\d)/)
    .map((s) => s.trim())
    .filter((s) => s !== '');

const CURRENCY_MARK =
  '(?:us\\$|s\\/\\.?|\\$|€|£|usd|pen|eur|mxn|cop|clp|ars|soles?|dolares?|euros?|pesos?)';
// A figure: 1234, 1.234, 1,234.50, 1.234,50, 25,5, 25.50.
const FIGURE = '(\\d{1,3}(?:[.,\\s]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';

/** The amounts of money in a sentence, with or after a currency mark. */
function amountsIn(sentence: string): { readonly value: number; readonly text: string }[] {
  const found: { value: number; text: string }[] = [];
  const before = new RegExp(`${CURRENCY_MARK}\\s?${FIGURE}`, 'g');
  const after = new RegExp(`${FIGURE}\\s?${CURRENCY_MARK}(?![a-z])`, 'g');
  for (const pattern of [before, after]) {
    for (const match of sentence.matchAll(pattern)) {
      const value = parseFigure(match[1] ?? '');
      if (value !== undefined) found.push({ value, text: match[0].trim() });
    }
  }
  return found;
}

/** The numbers in a sentence followed by the unit, e.g. `30 min` for unit `min`. */
function quantitiesIn(
  sentence: string,
  unit: string,
): { readonly value: number; readonly text: string }[] {
  const escaped = fold(unit).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  if (escaped.trim() === '') return [];
  const pattern = new RegExp(`${FIGURE}\\s?${escaped}(?![a-z])`, 'g');
  return [...sentence.matchAll(pattern)].flatMap((match) => {
    const value = parseFigure(match[1] ?? '');
    return value === undefined ? [] : [{ value, text: match[0].trim() }];
  });
}

/**
 * A figure as a number. With both `.` and `,`, the last one is the decimal mark. With one of
 * them, followed by exactly three digits (once or more), it groups thousands; otherwise it is the
 * decimal mark.
 */
export function parseFigure(text: string): number | undefined {
  const raw = text.replace(/\s/g, '');
  if (raw === '') return undefined;
  const lastDot = raw.lastIndexOf('.');
  const lastComma = raw.lastIndexOf(',');
  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    normalized = raw.split(group).join('').replace(decimal, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const mark = lastDot >= 0 ? '.' : ',';
    const parts = raw.split(mark);
    const grouped = parts.length > 1 && parts.slice(1).every((p) => p.length === 3);
    normalized = grouped ? parts.join('') : parts.join('.');
  } else {
    normalized = raw;
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

const recordedOf = (value: FigureFact['value']): { readonly value: number; text: string } => {
  if (value.type === 'money') {
    const digits = NO_MINOR_UNIT.has(value.currency.toUpperCase()) ? 0 : 2;
    const amount = value.amountMinor / 10 ** digits;
    return { value: amount, text: `${value.currency} ${amount.toFixed(digits)}` };
  }
  return {
    value: value.number,
    text: value.unit === undefined ? String(value.number) : `${value.number} ${value.unit}`,
  };
};

/** Whether `sentence` names `label` as a whole phrase. */
const names = (sentence: string, label: string): boolean => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`).test(sentence);
};

/**
 * The figures `text` gives for facts it names that disagree with what Company Brain records. A
 * sentence that names a fact and gives at least one figure of its kind contradicts it when none
 * of those figures is the recorded one. Labels shorter than three characters are never matched.
 */
export function figureContradictions(
  text: string,
  facts: readonly FigureFact[],
): readonly FigureContradiction[] {
  const sentences = sentencesOf(text);
  const found: FigureContradiction[] = [];
  for (const fact of facts) {
    const label = fold(fact.label).trim();
    if (label.length < 3) continue;
    if (fact.value.type === 'number' && fact.value.unit === undefined) continue;
    const recorded = recordedOf(fact.value);
    for (const sentence of sentences) {
      if (!names(sentence, label)) continue;
      const figures =
        fact.value.type === 'money'
          ? amountsIn(sentence)
          : quantitiesIn(sentence, fact.value.unit ?? '');
      if (figures.length === 0) continue;
      if (figures.some((f) => Math.abs(f.value - recorded.value) < 0.005)) continue;
      const [first] = figures;
      found.push(
        Object.freeze({
          factId: fact.id,
          label: fact.label,
          recorded: recorded.text,
          stated: first?.text ?? '',
          confirmed: fact.confirmed,
        }),
      );
      break;
    }
  }
  return Object.freeze(found);
}

/** Facts a person confirmed, or that MelonOffice calculated or imported, count as confirmed. */
const CONFIRMED: ReadonlySet<string> = new Set(['confirmed', 'calculated', 'imported']);

/**
 * The figures among Company Brain's items, as the checks above read them: active money and number
 * facts with a name (their label, or their subject's id). With `access`, only those a department
 * may read: its domains, up to its sensitivity ceiling.
 */
export function figureFactsOf(
  items: readonly Pick<
    KnowledgeItem,
    'id' | 'label' | 'subject' | 'value' | 'status' | 'verification' | 'domain' | 'sensitivity'
  >[],
  access?: PurposeAccess,
): readonly FigureFact[] {
  return items.flatMap((item): FigureFact[] => {
    const label = item.label ?? item.subject?.id.replace(/_/g, ' ');
    if (label === undefined || item.status !== 'active') return [];
    if (item.value.type !== 'money' && item.value.type !== 'number') return [];
    if (
      access !== undefined &&
      (!access.domains.includes(item.domain) ||
        !sensitivityAllows(access.maxSensitivity, item.sensitivity))
    ) {
      return [];
    }
    return [{ id: item.id, label, value: item.value, confirmed: CONFIRMED.has(item.verification) }];
  });
}
