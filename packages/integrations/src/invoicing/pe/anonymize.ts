import { IntegrationError } from '../../errors.js';
import type { NormalizedDocument } from '../contract.js';
import { decodeXml, parseXml, type XmlElement } from '../xml.js';
import { isValidRuc } from './sunat.js';
import { readPeUbl } from './ubl.js';

/**
 * Local anonymization of SUNAT UBL 2.1 files a customer exports (ADR-0193, procedure in
 * `fixtures/ANONYMIZE.md`), so they can test the adapter without anyone keeping identifiable
 * fiscal documents. It runs on the machine that holds the files and sends nothing anywhere.
 *
 * Every identifier, name, address, contact, description, product code, bank account, legend and
 * signature value is replaced; amounts, dates, codes, series, numbers and the structure are kept,
 * because they are what the adapter reads. The same original always gets the same replacement
 * within one run, so a note still points at its invoice.
 *
 * It refuses rather than guesses: a file is returned only when (1) no original value it replaced
 * is left in the output, in text, CDATA or attributes, (2) every valid RUC left is a synthetic
 * one, and (3) the adapter reads the output exactly as it read the original, apart from the
 * replaced fields. The originals and the table of replacements stay in memory.
 */

const NS = {
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  ds: 'http://www.w3.org/2000/09/xmldsig#',
} as const;

/** Parent → child pairs whose text identifies someone. */
const IDENTIFIERS: readonly (readonly [string, string])[] = [
  ['PartyIdentification', 'ID'],
  ['PartyTaxScheme', 'CompanyID'],
  ['PartyLegalEntity', 'CompanyID'],
];
const NAMES: readonly (readonly [string, string])[] = [
  ['PartyLegalEntity', 'RegistrationName'],
  ['PartyTaxScheme', 'RegistrationName'],
  ['PartyName', 'Name'],
  ['Contact', 'Name'],
  ['Person', 'FirstName'],
  ['Person', 'FamilyName'],
];
/** Any cbc element with these names, wherever it is. */
const FREE_TEXT = new Set([
  'StreetName',
  'AdditionalStreetName',
  'BuildingNumber',
  'CityName',
  'CitySubdivisionName',
  'CountrySubentity',
  'District',
  'PostalZone',
  'ElectronicMail',
  'Telephone',
  'Telefax',
  'Note',
  'Description',
  'URI',
]);
const CODES: readonly (readonly [string, string])[] = [
  ['SellersItemIdentification', 'ID'],
  ['BuyersItemIdentification', 'ID'],
  ['StandardItemIdentification', 'ID'],
  ['PayeeFinancialAccount', 'ID'],
  ['PayerFinancialAccount', 'ID'],
  ['AddressLine', 'Line'],
  ['Signature', 'ID'],
  ['OrderReference', 'ID'],
  ['DespatchDocumentReference', 'ID'],
];
/** Values too short or too common to replace by value: they would hit unrelated text. */
const KEEP = /^(?:-|0+|[A-Za-z]{0,2}|\d{1,3})$/;
const DIGITS_11 = /\b\d{11}\b/g;
/** Base64 of `ANONIMIZADO`: a signature value is not kept, not even its shape. */
const SIGNATURE_PLACEHOLDER = 'QU5PTklNSVpBRE8=';

export interface AnonymizedFile {
  readonly content: Uint8Array;
  /** How many values of each kind were replaced: counts only, never the values. */
  readonly replaced: Readonly<
    Record<'identifier' | 'name' | 'text' | 'code' | 'signature', number>
  >;
}

export interface UblAnonymizer {
  /** The synthetic RUC that stands for an original one in this run, for the test connection. */
  rucFor(original: string): string;
  anonymize(content: Uint8Array, account: { readonly taxId: string }): AnonymizedFile;
}

type Kind = keyof AnonymizedFile['replaced'];

const refuse = (detail: string): never => {
  throw new IntegrationError('invalid_file', `anonymize.${detail}`);
};

/** A valid RUC with the same type prefix, from a range no real taxpayer is expected to hold. */
function syntheticRuc(prefix: string, n: number): string {
  const base = `${prefix}999${String(n).padStart(5, '0')}`;
  for (let check = 0; check <= 9; check += 1) {
    if (isValidRuc(`${base}${check}`)) return `${base}${check}`;
  }
  return refuse('ruc');
}

