import { readdirSync, readFileSync } from 'node:fs';
import type { InvoicingConnection } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { isIntegrationError } from '../../errors.js';
import { checkInvoicingAdapterContract } from '../contract-suite.js';
import { createPeUblAdapter, readPeUbl } from './ubl.js';
import { isValidRuc } from './sunat.js';

/**
 * The adapter against the synthetic fixtures in `fixtures/` (ADR-0193), built to SUNAT's UBL 2.1
 * guides and listed in `fixtures/COVERAGE.md`. Every party, number and amount in them is invented:
 * they show what the reader does with each structure, not that real exported files read the same.
 * The adapter stays not operational until real files pass.
 */

const OURS = '20999999019';
const CLIENT = '20999999027';
const PERSON_RUC = '10999999048';
const SYNTHETIC_RUCS = new Set([OURS, CLIENT, '20999999035', PERSON_RUC]);
const ACCOUNT = { taxId: OURS };
const DIR = new URL('./fixtures/', import.meta.url);
const FILES = readdirSync(DIR)
  .filter((name) => name.endsWith('.xml'))
  .sort();

const bytesOf = (name: string) => new Uint8Array(readFileSync(new URL(name, DIR)));
const adapter = createPeUblAdapter();
const read = (name: string) => {
  const [record] = adapter.readFile?.('ubl_xml', bytesOf(name), ACCOUNT).records ?? [];
  return record as ReturnType<typeof readPeUbl>;
};
const pen = (value: string) => ({ value, currency: 'PEN' });
const refusal = (run: () => unknown) => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return isIntegrationError(error) ? `${error.code}:${error.detail ?? ''}` : String(error);
  }
};

