import type {
  FiscalAmount,
  FiscalDocumentLine,
  FiscalDocumentRelation,
  IntegrationProviderId,
  InvoicingAccount,
  InvoicingCapabilities,
  TaxIdentifier,
} from '@melonoffice/domain';
import { IntegrationError } from '../../errors.js';
import type { InvoicingAdapter, NormalizedDocument } from '../contract.js';
import {
  isCalendarDate,
  isDecimal,
  MAX_LINES,
  MAX_ORIGINAL_BYTES,
  MAX_RELATIONS,
} from '../model.js';
import { childOf, childrenOf, decodeXml, parseXml, pathOf, type XmlElement } from '../xml.js';
import { isValidRuc, PE_DNI_SCHEME, PE_RUC_SCHEME, peDocumentType } from './sunat.js';

/**
 * Peru's electronic invoices as UBL 2.1 XML files (ADR-0193, the first adapter Geovet chose on
 * 2026-10-13): a person exports the XML of a factura, boleta, nota de crédito or nota de débito
 * from their invoicing system (or receives it from a supplier) and imports it. No account, API or
 * credential is involved, and nothing is sent anywhere.
 *
 * What a file can and cannot say:
 * - It says what was issued, by whom, to whom, the amounts and the lines, exactly as signed.
 * - It does not say what SUNAT answered: that is the CDR (constancia de recepción), a separate
 *   file. Every document read here is `not_reported` for the authority and `none` for voiding.
 * - Its digital signature is not verified here (a residual risk in ADR-0193): the document is kept
 *   as a copy of what the file says, traced to it by its SHA-256.
 * - It says nothing about payment: no payments are read.
 *
 * UBL 2.1 as SUNAT specifies it for the SEE (Guía de elaboración de documentos XML, UBL 2.1). A
 * file whose structure differs is refused with a stable code; a field is never guessed. This
 * adapter has not been proven against real files yet: it stays not operational until files a
 * customer exports pass the contract suite.
 */

export const PE_UBL_PROVIDER = 'pe_ubl_files' as IntegrationProviderId;

const UBL = {
  invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  creditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  debitNote: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
  cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
} as const;

const CAPABILITIES: InvoicingCapabilities = Object.freeze({
  records: Object.freeze(['document' as const]),
  listing: false,
  incrementalSync: false,
  webhooks: false,
  fileImport: Object.freeze(['ubl_xml' as const]),
  authorityStatus: false,
  paymentConfirmation: false,
  revokeOnDisconnect: false,
  maxPageSize: 1,
  write: [] as [],
});

/** SUNAT catálogo 06: identity document types, as tax identifier schemes. */
const IDENTITY_SCHEMES: Readonly<Record<string, string>> = Object.freeze({
  '6': PE_RUC_SCHEME,
  '1': PE_DNI_SCHEME,
  '4': 'PE:CE',
  '7': 'PE:PASSPORT',
});

const MAX_DESCRIPTION = 500;
const SERIES_NUMBER = /^([A-Z0-9]{4})-(\d{1,8})$/;
const TYPE_CODE = /^\d{2}$/;
const CURRENCY = /^[A-Z]{3}$/;

const refuse = (detail: string): never => {
  throw new IntegrationError('invalid_file', detail);
};

const cbc = (element: XmlElement | undefined, local: string) => childOf(element, UBL.cbc, local);
const cac = (element: XmlElement | undefined, local: string) => childOf(element, UBL.cac, local);
const textOf = (element: XmlElement | undefined) => element?.text.trim();

/** One amount with its `currencyID`, which must be the document's currency. */
function amountOf(element: XmlElement | undefined, currency: string, field: string): FiscalAmount {
  const value = textOf(element);
  if (value === undefined || !isDecimal(value)) return refuse(field);
  if (element?.attributes.currencyID !== currency) return refuse(`${field}.currency`);
  return { value, currency };
}

/** A party's tax identifier, with the scheme SUNAT's catálogo 06 names. */
function taxIdOf(party: XmlElement | undefined, field: string): TaxIdentifier | undefined {
  const id = pathOf(party, [UBL.cac, 'PartyIdentification'], [UBL.cbc, 'ID']);
  const value = textOf(id);
  if (value === undefined || value === '' || value === '-') return undefined;
  const scheme = IDENTITY_SCHEMES[id?.attributes.schemeID ?? ''];
  if (scheme === undefined) return undefined;
  if (scheme === PE_RUC_SCHEME && !isValidRuc(value)) return refuse(`${field}.ruc`);
  if (!/^[A-Za-z0-9-]{1,32}$/.test(value)) return refuse(`${field}.id`);
  return { scheme, value };
}

