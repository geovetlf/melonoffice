import { IntegrationError } from '../errors.js';

/**
 * A small, strict XML reader for the files invoicing adapters import (ADR-0193): elements,
 * attributes, text, CDATA and namespaces, nothing else. A document type declaration (`<!DOCTYPE`)
 * is refused outright, so no entity can be declared, expanded or fetched (no XXE, no entity
 * expansion), and only the five predefined entities and character references are read. Depth and
 * size are bounded.
 *
 * It does not validate against a schema and does not verify signatures: an adapter checks the
 * fields it reads, and says what it could not check.
 */

export interface XmlElement {
  /** The namespace URI, or `''` for none. */
  readonly ns: string;
  readonly local: string;
  /** Attributes by their name as written (`schemeID`, `xmlns:cbc`); namespaced ones keep a prefix. */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The element's own text (its children's text aside), entities decoded. */
  readonly text: string;
}

export const MAX_XML_DEPTH = 64;
export const MAX_XML_ELEMENTS = 50_000;

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*(?::[A-Za-z_][A-Za-z0-9_.-]*)?$/;
const XML_NS = 'http://www.w3.org/XML/1998/namespace';
/** Characters XML 1.0 never allows, written or referenced. */
// eslint-disable-next-line no-control-regex
const NOT_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/;
const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

const refuse = (detail: string): never => {
  throw new IntegrationError('invalid_file', detail);
};

/**
 * Decodes an XML file's bytes: UTF-8 (the default, with or without a byte order mark) or
 * ISO-8859-1 when its declaration says so. Any other encoding, or bytes that are not valid in
 * the one declared, are refused.
 */
export function decodeXml(content: Uint8Array): string {
  const head = Buffer.from(content.subarray(0, 200)).toString('latin1');
  const declared =
    /^(?:\uFEFF|\u00EF\u00BB\u00BF)?<\?xml[^>]*\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(
      head,
    )?.[1];
  const encoding = (declared ?? 'utf-8').toLowerCase();
  if (encoding === 'utf-8' || encoding === 'utf8') {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(content);
    } catch {
      return refuse('encoding');
    }
  }
  if (encoding === 'iso-8859-1' || encoding === 'latin1') {
    return Buffer.from(content).toString('latin1');
  }
  return refuse('encoding');
}

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  // A bare `&` is not XML.
  if (/&(?![^;\s&]{1,10};)/.test(raw)) refuse('entity');
  return raw.replace(/&([^;\s&]{1,10});/g, (_m, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) {
      const code = Number.parseInt(name.slice(2), 16);
      return Number.isFinite(code) && /^[0-9A-Fa-f]+$/.test(name.slice(2))
        ? charOf(code)
        : refuse('entity');
    }
    if (name.startsWith('#')) {
      return /^\d+$/.test(name.slice(1)) ? charOf(Number(name.slice(1))) : refuse('entity');
    }
    return PREDEFINED[name] ?? refuse('entity');
  });
}

function charOf(code: number): string {
  // Only characters XML allows: no NUL or other control characters through a reference.
  const allowed =
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff);
  return allowed ? String.fromCodePoint(code) : refuse('entity');
}

interface Open {
  readonly name: string;
  readonly ns: string;
  readonly local: string;
  readonly attributes: Record<string, string>;
  readonly scope: ReadonlyMap<string, string>;
  readonly children: XmlElement[];
  text: string;
}

