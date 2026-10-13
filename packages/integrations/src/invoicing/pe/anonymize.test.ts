import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isIntegrationError } from '../../errors.js';
import { decodeXml } from '../xml.js';
import { createUblAnonymizer } from './anonymize.js';
import { isValidRuc } from './sunat.js';
import { readPeUbl } from './ubl.js';

/**
 * The local anonymization of exported UBL files (ADR-0193, `fixtures/ANONYMIZE.md`), run on the
 * synthetic fixtures as if they were originals: nothing identifying is left, and the adapter reads
 * the same document.
 */

const OURS = '20999999019';
const DIR = new URL('./fixtures/', import.meta.url);
const FILES = readdirSync(DIR).filter((name) => name.endsWith('.xml'));
const bytesOf = (name: string) => new Uint8Array(readFileSync(new URL(name, DIR)));

describe('anonymizing exported UBL files', () => {
  it('replaces every identifying value and keeps what the adapter reads', () => {
    const anonymizer = createUblAnonymizer();
    const testRuc = anonymizer.rucFor(OURS);
    expect(isValidRuc(testRuc)).toBe(true);
    expect(testRuc).not.toBe(OURS);
    for (const name of FILES) {
      const original = decodeXml(bytesOf(name));
      const result = anonymizer.anonymize(bytesOf(name), { taxId: OURS });
      const output = decodeXml(result.content);
      // None of the invented originals is left, the organization's RUC included.
      for (const value of [
        OURS,
        '20999999027',
        '20999999035',
        '10999999048',
        'EMPRESA SINTETICA EMISORA',
        'CLIENTE SINTETICO',
        'SYNTHETIC BUYER',
        'U0lOVEVUSUNPLU5PLUZJUk1BRE8=',
        'Servicio de consultoria',
        'SRV-001',
        '00-000-000000',
        'PÉREZ',
      ]) {
        expect([name, output.includes(value)]).toEqual([name, false]);
      }
      const before = readPeUbl(original, { taxId: OURS });
      const after = readPeUbl(output, { taxId: testRuc });
      expect(after).toMatchObject({
        direction: before.direction,
        series: before.series,
        number: before.number,
        issueDate: before.issueDate,
        total: before.total,
        relations: before.relations,
      });
      expect(after.lines.map((l) => [l.net, l.tax, l.taxCategory])).toEqual(
        before.lines.map((l) => [l.net, l.tax, l.taxCategory]),
      );
      expect(result.replaced.identifier).toBeGreaterThan(0);
    }
  });

  it('maps the same original to the same value across files, so notes keep their invoice', () => {
    const anonymizer = createUblAnonymizer();
    const invoice = anonymizer.anonymize(bytesOf('factura-estructura-2018.xml'), { taxId: OURS });
    const note = anonymizer.anonymize(bytesOf('nota-credito-varias-facturas.xml'), {
      taxId: OURS,
    });
    const account = { taxId: anonymizer.rucFor(OURS) };
    const a = readPeUbl(decodeXml(invoice.content), account);
    const n = readPeUbl(decodeXml(note.content), account);
    expect(n.issuer.taxId).toEqual(a.issuer.taxId);
    expect(n.counterparty?.taxId).toEqual(a.counterparty?.taxId);
    // ISO-8859-1 stays ISO-8859-1.
    const latin = anonymizer.anonymize(bytesOf('boleta-dni-iso-8859-1.xml'), { taxId: OURS });
    expect(Buffer.from(latin.content).toString('latin1')).toContain('encoding="ISO-8859-1"');
  });

  it('refuses a file it cannot clean, and a file of another company', () => {
    const anonymizer = createUblAnonymizer();
    const code = (run: () => unknown) => {
      try {
        run();
        return 'accepted';
      } catch (error) {
        return isIntegrationError(error) ? error.detail : String(error);
      }
    };
    // The customer's RUC also written in an attribute, where text replacement does not reach.
    const xml = decodeXml(bytesOf('factura-estructura-2018.xml')).replace(
      '<cbc:LineCountNumeric>',
      '<cbc:LineCountNumeric note="20999999027">',
    );
    expect(code(() => anonymizer.anonymize(new TextEncoder().encode(xml), { taxId: OURS }))).toBe(
      'anonymize.leftover',
    );
    expect(
      code(() => anonymizer.anonymize(bytesOf('compra-recibida.xml'), { taxId: '20999999027' })),
    ).toBe('not_this_account');
    expect(code(() => anonymizer.rucFor('20999999018'))).toBe('anonymize.account');
  });
});