function legalNameOf(party: XmlElement | undefined, field: string): string {
  const name =
    textOf(pathOf(party, [UBL.cac, 'PartyLegalEntity'], [UBL.cbc, 'RegistrationName'])) ??
    textOf(pathOf(party, [UBL.cac, 'PartyName'], [UBL.cbc, 'Name']));
  if (name === undefined || name === '') return refuse(`${field}.name`);
  return clean(name);
}

/** Spaces collapsed; a description longer than the model keeps is cut, never rewritten. */
function clean(value: string): string {
  const s = value.replace(/\s+/g, ' ').trim();
  return s.length > MAX_DESCRIPTION ? `${s.slice(0, MAX_DESCRIPTION - 1)}…` : s;
}

function linesOf(root: XmlElement, kind: 'Invoice' | 'CreditNote' | 'DebitNote', currency: string) {
  const quantityName = {
    Invoice: 'InvoicedQuantity',
    CreditNote: 'CreditedQuantity',
    DebitNote: 'DebitedQuantity',
  }[kind];
  const elements = childrenOf(root, UBL.cac, `${kind}Line`);
  if (elements.length === 0) refuse('lines');
  if (elements.length > MAX_LINES) refuse('lines.too_many');
  return elements.map((line, i): FiscalDocumentLine => {
    const quantity = cbc(line, quantityName);
    const q = textOf(quantity);
    if (q === undefined || !isDecimal(q)) refuse('lines.quantity');
    const description = textOf(cbc(cac(line, 'Item'), 'Description'));
    const unitCode = quantity?.attributes.unitCode;
    const price = cbc(cac(line, 'Price'), 'PriceAmount');
    const tax = cbc(cac(line, 'TaxTotal'), 'TaxAmount');
    const category = textOf(
      pathOf(
        line,
        [UBL.cac, 'TaxTotal'],
        [UBL.cac, 'TaxSubtotal'],
        [UBL.cac, 'TaxCategory'],
        [UBL.cbc, 'TaxExemptionReasonCode'],
      ),
    );
    const product = textOf(cbc(cac(cac(line, 'Item'), 'SellersItemIdentification'), 'ID'));
    return {
      position: i + 1,
      description:
        description === undefined || description === ''
          ? refuse('lines.description')
          : clean(description),
      quantity: q as string,
      ...(unitCode !== undefined && /^[A-Za-z0-9]{1,8}$/.test(unitCode) ? { unitCode } : {}),
      ...(price === undefined ? {} : { unitPrice: amountOf(price, currency, 'lines.unitPrice') }),
      net: amountOf(cbc(line, 'LineExtensionAmount'), currency, 'lines.net'),
      ...(tax === undefined ? {} : { tax: amountOf(tax, currency, 'lines.tax') }),
      ...(category !== undefined && /^[A-Za-z0-9]{1,8}$/.test(category)
        ? { taxCategory: category }
        : {}),
      ...(product !== undefined && product !== '' && product.length <= 64
        ? { productCode: clean(product) }
        : {}),
    };
  });
}

/** The documents a note corrects: its `BillingReference`s. */
function relationsOf(
  root: XmlElement,
  type: 'credits' | 'debits' | undefined,
): FiscalDocumentRelation[] {
  const references = childrenOf(root, UBL.cac, 'BillingReference');
  if (type === undefined) return [];
  if (references.length === 0) refuse('relations');
  if (references.length > MAX_RELATIONS) refuse('relations.too_many');
  return references.map((reference) => {
    const target = cac(reference, 'InvoiceDocumentReference');
    const id = textOf(cbc(target, 'ID'));
    const match = id === undefined ? null : SERIES_NUMBER.exec(id);
    if (match === null) return refuse('relations.target');
    const code = textOf(cbc(target, 'DocumentTypeCode'));
    return {
      type,
      targetSeries: match[1] as string,
      targetNumber: String(Number(match[2])),
      ...(code !== undefined && TYPE_CODE.test(code) ? { targetSourceType: code } : {}),
    };
  });
}

/**
 * Reads one UBL 2.1 document as SUNAT specifies it. The organization's RUC decides whether it was
 * issued (a sale) or received (a purchase); a document of neither is refused.
 */