/** Parses one XML document into its root element, or refuses it with `invalid_file`. */
export function parseXml(source: string): XmlElement {
  const xml = source.startsWith('\uFEFF') ? source.slice(1) : source;
  if (NOT_XML.test(xml)) refuse('control_character');
  const stack: Open[] = [];
  let root: XmlElement | undefined;
  let elements = 0;
  let i = 0;
  const text = (raw: string) => {
    const top = stack.at(-1);
    if (top === undefined) {
      if (raw.trim().length > 0) refuse('text_outside_root');
      return;
    }
    top.text += raw;
  };
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      text(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) text(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end < 0) refuse('unclosed');
      i = end + 2;
    } else if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end < 0) refuse('unclosed');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end < 0) refuse('unclosed');
      if (stack.length === 0) refuse('text_outside_root');
      text(xml.slice(lt + 9, end));
      i = end + 3;
    } else if (xml.startsWith('<!', lt)) {
      // A DOCTYPE, an ENTITY, or anything else declared: never read.
      return refuse('doctype');
    } else if (xml.startsWith('</', lt)) {
      const end = xml.indexOf('>', lt + 2);
      if (end < 0) refuse('unclosed');
      const name = xml.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (top === undefined || top.name !== name) refuse('mismatched_tag');
      const element: XmlElement = Object.freeze({
        ns: (top as Open).ns,
        local: (top as Open).local,
        attributes: Object.freeze((top as Open).attributes),
        children: Object.freeze((top as Open).children),
        text: (top as Open).text,
      });
      const parent = stack.at(-1);
      if (parent === undefined) root = element;
      else parent.children.push(element);
      i = end + 1;
    } else {
      if (root !== undefined) refuse('second_root');
      const { name, attributes, selfClosing, end } = readTag(xml, lt);
      elements += 1;
      if (elements > MAX_XML_ELEMENTS) refuse('too_many_elements');
      if (stack.length >= MAX_XML_DEPTH) refuse('too_deep');
      const parentScope = stack.at(-1)?.scope ?? new Map<string, string>([['xml', XML_NS]]);
      const scope = new Map(parentScope);
      for (const [key, value] of Object.entries(attributes)) {
        if (key === 'xmlns') scope.set('', value);
        else if (key.startsWith('xmlns:')) scope.set(key.slice(6), value);
      }
      const [prefix, local] = name.includes(':')
        ? (name.split(':') as [string, string])
        : (['', name] as [string, string]);
      const ns = scope.get(prefix);
      if (ns === undefined) {
        if (prefix !== '') refuse('unbound_prefix');
      }
      for (const key of Object.keys(attributes)) {
        const p = key.includes(':') ? (key.split(':')[0] as string) : '';
        if (p !== '' && p !== 'xmlns' && !scope.has(p)) refuse('unbound_prefix');
      }
      const open: Open = {
        name,
        ns: ns ?? '',
        local,
        attributes,
        scope,
        children: [],
        text: '',
      };
      if (selfClosing) {
        const element: XmlElement = Object.freeze({
          ns: open.ns,
          local,
          attributes: Object.freeze(attributes),
          children: Object.freeze([]),
          text: '',
        });
        const parent = stack.at(-1);
        if (parent === undefined) root = element;
        else parent.children.push(element);
      } else {
        stack.push(open);
      }
      i = end;
    }
  }
  if (stack.length > 0) refuse('unclosed');
  return root ?? refuse('empty');
}

function readTag(
  xml: string,
  lt: number,
): {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly selfClosing: boolean;
  readonly end: number;
} {
  let i = lt + 1;
  const nameEnd = /[\s/>]/.exec(xml.slice(i, i + 200));
  if (nameEnd === null) refuse('tag');
  const name = xml.slice(i, i + (nameEnd as RegExpExecArray).index);
  if (!NAME.test(name)) refuse('tag');
  i += name.length;
  const attributes: Record<string, string> = Object.create(null) as Record<string, string>;
  for (;;) {
    while (i < xml.length && /\s/.test(xml[i] as string)) i += 1;
    if (i >= xml.length) refuse('unclosed');
    if (xml.startsWith('/>', i)) return { name, attributes, selfClosing: true, end: i + 2 };
    if (xml[i] === '>') return { name, attributes, selfClosing: false, end: i + 1 };
    const eq = xml.indexOf('=', i);
    if (eq < 0) refuse('attribute');
    const key = xml.slice(i, eq).trim();
    if (!NAME.test(key) || Object.hasOwn(attributes, key)) refuse('attribute');
    i = eq + 1;
    while (i < xml.length && /\s/.test(xml[i] as string)) i += 1;
    const quote = xml[i];
    if (quote !== '"' && quote !== "'") refuse('attribute');
    const close = xml.indexOf(quote as string, i + 1);
    if (close < 0) refuse('unclosed');
    const raw = xml.slice(i + 1, close);
    if (raw.includes('<')) refuse('attribute');
    attributes[key] = decodeEntities(raw);
    i = close + 1;
    if (i < xml.length && !/[\s/>]/.test(xml[i] as string)) refuse('attribute');
  }
}

/** The first child in a namespace with a local name. */
export const childOf = (element: XmlElement | undefined, ns: string, local: string) =>
  element?.children.find((c) => c.ns === ns && c.local === local);

/** Every child in a namespace with a local name. */
export const childrenOf = (element: XmlElement | undefined, ns: string, local: string) =>
  element?.children.filter((c) => c.ns === ns && c.local === local) ?? [];

/** Follows a path of `[ns, local]` steps, first match each. */
export function pathOf(
  element: XmlElement | undefined,
  ...steps: readonly (readonly [string, string])[]
): XmlElement | undefined {
  let current = element;
  for (const [ns, local] of steps) current = childOf(current, ns, local);
  return current;
}