export function createUblAnonymizer(): UblAnonymizer {
  const table = new Map<string, string>();
  const synthetic = new Set<string>();
  // An original that equals a replacement identifies no one (a placeholder already in the file).
  const replacements = new Set<string>([SIGNATURE_PLACEHOLDER]);
  let rucs = 0;
  let others = 0;
  const replacementFor = (original: string, kind: Kind): string => {
    const known = table.get(original);
    if (known !== undefined) return known;
    let next: string;
    if (/^(10|15|17|20)\d{9}$/.test(original) && isValidRuc(original)) {
      next = syntheticRuc(original.slice(0, 2), ++rucs);
      synthetic.add(next);
    } else if (kind === 'identifier' && /^\d{8}$/.test(original)) {
      next = String(++others).padStart(8, '0');
    } else if (kind === 'signature') {
      next = SIGNATURE_PLACEHOLDER;
    } else if (kind === 'identifier' || kind === 'code') {
      next = `ANON-${String(++others).padStart(6, '0')}`;
    } else {
      next = `ANONIMIZADO ${kind.toUpperCase()} ${String(++others).padStart(6, '0')}`;
    }
    table.set(original, next);
    replacements.add(next);
    return next;
  };

  return {
    rucFor(original) {
      if (!isValidRuc(original)) return refuse('account');
      return replacementFor(original, 'identifier');
    },
    anonymize(content, account) {
      const text = decodeXml(content);
      const root = parseXml(text);
      const before = readPeUbl(text, account);
      const found = new Map<string, Kind>();
      collect(root, undefined, found);
      // A RUC written anywhere else (a legend, a certificate subject) goes too.
      for (const element of walk(root)) {
        for (const value of [element.text, ...Object.values(element.attributes)]) {
          for (const match of value.match(DIGITS_11) ?? []) {
            if (isValidRuc(match) && !synthetic.has(match)) found.set(match, 'identifier');
          }
        }
      }
      const replaced: Record<Kind, number> = {
        identifier: 0,
        name: 0,
        text: 0,
        code: 0,
        signature: 0,
      };
      // Longest first, so a value inside another is not replaced half-way.
      const values = [...found.entries()]
        .filter(([value]) => !KEEP.test(value) && !replacements.has(value))
        .sort(([a], [b]) => b.length - a.length);
      const pairs = values.map(([value, kind]) => {
        replaced[kind] += 1;
        return [value, replacementFor(value, kind)] as const;
      });
      const output = replaceInText(text, pairs);
      const result = encode(output, text);
      verify(output, values, synthetic, before, {
        taxId: replacementFor(account.taxId, 'identifier'),
      });
      return { content: result, replaced };
    },
  };
}

function* walk(element: XmlElement): Generator<XmlElement> {
  yield element;
  for (const child of element.children) yield* walk(child);
}

function collect(element: XmlElement, parent: XmlElement | undefined, found: Map<string, Kind>) {
  const value = element.text.trim();
  const pair = (list: readonly (readonly [string, string])[]) =>
    parent !== undefined &&
    list.some(([p, c]) => parent.local === p && element.local === c && parent.ns === NS.cac);
  if (value !== '') {
    if (element.ns === NS.ds) found.set(value, 'signature');
    else if (pair(IDENTIFIERS)) found.set(value, 'identifier');
    else if (pair(NAMES)) found.set(value, 'name');
    else if (pair(CODES)) found.set(value, 'code');
    else if (element.ns === NS.cbc && FREE_TEXT.has(element.local)) found.set(value, 'text');
  }
  for (const child of element.children) collect(child, element, found);
}

const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Text the reader already accepted, with its references decoded. */
const decoded = (raw: string) =>
  raw.replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, name: string) =>
    name.startsWith('#x')
      ? String.fromCodePoint(Number.parseInt(name.slice(2), 16))
      : name.startsWith('#')
        ? String.fromCodePoint(Number(name.slice(1)))
        : (PREDEFINED[name] as string),
  );

/** Escaped again; anything outside ASCII as a reference, so any declared encoding holds it. */
const escaped = (text: string) =>
  text.replace(/[&<>]|[^\t\n\r\x20-\x7E]/gu, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : `&#${c.codePointAt(0)};`,
  );

/**
 * Replaces values only in text and CDATA, never inside markup, so a value that happens to equal
 * a tag name cannot break the document; comments are dropped. A text written with references is compared decoded and
 * written back escaped. What is left in attributes is caught by `verify`.
 */
function replaceInText(xml: string, pairs: readonly (readonly [string, string])[]): string {
  const parts = xml.split(/(<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>)/);
  const swap = (text: string) => {
    let out = text;
    for (const [value, replacement] of pairs) out = out.split(value).join(replacement);
    return out;
  };
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        if (part.startsWith('<![CDATA[')) return `<![CDATA[${swap(part.slice(9, -3))}]]>`;
        // A comment can say anything and nothing reads it: dropped.
        return part.startsWith('<!--') ? '' : part;
      }
      const text = decoded(part);
      const out = swap(text);
      return out === text ? part : escaped(out);
    })
    .join('');
}

function encode(output: string, original: string): Uint8Array {
  const latin = /^(?:\uFEFF)?<\?xml[^>]*\bencoding\s*=\s*["'](?:iso-8859-1|latin1)["']/i.test(
    original,
  );
  return latin ? Uint8Array.from(Buffer.from(output, 'latin1')) : new TextEncoder().encode(output);
}

function verify(
  output: string,
  values: readonly (readonly [string, Kind])[],
  synthetic: ReadonlySet<string>,
  before: NormalizedDocument,
  account: { readonly taxId: string },
) {
  const root = parseXml(output);
  const everything = [...walk(root)].flatMap((e) => [e.text, ...Object.values(e.attributes)]);
  for (const [value] of values) {
    if (output.includes(value) || everything.some((t) => t.includes(value))) refuse('leftover');
  }
  for (const t of [output, ...everything]) {
    for (const match of t.match(DIGITS_11) ?? []) {
      if (isValidRuc(match) && !synthetic.has(match)) refuse('leftover');
    }
  }
  const after = readPeUbl(output, account);
  if (JSON.stringify(shapeOf(after)) !== JSON.stringify(shapeOf(before))) refuse('changed');
}

/** What the adapter reads that anonymization must not change. */
const shapeOf = (d: NormalizedDocument) => ({
  direction: d.direction,
  type: d.type,
  sourceType: d.sourceType,
  series: d.series,
  number: d.number,
  issueDate: d.issueDate,
  dueDate: d.dueDate,
  currency: d.currency,
  netTotal: d.netTotal,
  taxTotal: d.taxTotal,
  total: d.total,
  counterparty: d.counterparty === undefined ? 'none' : (d.counterparty.taxId?.scheme ?? 'name'),
  lines: d.lines.map((l) => [l.quantity, l.unitCode, l.unitPrice, l.net, l.tax, l.taxCategory]),
  relations: d.relations,
});
