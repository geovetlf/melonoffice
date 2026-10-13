import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isIntegrationError } from '../errors.js';
import { MAX_LINES, MAX_ORIGINAL_BYTES } from './model.js';
import { createPeUblAdapter } from './pe/ubl.js';
import { childOf, decodeXml, MAX_XML_DEPTH, MAX_XML_ELEMENTS, parseXml } from './xml.js';

/**
 * The strict XML reader the invoicing adapters share (ADR-0193): namespaces, optional parts,
 * special characters, malformed input, declared entities and size limits. What it refuses, it
 * refuses with a stable `invalid_file` detail.
 */

const refusal = (run: () => unknown) => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return isIntegrationError(error) ? `${error.code}:${error.detail ?? ''}` : String(error);
  }
};
const enc = (s: string) => new TextEncoder().encode(s);

describe('the invoicing XML reader', () => {
  it('resolves namespaces by URI, whatever the prefix', () => {
    const root = parseXml(
      `<r:Root xmlns:r="urn:root" xmlns="urn:default"><child/><r:a xmlns:r="urn:other"><b xmlns="">x</b></r:a></r:Root>`,
    );
    expect([root.ns, root.local]).toEqual(['urn:root', 'Root']);
    expect(root.children.map((c) => [c.ns, c.local])).toEqual([
      ['urn:default', 'child'],
      ['urn:other', 'a'],
    ]);
    // A prefix declared again inside applies only there; `xmlns=""` clears the default.
    expect(childOf(root.children[1], '', 'b')?.text).toBe('x');
    expect(refusal(() => parseXml('<a:b/>'))).toBe('invalid_file:unbound_prefix');
    expect(refusal(() => parseXml('<a z:k="1"/>'))).toBe('invalid_file:unbound_prefix');
    // The `xml` prefix is always bound.
    expect(parseXml('<a xml:lang="es"/>').attributes['xml:lang']).toBe('es');
  });

  it('reads special characters exactly, in text, CDATA and attributes', () => {
    const root = parseXml(
      `<a k="&quot;x&quot; &amp; &apos;y&apos;" t="&#x9;tab">Ñandú &lt;€&gt; &#128512; &#xD;<![CDATA[<b>&amp; ]] ]]></a>`,
    );
    expect(root.attributes).toEqual({ k: `"x" & 'y'`, t: '\ttab' });
    expect(root.text).toBe('Ñandú <€> 😀 \r<b>&amp; ]] ');
    // Comments and processing instructions are skipped, never read as text.
    expect(parseXml('<?xml version="1.0"?><!-- c --><a><?pi x?>v<!-- <b> --></a>').text).toBe('v');
  });

  it('refuses malformed documents with a stable code', () => {
    const cases: [string, string][] = [
      ['', 'empty'],
      ['   ', 'empty'],
      ['<?xml version="1.0"?>', 'empty'],
      ['plain text', 'text_outside_root'],
      ['<a/>after', 'text_outside_root'],
      ['<![CDATA[x]]>', 'text_outside_root'],
      ['<a>', 'unclosed'],
      ['<a><![CDATA[x</a>', 'unclosed'],
      ['<a><!-- x</a>', 'unclosed'],
      ['<a><?pi x</a>', 'unclosed'],
      ['<a k="1></a>', 'unclosed'],
      ['</a>', 'mismatched_tag'],
      ['<a><b></a></b>', 'mismatched_tag'],
      ['<a/><b/>', 'second_root'],
      ['<1a/>', 'tag'],
      [`<${'a'.repeat(300)}/>`, 'tag'],
      ['<a k=1/>', 'attribute'],
      ['<a k="1" k="2"/>', 'attribute'],
      ['<a k="<"/>', 'attribute'],
      ['<a k="1"j="2"/>', 'attribute'],
      ['<a>AT&T</a>', 'entity'],
      ['<a>&#xZZ;</a>', 'entity'],
      ['<a>&#x1;</a>', 'entity'],
      ['<a>&#xFFFE;</a>', 'entity'],
      ['<a>\u0001</a>', 'control_character'],
      ['<a k="\u001F"/>', 'control_character'],
      ['<a>￿</a>', 'control_character'],
    ];
    for (const [xml, code] of cases) {
      expect([xml, refusal(() => parseXml(xml))]).toEqual([xml, `invalid_file:${code}`]);
    }
  });

  it('never declares, expands or fetches an entity', () => {
    const attempts = [
      '<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>',
      '<!DOCTYPE a [<!ENTITY x SYSTEM "http://169.254.169.254/latest/meta-data/">]><a>&x;</a>',
      '<!DOCTYPE a PUBLIC "-//X//EN" "http://example.invalid/a.dtd"><a/>',
      '<!DOCTYPE a [<!ENTITY % p SYSTEM "http://example.invalid/p.dtd"> %p;]><a/>',
      '<?xml version="1.0"?><!-- before --><!doctype a><a/>',
      '<a><!ENTITY x "y"></a>',
      '<a><!ELEMENT a ANY></a>',
    ];
    for (const xml of attempts) {
      expect(refusal(() => parseXml(xml))).toBe('invalid_file:doctype');
    }
    // An entity nobody declared is refused, not left as text.
    expect(refusal(() => parseXml('<a>&x;</a>'))).toBe('invalid_file:entity');
    // XInclude and schema locations are plain elements and attributes: never followed.
    const included = parseXml(
      '<a xmlns:xi="http://www.w3.org/2001/XInclude" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:x http://example.invalid/x.xsd"><xi:include href="file:///etc/passwd" parse="text"/></a>',
    );
    expect(included.children[0]).toMatchObject({ local: 'include', text: '', children: [] });
    // The reader does no input or output of its own: it imports nothing but its error type.
    const source = readFileSync(new URL('./xml.ts', import.meta.url), 'utf8');
    expect(source.match(/^import .*$/gm)).toEqual([
      "import { IntegrationError } from '../errors.js';",
    ]);
  });

  it('bounds depth, element count, file size and lines', () => {
    const nested = (depth: number) => `${'<a>'.repeat(depth)}${'</a>'.repeat(depth)}`;
    expect(refusal(() => parseXml(nested(MAX_XML_DEPTH)))).toBe('accepted');
    expect(refusal(() => parseXml(nested(MAX_XML_DEPTH + 1)))).toBe('invalid_file:too_deep');
    const wide = (count: number) => `<r>${'<a/>'.repeat(count - 1)}</r>`;
    expect(refusal(() => parseXml(wide(MAX_XML_ELEMENTS)))).toBe('accepted');
    expect(refusal(() => parseXml(wide(MAX_XML_ELEMENTS + 1)))).toBe(
      'invalid_file:too_many_elements',
    );
    const adapter = createPeUblAdapter();
    const account = { taxId: '20999999019' };
    const big = new Uint8Array(MAX_ORIGINAL_BYTES + 1).fill(0x20);
    expect(refusal(() => adapter.readFile?.('ubl_xml', big, account))).toBe(
      'invalid_file:too_large',
    );
    // A fixture with more lines than the model keeps is refused, never cut.
    const fixture = readFileSync(
      new URL('./pe/fixtures/factura-estructura-2018.xml', import.meta.url),
      'utf8',
    );
    const start = fixture.indexOf('<cac:InvoiceLine>');
    const end = fixture.indexOf('</cac:InvoiceLine>') + '</cac:InvoiceLine>'.length;
    const many = `${fixture.slice(0, start)}${fixture.slice(start, end).repeat(MAX_LINES + 1)}${fixture.slice(end)}`;
    expect(refusal(() => adapter.readFile?.('ubl_xml', enc(many), account))).toBe(
      'invalid_file:lines.too_many',
    );
    // A description longer than the model keeps is cut, and says so.
    const long = fixture.replace('Servicio de consultoria', 'x'.repeat(600));
    const [doc] = (adapter.readFile?.('ubl_xml', enc(long), account).records ?? []) as unknown as {
      lines: { description: string }[];
    }[];
    expect(doc?.lines[0]?.description).toHaveLength(500);
    expect(doc?.lines[0]?.description.endsWith('…')).toBe(true);
  });

  it('decodes only UTF-8 and ISO-8859-1', () => {
    expect(parseXml(decodeXml(enc('﻿<a>ñ</a>'))).text).toBe('ñ');
    expect(
      parseXml(
        decodeXml(
          Uint8Array.from(Buffer.from('<?xml version="1.0" encoding="latin1"?><a>ñ</a>', 'latin1')),
        ),
      ).text,
    ).toBe('ñ');
    for (const encoding of ['UTF-16', 'windows-1252', 'EBCDIC']) {
      expect(
        refusal(() => decodeXml(enc(`<?xml version="1.0" encoding="${encoding}"?><a/>`))),
      ).toBe('invalid_file:encoding');
    }
    // Bytes that are not UTF-8 in a file that says UTF-8.
    expect(refusal(() => decodeXml(Uint8Array.from([0x3c, 0x61, 0x3e, 0xc3, 0x28])))).toBe(
      'invalid_file:encoding',
    );
  });
});
