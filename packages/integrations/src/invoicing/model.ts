import type { FiscalAmount, InvoicingConnection, InvoicingSyncJob } from '@melonoffice/domain';
import { createHash } from 'node:crypto';
import { isProviderId } from '../registry.js';
import { isConnectionStatus } from '../lifecycle.js';
import { IntegrationError } from '../errors.js';
import { isInvoicingSecretRef } from '../secrets.js';
import {
  isInvoicingCapabilities,
  isInvoicingRecordType,
  type NormalizedDocument,
  type NormalizedInvoicingRecord,
  type NormalizedParty,
  type NormalizedPayment,
} from './contract.js';

/**
 * Checks for what an adapter hands the gateway and for what storage hands back (ADR-0193). A
 * record that fails is refused with a stable code and counted; it is never kept half-checked.
 * Jurisdiction-neutral: a country's own codes (SUNAT's document types, RUC check digits) are its
 * adapter's to check.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXTERNAL_ID = /^[\x21-\x7e]{1,128}$/;
const DECIMAL = /^-?(0|[1-9]\d{0,14})(\.\d{1,10})?$/;
const CURRENCY = /^[A-Z]{3}$/;
const COUNTRY = /^[A-Z]{2}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CODE = /^[A-Za-z0-9._:-]{1,32}$/;
const TAX_SCHEME = /^[A-Z]{2}:[A-Z0-9_]{1,16}$/;
const TAX_VALUE = /^[A-Za-z0-9-]{1,32}$/;
const FORMAT = /^[a-z][a-z0-9_]{1,40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const MAX_LINES = 1000;
export const MAX_RELATIONS = 50;
export const MAX_APPLIES_TO = 200;
/** The largest original content one record may come from. */
export const MAX_ORIGINAL_BYTES = 2 * 1024 * 1024;
/** How many refused records a sync lists; the count has them all. */
export const MAX_REJECTIONS = 100;
const MAX_TEXT = 500;

export const isInvoicingId = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);

const refuse = (code: string): never => {
  throw new IntegrationError('invalid_payload', code);
};

function text(value: unknown, code: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') refuse(code);
  const s = (value as string).trim();
  if (s.length === 0 || s.length > max || CONTROL.test(s)) refuse(code);
  return s;
}

function optionalText(value: unknown, code: string, max = MAX_TEXT): void {
  if (value !== undefined) text(value, code, max);
}