export function readPeUbl(xmlText: string, account: InvoicingAccount): NormalizedDocument {
  const root = parseXml(xmlText);
  const kind =
    root.ns === UBL.invoice && root.local === 'Invoice'
      ? 'Invoice'
      : root.ns === UBL.creditNote && root.local === 'CreditNote'
        ? 'CreditNote'
        : root.ns === UBL.debitNote && root.local === 'DebitNote'
          ? 'DebitNote'
          : refuse('not_ubl');
  if (textOf(cbc(root, 'UBLVersionID')) !== '2.1') refuse('ubl_version');
  const sourceType =
    kind === 'Invoice' ? textOf(cbc(root, 'InvoiceTypeCode')) : kind === 'CreditNote' ? '07' : '08';
  if (sourceType === undefined || !TYPE_CODE.test(sourceType)) return refuse('type');
  const id = SERIES_NUMBER.exec(textOf(cbc(root, 'ID')) ?? '');
  if (id === null) return refuse('id');
  const series = id[1] as string;
  const number = String(Number(id[2]));
  const issueDate = textOf(cbc(root, 'IssueDate'));
  if (issueDate === undefined || !isCalendarDate(issueDate)) return refuse('issueDate');
  const dueDate = textOf(cbc(root, 'DueDate'));
  if (dueDate !== undefined && !isCalendarDate(dueDate)) refuse('dueDate');
  const currency = textOf(cbc(root, 'DocumentCurrencyCode'));
  if (currency === undefined || !CURRENCY.test(currency)) return refuse('currency');

  const supplier = cac(cac(root, 'AccountingSupplierParty'), 'Party');
  const customer = cac(cac(root, 'AccountingCustomerParty'), 'Party');
  const issuerTaxId = taxIdOf(supplier, 'supplier');
  if (issuerTaxId?.scheme !== PE_RUC_SCHEME) return refuse('supplier.ruc');
  const issuer = { taxId: issuerTaxId, legalName: legalNameOf(supplier, 'supplier') };
  const customerTaxId = taxIdOf(customer, 'customer');
  const counterpartyOfIssuer =
    customer === undefined
      ? undefined
      : {
          ...(customerTaxId === undefined ? {} : { taxId: customerTaxId }),
          legalName: legalNameOf(customer, 'customer'),
        };
  const ruc = account.taxId;
  const direction =
    issuerTaxId.value === ruc
      ? ('issued' as const)
      : customerTaxId?.scheme === PE_RUC_SCHEME && customerTaxId.value === ruc
        ? ('received' as const)
        : refuse('not_this_account');

  const totals = cac(root, kind === 'DebitNote' ? 'RequestedMonetaryTotal' : 'LegalMonetaryTotal');
  if (totals === undefined) return refuse('totals');
  const taxTotals = childrenOf(root, UBL.cac, 'TaxTotal');
  if (taxTotals.length !== 1) return refuse('taxTotal');

  const relationType =
    kind === 'CreditNote' ? 'credits' : kind === 'DebitNote' ? 'debits' : undefined;
  return {
    recordType: 'document',
    // SUNAT identifies a document by its issuer's RUC, type, series and number.
    externalId: `${issuerTaxId.value}-${sourceType}-${series}-${number}`,
    original: { format: 'ubl_2_1_xml', content: xmlText },
    direction,
    type: peDocumentType(sourceType),
    sourceType,
    series,
    number,
    issueDate,
    ...(dueDate === undefined ? {} : { dueDate }),
    // The organization's side and the other: for a purchase, the supplier is the counterparty.
    issuer,
    ...(direction === 'issued'
      ? counterpartyOfIssuer === undefined
        ? {}
        : { counterparty: counterpartyOfIssuer }
      : { counterparty: issuer }),
    currency,
    netTotal: amountOf(cbc(totals, 'LineExtensionAmount'), currency, 'netTotal'),
    taxTotal: amountOf(cbc(taxTotals[0], 'TaxAmount'), currency, 'taxTotal'),
    total: amountOf(cbc(totals, 'PayableAmount'), currency, 'total'),
    lines: linesOf(root, kind, currency),
    relations: relationsOf(root, relationType),
    // A file does not carry SUNAT's answer (the CDR does): never assumed.
    authorityStatus: 'not_reported',
    voidStatus: 'none',
  };
}

const ACCOUNT_FIELDS = new Set(['taxId']);

export function createPeUblAdapter(): InvoicingAdapter {
  return {
    provider: PE_UBL_PROVIDER,
    category: 'invoicing',
    jurisdictions: ['PE'],
    capabilities: CAPABILITIES,
    credentialKinds: [],
    checkAccount(value: unknown): InvoicingAccount {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new IntegrationError('invalid_connection', 'account');
      }
      for (const key of Object.keys(value)) {
        if (!ACCOUNT_FIELDS.has(key))
          throw new IntegrationError('invalid_connection', `account.${key}`);
      }
      const taxId = (value as { taxId?: unknown }).taxId;
      if (typeof taxId !== 'string' || !isValidRuc(taxId)) {
        throw new IntegrationError('invalid_connection', 'account.taxId');
      }
      return Object.freeze({ taxId });
    },
    accountIdOf: (account) => account.taxId as string,
    // Nothing to check with anyone: no credentials, no provider.
    validateConnection: async () => ({ status: 'valid' }),
    readFile(format, content, account) {
      if (format !== 'ubl_xml') throw new IntegrationError('invalid_file', 'format');
      if (content.byteLength > MAX_ORIGINAL_BYTES)
        throw new IntegrationError('invalid_file', 'too_large');
      const document = readPeUbl(decodeXml(content), account);
      return { records: [document], bytes: content.byteLength };
    },
  };
}
