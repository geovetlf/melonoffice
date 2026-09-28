import type {
  KnowledgeDomain,
  KnowledgeRelation,
  KnowledgeRelationType,
  KnowledgeSubject,
  KnowledgeSubjectType,
  KnowledgeValue,
  OrganizationId,
} from '@melonoffice/domain';
import { createHash } from 'node:crypto';
import { isKnowledgeDomain, LIMITS, SUBJECT_TYPES } from './catalogue.js';
import { BrainError } from './errors.js';

/**
 * Checking what enters Company Brain (ADR-0051): every field is closed and bounded, whoever sends
 * it (a person, GIA's extraction, a document or an integration). Nothing is completed or guessed.
 */

/** One fact as a source states it, before Company Brain decides what it becomes. */
export interface KnowledgeInput {
  readonly domain: KnowledgeDomain;
  readonly key: string;
  readonly subject?: KnowledgeSubject;
  readonly label?: string;
  readonly value: KnowledgeValue;
  readonly relations?: readonly KnowledgeRelation[];
  readonly effectiveFrom?: string;
  /** 0 to 1, from an extraction. */
  readonly confidence?: number;
}

const KEY = /^[a-z][a-z0-9_]*$/;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/;
const CURRENCY = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNIT = /^[A-Za-z%][A-Za-z0-9_%/ ]{0,19}$/;
const RELATIONS: readonly KnowledgeRelationType[] = [
  'belongs_to',
  'used_in',
  'targets',
  'has_price',
  'part_of',
  'related_to',
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const onlyKeys = (v: Record<string, unknown>, allowed: readonly string[]): boolean =>
  Object.keys(v).every((k) => allowed.includes(k));

/** One line of text: trimmed, no control characters, not blank, bounded. */
function line(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') throw new BrainError('invalid_knowledge', field);
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (text === '' || text.length > max) throw new BrainError('invalid_knowledge', field);
  return text;
}

export function checkSubject(value: unknown): KnowledgeSubject {
  if (!isRecord(value) || !onlyKeys(value, ['type', 'id'])) {
    throw new BrainError('invalid_knowledge', 'subject');
  }
  const { type, id } = value;
  if (!SUBJECT_TYPES.includes(type as KnowledgeSubjectType)) {
    throw new BrainError('invalid_knowledge', 'subject');
  }
  if (typeof id !== 'string' || id.length > LIMITS.subjectIdLength || !SLUG.test(id)) {
    throw new BrainError('invalid_knowledge', 'subject');
  }
  return Object.freeze({ type: type as KnowledgeSubjectType, id });
}

export function checkValue(value: unknown): KnowledgeValue {
  if (!isRecord(value)) throw new BrainError('invalid_knowledge', 'value');
  switch (value.type) {
    case 'text':
      if (!onlyKeys(value, ['type', 'text'])) break;
      return Object.freeze({ type: 'text', text: line(value.text, LIMITS.textLength, 'value') });
    case 'number': {
      if (!onlyKeys(value, ['type', 'number', 'unit'])) break;
      const { number, unit } = value;
      if (typeof number !== 'number' || !Number.isFinite(number)) break;
      if (unit !== undefined && (typeof unit !== 'string' || !UNIT.test(unit))) break;
      return Object.freeze({ type: 'number', number, ...(unit === undefined ? {} : { unit }) });
    }
    case 'money': {
      if (!onlyKeys(value, ['type', 'amountMinor', 'currency'])) break;
      const { amountMinor, currency } = value;
      if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) break;
      if (typeof currency !== 'string' || !CURRENCY.test(currency)) break;
      return Object.freeze({ type: 'money', amountMinor, currency });
    }
    case 'boolean':
      if (!onlyKeys(value, ['type', 'value']) || typeof value.value !== 'boolean') break;
      return Object.freeze({ type: 'boolean', value: value.value });
    case 'list': {
      if (!onlyKeys(value, ['type', 'items']) || !Array.isArray(value.items)) break;
      if (value.items.length === 0 || value.items.length > LIMITS.listItems) break;
      const items = value.items.map((item) => line(item, LIMITS.listItemLength, 'value'));
      return Object.freeze({ type: 'list', items: Object.freeze(items) });
    }
    case 'date': {
      if (!onlyKeys(value, ['type', 'date']) || typeof value.date !== 'string') break;
      if (!DATE.test(value.date) || Number.isNaN(Date.parse(`${value.date}T00:00:00Z`))) break;
      return Object.freeze({ type: 'date', date: value.date });
    }
    default:
      break;
  }
  throw new BrainError('invalid_knowledge', 'value');
}