export function isDecimal(value: unknown): value is string {
  return typeof value === 'string' && DECIMAL.test(value);
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

function amount(value: unknown, code: string, currency?: string): FiscalAmount {
  const a = value as FiscalAmount | undefined;
  if (typeof a !== 'object' || a === null || !isDecimal(a.value) || !CURRENCY.test(a.currency)) {
    refuse(code);
  }
  if (currency !== undefined && (a as FiscalAmount).currency !== currency)
    refuse(`${code}.currency`);
  return a as FiscalAmount;
}

function taxId(value: unknown, code: string): void {
  if (value === undefined) return;
  const t = value as { scheme?: unknown; value?: unknown };
  if (
    typeof t !== 'object' ||
    t === null ||
    typeof t.scheme !== 'string' ||
    !TAX_SCHEME.test(t.scheme) ||
    typeof t.value !== 'string' ||
    !TAX_VALUE.test(t.value)
  ) {
    refuse(code);
  }
}

function base(record: NormalizedInvoicingRecord): void {
  if (typeof record.externalId !== 'string' || !EXTERNAL_ID.test(record.externalId)) {
    refuse('externalId');
  }
  const o = record.original as { format?: unknown; content?: unknown } | undefined;
  if (
    typeof o !== 'object' ||
    o === null ||
    typeof o.format !== 'string' ||
    !FORMAT.test(o.format) ||
    typeof o.content !== 'string' ||
    o.content.length === 0 ||
    Buffer.byteLength(o.content) > MAX_ORIGINAL_BYTES
  ) {
    refuse('original');
  }
}

function checkParty(p: NormalizedParty): void {
  text(p.legalName, 'legalName');
  taxId(p.taxId, 'taxId');
  if (
    !Array.isArray(p.roles) ||
    p.roles.length === 0 ||
    !p.roles.every((r) => r === 'customer' || r === 'supplier')
  ) {
    refuse('roles');
  }
  if (p.country !== undefined && !COUNTRY.test(p.country)) refuse('country');
}

const DOCUMENT_TYPES = ['invoice', 'receipt', 'credit_note', 'debit_note', 'other'];
const AUTHORITY = [
  'not_reported',
  'pending',
  'accepted',
  'accepted_with_observations',
  'rejected',
  'not_found',
];
const VOID = ['none', 'requested', 'voided'];
const RELATIONS = ['credits', 'debits', 'voids', 'replaces', 'references'];

function checkDocument(d: NormalizedDocument): void {
  if (d.direction !== 'issued' && d.direction !== 'received') refuse('direction');
  if (!DOCUMENT_TYPES.includes(d.type)) refuse('type');
  if (typeof d.sourceType !== 'string' || !CODE.test(d.sourceType)) refuse('sourceType');
  optionalText(d.series, 'series', 32);
  text(d.number, 'number', 32);
  if (!isCalendarDate(d.issueDate)) refuse('issueDate');
  if (d.dueDate !== undefined && !isCalendarDate(d.dueDate)) refuse('dueDate');
  if (typeof d.issuer !== 'object' || d.issuer === null) refuse('issuer');
  text(d.issuer.legalName, 'issuer.legalName');
  taxId(d.issuer.taxId, 'issuer.taxId');
  if (d.counterparty !== undefined) {
    text(d.counterparty.legalName, 'counterparty.legalName');
    taxId(d.counterparty.taxId, 'counterparty.taxId');
  }
  if (!CURRENCY.test(d.currency)) refuse('currency');
  amount(d.netTotal, 'netTotal', d.currency);
  amount(d.taxTotal, 'taxTotal', d.currency);
  amount(d.total, 'total', d.currency);
  if (!Array.isArray(d.lines) || d.lines.length > MAX_LINES) refuse('lines');
  d.lines.forEach((line, i) => {
    if (line.position !== i + 1) refuse('lines.position');
    text(line.description, 'lines.description');
    if (!isDecimal(line.quantity)) refuse('lines.quantity');
    if (line.unitPrice !== undefined) amount(line.unitPrice, 'lines.unitPrice', d.currency);
    amount(line.net, 'lines.net', d.currency);
    if (line.tax !== undefined) amount(line.tax, 'lines.tax', d.currency);
    if (line.unitCode !== undefined && !CODE.test(line.unitCode)) refuse('lines.unitCode');
    if (line.taxCategory !== undefined && !CODE.test(line.taxCategory)) {
      refuse('lines.taxCategory');
    }
    optionalText(line.productCode, 'lines.productCode', 64);
  });
  if (!Array.isArray(d.relations) || d.relations.length > MAX_RELATIONS) refuse('relations');
  for (const r of d.relations) {
    if (!RELATIONS.includes(r.type)) refuse('relations.type');
    if (r.targetExternalId === undefined && r.targetNumber === undefined) {
      refuse('relations.target');
    }
    if (r.targetExternalId !== undefined && !EXTERNAL_ID.test(r.targetExternalId)) {
      refuse('relations.targetExternalId');
    }
    optionalText(r.targetSeries, 'relations.targetSeries', 32);
    optionalText(r.targetNumber, 'relations.targetNumber', 32);
    if (r.targetSourceType !== undefined && !CODE.test(r.targetSourceType)) {
      refuse('relations.targetSourceType');
    }
  }
  if (!AUTHORITY.includes(d.authorityStatus)) refuse('authorityStatus');
  if (d.authorityStatusCode !== undefined && !CODE.test(d.authorityStatusCode)) {
    refuse('authorityStatusCode');
  }
  if (!VOID.includes(d.voidStatus)) refuse('voidStatus');
}

function checkPayment(p: NormalizedPayment): void {
  if (!['recorded', 'confirmed', 'reversed'].includes(p.status)) refuse('status');
  const a = amount(p.amount, 'amount');
  if (!isCalendarDate(p.paidOn)) refuse('paidOn');
  if (p.method !== undefined && !CODE.test(p.method)) refuse('method');
  if (!Array.isArray(p.appliesTo) || p.appliesTo.length > MAX_APPLIES_TO) refuse('appliesTo');
  for (const applied of p.appliesTo) {
    if (!EXTERNAL_ID.test(applied.externalId)) refuse('appliesTo.externalId');
    amount(applied.amount, 'appliesTo.amount', a.currency);
  }
}

/**
 * Checks one record an adapter normalized, for the record type that was asked for. Throws
 * `invalid_payload` with a stable detail (the field), never with the record's content.
 */
export function checkNormalizedRecord(
  record: NormalizedInvoicingRecord,
  expected: NormalizedInvoicingRecord['recordType'],
): void {
  if (typeof record !== 'object' || record === null) refuse('record');
  if (!isInvoicingRecordType(record.recordType) || record.recordType !== expected) {
    refuse('recordType');
  }
  base(record);
  if (record.recordType === 'party') checkParty(record);
  else if (record.recordType === 'document') checkDocument(record);
  else checkPayment(record);
}

/** SHA-256 of the original content, hex: what traces a record back to what the provider sent. */
export const digestOf = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

const SCALE = 10n ** 10n;

function toUnits(value: string): bigint {
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const units = BigInt(whole as string) * SCALE + BigInt(fraction.padEnd(10, '0'));
  return negative ? -units : units;
}

function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE;
  const fraction = (abs % SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  const s = fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
  return negative && abs !== 0n ? `-${s}` : s;
}

/** Exact decimal sum of amounts in one currency: never a float. */
export function sumAmounts(amounts: readonly FiscalAmount[], currency: string): FiscalAmount {
  let total = 0n;
  for (const a of amounts) {
    if (a.currency !== currency || !isDecimal(a.value)) {
      throw new IntegrationError('invalid_payload', 'amount.currency');
    }
    total += toUnits(a.value);
  }
  return { value: fromUnits(total), currency };
}

/** Checks a connection read back from storage. Bad data is refused, never used. */
export function checkStoredInvoicingConnection(c: InvoicingConnection): InvoicingConnection {
  if (
    !isInvoicingId(c.id) ||
    !isInvoicingId(c.organizationId) ||
    !isProviderId(c.provider) ||
    c.category !== 'invoicing' ||
    !COUNTRY.test(c.jurisdiction) ||
    !isConnectionStatus(c.status) ||
    (c.statusReason !== undefined && c.status !== 'error') ||
    typeof c.account !== 'object' ||
    c.account === null ||
    Object.keys(c.account).length > 8 ||
    !Object.values(c.account).every((v) => typeof v === 'string' && v.length <= 64) ||
    !isInvoicingCapabilities(c.capabilities) ||
    !Object.values(c.secrets).every(
      (ref) => isInvoicingSecretRef(ref) && ref.includes(`/secrets/invoicing-${c.id}-`),
    ) ||
    !isInvoicingId(c.createdBy) ||
    !isInvoicingId(c.updatedBy) ||
    !Number.isSafeInteger(c.revision) ||
    c.revision < 1
  ) {
    throw new IntegrationError('invalid_connection', 'stored');
  }
  return c;
}

/** Statuses a sync may move between. `completed`, `incomplete` and `failed` are final. */
const SYNC_TRANSITIONS: Readonly<Record<InvoicingSyncJob['status'], readonly string[]>> = {
  queued: ['running', 'queued', 'incomplete', 'failed'],
  running: ['running', 'queued', 'completed', 'incomplete', 'failed'],
  completed: [],
  incomplete: [],
  failed: [],
};

export const canMoveSync = (
  from: InvoicingSyncJob['status'],
  to: InvoicingSyncJob['status'],
): boolean => SYNC_TRANSITIONS[from].includes(to);

export const isFinalSync = (job: Pick<InvoicingSyncJob, 'status'>): boolean =>
  job.status === 'completed' || job.status === 'incomplete' || job.status === 'failed';