describe('synthetic SUNAT UBL 2.1 fixtures', () => {
  it('has the fixtures COVERAGE.md lists, with only invented tax ids', () => {
    expect(FILES).toHaveLength(12);
    const coverage = readFileSync(new URL('COVERAGE.md', DIR), 'utf8');
    for (const name of FILES) {
      expect(coverage).toContain(name);
      // Any 11-digit number that is a valid RUC must be one of the invented ones.
      const text = Buffer.from(bytesOf(name)).toString('latin1');
      for (const candidate of text.match(/\b\d{11}\b/g) ?? []) {
        if (isValidRuc(candidate)) expect(SYNTHETIC_RUCS).toContain(candidate);
      }
      expect(text).toContain('Not a real fiscal document');
    }
  });

  it('reads the structure of SUNAT’s 2018 guide (PartyTaxScheme) and the current one alike', () => {
    const doc = read('factura-estructura-2018.xml');
    expect(doc).toMatchObject({
      externalId: `${OURS}-01-F001-101`,
      direction: 'issued',
      type: 'invoice',
      series: 'F001',
      number: '101',
      issueDate: '2026-09-15',
      dueDate: '2026-10-15',
      issuer: {
        taxId: { scheme: 'PE:RUC', value: OURS },
        legalName: 'EMPRESA SINTETICA EMISORA S.A.C.',
      },
      counterparty: {
        taxId: { scheme: 'PE:RUC', value: CLIENT },
        legalName: 'CLIENTE SINTETICO S.A.',
      },
      netTotal: pen('200.00'),
      taxTotal: pen('36.00'),
      total: pen('236.00'),
      authorityStatus: 'not_reported',
    });
    expect(doc.lines.map((l) => [l.description, l.unitPrice?.value, l.taxCategory])).toEqual([
      ['Servicio de consultoria & soporte (mensual)', '50.00', '10'],
      ['Licencia anual <basica> "estandar"', '100.00', '10'],
    ]);
    // Other prefixes, a prefixed root and a namespace declared inside read the same document.
    const prefixed = read('factura-prefijos-distintos.xml');
    const strip = ({ externalId, number, original, ...rest }: typeof doc) => {
      void externalId;
      void number;
      void original;
      return rest;
    };
    expect(prefixed.number).toBe('105');
    expect(strip(prefixed)).toEqual(strip(doc));
  });

  it('keeps each line’s affectation code, free lines and other taxes included', () => {
    const mixed = read('factura-afectaciones-y-gratuita.xml');
    expect(mixed.lines.map((l) => l.taxCategory)).toEqual(['10', '20', '30', '11']);
    // A free line (retiro, PriceTypeCode 02) keeps its referential value; the totals leave it out.
    expect(mixed.lines[3]).toMatchObject({
      unitPrice: pen('0.00'),
      net: pen('15.00'),
      tax: pen('2.70'),
    });
    expect(mixed).toMatchObject({ netTotal: pen('150.00'), total: pen('168.00') });
    const isc = read('factura-isc-icbper.xml');
    // ISC comes before IGV on the first line; the affectation code is still found.
    expect(isc.lines.map((l) => [l.taxCategory, l.tax?.value])).toEqual([
      ['10', '41.60'],
      ['10', '2.80'],
    ]);
    expect(isc.taxTotal).toEqual(pen('44.40'));
  });

  it('reads exports in dollars, advances, detracción and instalments without guessing', () => {
    const exported = read('factura-exportacion-usd.xml');
    expect(exported).toMatchObject({
      currency: 'USD',
      total: { value: '1500.00', currency: 'USD' },
      // A non-domiciled buyer (catálogo 06 code 0) is kept by name only.
      counterparty: { legalName: 'SYNTHETIC BUYER LLC' },
    });
    expect(exported.counterparty?.taxId).toBeUndefined();
    expect(exported.lines[0]?.taxCategory).toBe('40');
    const advance = read('factura-anticipo-detraccion-cuotas.xml');
    // The payable amount is what the file says after the advance; no due date is invented.
    expect(advance).toMatchObject({
      netTotal: pen('2000.00'),
      taxTotal: pen('360.00'),
      total: pen('1180.00'),
    });
    expect(advance.dueDate).toBeUndefined();
  });

  it('reads boletas, with or without an identified customer, in UTF-8 or ISO-8859-1', () => {
    const anonymous = read('boleta-cliente-sin-documento.xml');
    expect(anonymous).toMatchObject({ type: 'receipt', series: 'B001', number: '15' });
    expect(anonymous.counterparty).toBeUndefined();
    const latin = read('boleta-dni-iso-8859-1.xml');
    expect(latin).toMatchObject({
      issuer: { legalName: 'COMPAÑÍA SINTÉTICA ÑANDÚ S.A.C.' },
      counterparty: {
        taxId: { scheme: 'PE:DNI', value: '00000001' },
        legalName: 'PÉREZ ÑÚÑEZ, MARÍA JOSÉ',
      },
    });
    expect(latin.lines[0]?.description).toBe(
      'Café 250 g – tostado n.º 2 ½ (100% arábica) <oferta>',
    );
  });

  it('reads notes with every document they correct, and purchases', () => {
    expect(read('nota-credito-sobre-boleta.xml')).toMatchObject({
      type: 'credit_note',
      externalId: `${OURS}-07-BC01-2`,
      relations: [
        { type: 'credits', targetSeries: 'B001', targetNumber: '15', targetSourceType: '03' },
      ],
    });
    expect(read('nota-credito-varias-facturas.xml').relations).toEqual([
      { type: 'credits', targetSeries: 'F001', targetNumber: '101', targetSourceType: '01' },
      { type: 'credits', targetSeries: 'F001', targetNumber: '102', targetSourceType: '01' },
    ]);
    expect(read('nota-debito-intereses.xml')).toMatchObject({
      type: 'debit_note',
      total: pen('11.80'),
      relations: [{ type: 'debits', targetSeries: 'F001', targetNumber: '101' }],
    });
    const purchase = read('compra-recibida.xml');
    expect(purchase).toMatchObject({
      direction: 'received',
      externalId: `${PERSON_RUC}-01-E001-245`,
      counterparty: { taxId: { value: PERSON_RUC } },
    });
    expect(purchase.lines[0]?.productCode).toBeUndefined();
  });

  it('refuses a party whose two identifiers disagree', () => {
    const xml = Buffer.from(bytesOf('factura-estructura-2018.xml')).toString('utf8');
    const both = (id: string) =>
      xml.replace(
        '<cac:PartyTaxScheme>',
        `<cac:PartyIdentification><cbc:ID schemeID="6">${id}</cbc:ID></cac:PartyIdentification><cac:PartyTaxScheme>`,
      );
    expect(readPeUbl(both(OURS), ACCOUNT).issuer.taxId).toEqual({ scheme: 'PE:RUC', value: OURS });
    expect(refusal(() => readPeUbl(both(CLIENT), ACCOUNT))).toBe('invalid_file:supplier.conflict');
  });

  it.each(FILES)('%s passes the contract suite', async (name) => {
    const problems = await checkInvoicingAdapterContract(adapter, {
      connection: { account: ACCOUNT } as unknown as InvoicingConnection,
      credentials: { values: {} },
      refusedCredentials: { values: {} },
      account: ACCOUNT,
      file: {
        format: 'ubl_xml',
        recordType: 'document',
        content: bytesOf(name),
        refused: [new TextEncoder().encode('<!DOCTYPE a><a/>')],
      },
    });
    expect(problems).toEqual([]);
  });
});