export function checkKnowledgeInput(value: unknown): KnowledgeInput {
  const allowed = [
    'domain',
    'key',
    'subject',
    'label',
    'value',
    'relations',
    'effectiveFrom',
    'confidence',
  ];
  if (!isRecord(value)) throw new BrainError('invalid_knowledge', 'input');
  const unknown = Object.keys(value).find((k) => !allowed.includes(k));
  if (unknown !== undefined) throw new BrainError('invalid_knowledge', unknown);
  const { domain, key, subject, label, relations, effectiveFrom, confidence } = value;
  if (!isKnowledgeDomain(domain)) throw new BrainError('invalid_knowledge', 'domain');
  if (typeof key !== 'string' || key.length > LIMITS.keyLength || !KEY.test(key)) {
    throw new BrainError('invalid_knowledge', 'key');
  }
  let checkedRelations: KnowledgeRelation[] | undefined;
  if (relations !== undefined) {
    if (!Array.isArray(relations) || relations.length > LIMITS.relations) {
      throw new BrainError('invalid_knowledge', 'relations');
    }
    checkedRelations = relations.map((r: unknown) => {
      if (!isRecord(r) || !onlyKeys(r, ['type', 'to'])) {
        throw new BrainError('invalid_knowledge', 'relations');
      }
      if (!RELATIONS.includes(r.type as KnowledgeRelationType)) {
        throw new BrainError('invalid_knowledge', 'relations');
      }
      return Object.freeze({ type: r.type as KnowledgeRelationType, to: checkSubject(r.to) });
    });
  }
  if (
    effectiveFrom !== undefined &&
    (typeof effectiveFrom !== 'string' || Number.isNaN(Date.parse(effectiveFrom)))
  ) {
    throw new BrainError('invalid_knowledge', 'effectiveFrom');
  }
  if (
    confidence !== undefined &&
    (typeof confidence !== 'number' || !(confidence >= 0 && confidence <= 1))
  ) {
    throw new BrainError('invalid_knowledge', 'confidence');
  }
  return Object.freeze({
    domain,
    key,
    ...(subject === undefined ? {} : { subject: checkSubject(subject) }),
    ...(label === undefined ? {} : { label: line(label, LIMITS.labelLength, 'label') }),
    value: checkValue(value.value),
    ...(checkedRelations === undefined ? {} : { relations: Object.freeze(checkedRelations) }),
    ...(effectiveFrom === undefined
      ? {}
      : { effectiveFrom: new Date(effectiveFrom as string).toISOString() }),
    ...(confidence === undefined ? {} : { confidence: confidence as number }),
  });
}

/**
 * The id of the item a fact belongs to: the same organization, domain, key and subject is the
 * same item, whichever source states it. That is how a second source meets the first (and a
 * disagreement becomes a conflict, not a duplicate).
 */
export function knowledgeItemId(
  organizationId: OrganizationId,
  domain: KnowledgeDomain,
  key: string,
  subject?: KnowledgeSubject,
): string {
  const hash = createHash('sha256')
    .update([domain, key, subject?.type ?? '', subject?.id ?? ''].join('\u0000'))
    .digest('hex')
    .slice(0, 32);
  return `${organizationId}_k_${hash}`;
}

export function sameValue(a: KnowledgeValue, b: KnowledgeValue): boolean {
  switch (a.type) {
    case 'text':
      return b.type === 'text' && a.text === b.text;
    case 'number':
      return b.type === 'number' && a.number === b.number && a.unit === b.unit;
    case 'money':
      return b.type === 'money' && a.amountMinor === b.amountMinor && a.currency === b.currency;
    case 'boolean':
      return b.type === 'boolean' && a.value === b.value;
    case 'list':
      return (
        b.type === 'list' &&
        a.items.length === b.items.length &&
        a.items.every((item, i) => item === b.items[i])
      );
    case 'date':
      return b.type === 'date' && a.date === b.date;
  }
}

/** A value as one short line for a model's context: no formatting beyond what is stored. */
export function valueText(value: KnowledgeValue): string {
  switch (value.type) {
    case 'text':
      return value.text;
    case 'number':
      return value.unit === undefined ? String(value.number) : `${value.number} ${value.unit}`;
    case 'money': {
      const digits = minorDigits(value.currency);
      return `${(value.amountMinor / 10 ** digits).toFixed(digits)} ${value.currency}`;
    }
    case 'boolean':
      return value.value ? 'yes' : 'no';
    case 'list':
      return value.items.join('; ');
    case 'date':
      return value.date;
  }
}

/** How many minor units a currency has (2 for PEN, 0 for CLP or PYG), from Intl. */
export function minorDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/** A copy without one field (used to drop an optional field that no longer applies). */
export function omit<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key)) as Omit<T, K>;
}
