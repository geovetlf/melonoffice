import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import type {
  InitialBilling,
  InvoicingConnection,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { defaultValues, type EntitlementService } from '@melonoffice/entitlements';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { isIntegrationError } from '../../errors.js';
import { createIntegrationRegistry } from '../../registry.js';
import { InMemorySecretStore, isInvoicingSecretRef } from '../../secrets.js';
import type { NormalizedDocument } from '../contract.js';
import { checkInvoicingAdapterContract } from '../contract-suite.js';
import { createInvoicingGateway } from '../gateway.js';
import { InMemoryInvoicingRepository } from '../store.js';
import { decodeXml, parseXml } from '../xml.js';
import { createPeUblAdapter, PE_UBL_PROVIDER, readPeUbl } from './ubl.js';

/**
 * The UBL 2.1 XML adapter (ADR-0193) against synthetic files built to SUNAT's structure. They are
 * not real documents: the adapter stays not operational until files a customer exports pass the
 * same checks.
 */

const OURS = '20131312955';
const CUSTOMER = '20100176450';
const SUPPLIER = '20100047218';
const enc = (s: string) => new TextEncoder().encode(s);

const NS = `xmlns="urn:oasis:names:specification:ubl:schema:xsd:ROOT-2"
  xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
  xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
  xmlns:ds="http://www.w3.org/2000/09/xmldsig#"
  xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"`;

const party = (scheme: string, id: string, name: string) => `
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="${scheme}">${id}</cbc:ID></cac:PartyIdentification>
      <cac:PartyLegalEntity><cbc:RegistrationName><![CDATA[${name}]]></cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>`;

const line = (kind: string, quantity: string, n: number) => `
  <cac:${kind}Line>
    <cbc:ID>${n}</cbc:ID>
    <cbc:${quantity} unitCode="NIU">2</cbc:${quantity}>
    <cbc:LineExtensionAmount currencyID="PEN">100.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="PEN">18.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="PEN">100.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="PEN">18.00</cbc:TaxAmount>
        <cac:TaxCategory>
          <cbc:Percent>18</cbc:Percent>
          <cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>
          <cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Description>Servicio de consultoría &amp; soporte ${n}</cbc:Description>
      <cac:SellersItemIdentification><cbc:ID>SRV-${n}</cbc:ID></cac:SellersItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="PEN">50.0000000001</cbc:PriceAmount></cac:Price>
  </cac:${kind}Line>`;

interface Options {
  readonly root?: 'Invoice' | 'CreditNote' | 'DebitNote';
  readonly id?: string;
  readonly typeCode?: string;
  readonly supplier?: string;
  readonly customer?: string;
  readonly customerScheme?: string;
  readonly currency?: string;
  readonly totalCurrency?: string;
  readonly declaration?: string;
  readonly prolog?: string;
  readonly reference?: string;
  readonly lines?: number;
}

function ubl(o: Options = {}): string {
  const root = o.root ?? 'Invoice';
  const quantity = {
    Invoice: 'InvoicedQuantity',
    CreditNote: 'CreditedQuantity',
    DebitNote: 'DebitedQuantity',
  }[root];
  const totals = root === 'DebitNote' ? 'RequestedMonetaryTotal' : 'LegalMonetaryTotal';
  const lines = Array.from({ length: o.lines ?? 2 }, (_, i) => line(root, quantity, i + 1)).join(
    '',
  );
  return `${o.declaration ?? '<?xml version="1.0" encoding="UTF-8"?>'}${o.prolog ?? ''}
<${root} ${NS.replace('ROOT', root)}>
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>
    <ds:Signature Id="SignatureSP"><ds:SignedInfo/><ds:SignatureValue>c2lnbmF0dXJl</ds:SignatureValue></ds:Signature>
  </ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>2.0</cbc:CustomizationID>
  <cbc:ID>${o.id ?? 'F001-00000123'}</cbc:ID>
  <cbc:IssueDate>2026-10-01</cbc:IssueDate>
  ${root === 'Invoice' ? '<cbc:DueDate>2026-10-31</cbc:DueDate>' : ''}
  ${root === 'Invoice' ? `<cbc:InvoiceTypeCode listID="0101">${o.typeCode ?? '01'}</cbc:InvoiceTypeCode>` : ''}
  <cbc:DocumentCurrencyCode>${o.currency ?? 'PEN'}</cbc:DocumentCurrencyCode>
  ${
    o.reference === undefined
      ? ''
      : `<cac:DiscrepancyResponse><cbc:ReferenceID>${o.reference}</cbc:ReferenceID><cbc:ResponseCode>01</cbc:ResponseCode></cac:DiscrepancyResponse>
  <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${o.reference}</cbc:ID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>`
  }
  <cac:AccountingSupplierParty>${party('6', o.supplier ?? OURS, 'Emisor S.A.C.')}</cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>${party(o.customerScheme ?? '6', o.customer ?? CUSTOMER, 'Cliente S.A.')}</cac:AccountingCustomerParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="PEN">36.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:${totals}>
    <cbc:LineExtensionAmount currencyID="PEN">200.00</cbc:LineExtensionAmount>
    <cbc:TaxInclusiveAmount currencyID="PEN">236.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${o.totalCurrency ?? 'PEN'}">236.00</cbc:PayableAmount>
  </cac:${totals}>${lines}
</${root}>`;
}

const ACCOUNT = { taxId: OURS };
const read = (xml: string) => readPeUbl(xml, ACCOUNT);
const refusal = (run: () => unknown) => {
  try {
    run();
    return 'accepted';
  } catch (error) {
    return isIntegrationError(error) ? `${error.code}:${error.detail ?? ''}` : String(error);
  }
};

describe('UBL 2.1 XML (Peru)', () => {
  it('reads an invoice the organization issued, exactly as the file says', () => {
    const doc = read(ubl());
    expect(doc).toMatchObject({
      recordType: 'document',
      externalId: `${OURS}-01-F001-123`,
      direction: 'issued',
      type: 'invoice',
      sourceType: '01',
      series: 'F001',
      number: '123',
      issueDate: '2026-10-01',
      dueDate: '2026-10-31',
      issuer: { taxId: { scheme: 'PE:RUC', value: OURS }, legalName: 'Emisor S.A.C.' },
      counterparty: { taxId: { scheme: 'PE:RUC', value: CUSTOMER }, legalName: 'Cliente S.A.' },
      currency: 'PEN',
      netTotal: { value: '200.00', currency: 'PEN' },
      taxTotal: { value: '36.00', currency: 'PEN' },
      total: { value: '236.00', currency: 'PEN' },
      relations: [],
      // The file does not carry SUNAT's answer: never assumed.
      authorityStatus: 'not_reported',
      voidStatus: 'none',
    });
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0]).toEqual({
      position: 1,
      description: 'Servicio de consultoría & soporte 1',
      quantity: '2',
      unitCode: 'NIU',
      unitPrice: { value: '50.0000000001', currency: 'PEN' },
      net: { value: '100.00', currency: 'PEN' },
      tax: { value: '18.00', currency: 'PEN' },
      taxCategory: '10',
      productCode: 'SRV-1',
    });
    expect(doc.original).toEqual({ format: 'ubl_2_1_xml', content: ubl() });
  });

  it('reads a purchase: the supplier is the counterparty', () => {
    const doc = read(ubl({ supplier: SUPPLIER, customer: OURS }));
    expect(doc).toMatchObject({
      direction: 'received',
      externalId: `${SUPPLIER}-01-F001-123`,
      issuer: { taxId: { value: SUPPLIER } },
      counterparty: { taxId: { value: SUPPLIER } },
    });
  });

  it('reads a boleta to a person, and notes with the document they correct', () => {
    const boleta = read(
      ubl({ id: 'B001-7', typeCode: '03', customerScheme: '1', customer: '45678912' }),
    );
    expect(boleta).toMatchObject({
      type: 'receipt',
      counterparty: { taxId: { scheme: 'PE:DNI', value: '45678912' } },
    });
    const credit = read(ubl({ root: 'CreditNote', id: 'FC01-9', reference: 'F001-00000123' }));
    expect(credit).toMatchObject({
      type: 'credit_note',
      sourceType: '07',
      externalId: `${OURS}-07-FC01-9`,
      relations: [
        { type: 'credits', targetSeries: 'F001', targetNumber: '123', targetSourceType: '01' },
      ],
    });
    const debit = read(ubl({ root: 'DebitNote', id: 'FD01-2', reference: 'F001-123' }));
    expect(debit).toMatchObject({
      type: 'debit_note',
      sourceType: '08',
      total: { value: '236.00' },
      relations: [{ type: 'debits', targetNumber: '123' }],
    });
    // A note that names no document is refused, never left unrelated.
    expect(refusal(() => read(ubl({ root: 'CreditNote', id: 'FC01-9' })))).toBe(
      'invalid_file:relations',
    );
  });

  it('refuses what it cannot read for sure, with a stable code', () => {
    expect(refusal(() => read(ubl({ supplier: SUPPLIER })))).toBe('invalid_file:not_this_account');
    expect(refusal(() => read(ubl({ totalCurrency: 'USD' })))).toBe('invalid_file:total.currency');
    expect(refusal(() => read(ubl({ supplier: '20131312956' })))).toBe('invalid_file:supplier.ruc');
    expect(refusal(() => read(ubl({ id: 'F001 123' })))).toBe('invalid_file:id');
    expect(refusal(() => read(ubl({ lines: 0 })))).toBe('invalid_file:lines');
    expect(
      refusal(() => read(ubl().replace('<cbc:UBLVersionID>2.1', '<cbc:UBLVersionID>2.0'))),
    ).toBe('invalid_file:ubl_version');
    expect(refusal(() => read(ubl().replace(/Invoice-2/g, 'Order-2')))).toBe(
      'invalid_file:not_ubl',
    );
    expect(refusal(() => read(ubl().replace('&amp; soporte', '& soporte')))).toBe(
      'invalid_file:entity',
    );
    expect(refusal(() => read('<Invoice><a></b></Invoice>'))).toBe('invalid_file:mismatched_tag');
    expect(refusal(() => read(`${ubl()}<extra/>`))).toBe('invalid_file:second_root');
    expect(refusal(() => read(ubl().replace('cbc:ID>F001', 'zzz:ID>F001')))).toBe(
      'invalid_file:unbound_prefix',
    );
  });

  it('never reads a declared entity: no XXE, no expansion', () => {
    const xxe = ubl({
      prolog: '<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
    }).replace('Emisor S.A.C.', '&x;');
    expect(refusal(() => read(xxe))).toBe('invalid_file:doctype');
    const laughs = `<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><l>&b;</l>`;
    expect(refusal(() => parseXml(laughs))).toBe('invalid_file:doctype');
    expect(refusal(() => parseXml('<a>&#0;</a>'))).toBe('invalid_file:entity');
    expect(refusal(() => parseXml('<a>&unknown;</a>'))).toBe('invalid_file:entity');
    expect(parseXml('<a b="&#x41;&lt;">&#233;</a>')).toMatchObject({
      attributes: { b: 'A<' },
      text: 'é',
    });
  });

  it('reads UTF-8 and ISO-8859-1 files, and refuses other encodings', () => {
    const latin = ubl({ declaration: '<?xml version="1.0" encoding="ISO-8859-1"?>' }).replace(
      'Cliente S.A.',
      'Compañía Ñandú S.A.',
    );
    const bytes = Uint8Array.from(Buffer.from(latin, 'latin1'));
    expect(read(decodeXml(bytes)).counterparty?.legalName).toBe('Compañía Ñandú S.A.');
    expect(refusal(() => decodeXml(Uint8Array.from([0x3c, 0x61, 0xff, 0x3e])))).toBe(
      'invalid_file:encoding',
    );
    expect(refusal(() => decodeXml(enc('<?xml version="1.0" encoding="UTF-16"?><a/>')))).toBe(
      'invalid_file:encoding',
    );
    // A byte order mark is not content.
    expect(read(decodeXml(enc(`\uFEFF${ubl()}`))).number).toBe('123');
  });

  it('passes the contract suite with a file', async () => {
    const adapter = createPeUblAdapter();
    const problems = await checkInvoicingAdapterContract(adapter, {
      connection: { account: ACCOUNT } as unknown as InvoicingConnection,
      credentials: { values: {} },
      refusedCredentials: { values: {} },
      account: ACCOUNT,
      file: {
        format: 'ubl_xml',
        recordType: 'document',
        content: enc(ubl()),
        refused: [enc('not xml'), enc(ubl({ supplier: SUPPLIER })), enc('<!DOCTYPE a><a/>')],
      },
    });
    expect(problems).toEqual([]);
    expect(adapter.capabilities).toMatchObject({ listing: false, write: [] });
    expect(adapter.credentialKinds).toEqual([]);
    expect(() => adapter.checkAccount({ taxId: OURS, claveSol: 'x' })).toThrow(
      'invalid_connection',
    );
    expect(() => adapter.checkAccount({ taxId: '20131312956' })).toThrow('invalid_connection');
  });
});

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

describe('UBL files through the gateway', () => {
  it('imports each file once, with no credentials and no sync', async () => {
    const audit = new InMemoryAuditStore();
    const now = () => new Date('2026-10-13T00:00:00Z');
    const tenancy = new InMemoryTenancyStore(now, audit);
    const alice = '11111111-1111-4111-8111-111111111111' as UserId;
    const as: AuthenticatedContext = { actor: 'user', userId: alice, emailVerified: true };
    const { organization } = await createOrganization(as, { name: 'A' }, tenancy, {
      billing: BILLING,
      credits: openWallet,
    });
    const entitlements: Pick<EntitlementService, 'entitlementsOf'> = {
      entitlementsOf: async (tenant) => ({
        status: 'active',
        organizationId: tenant.organizationId as OrganizationId,
        plan: { id: 'test-plan', version: 1 },
        values: {
          ...defaultValues(),
          'integrations.categoriesAllowed': ['invoicing'],
          'integrations.connectionsMax': 1,
        },
      }),
    };
    let ids = 0;
    const repository = new InMemoryInvoicingRepository(audit);
    const gateway = createInvoicingGateway({
      repository,
      registry: createIntegrationRegistry([], { invoicing: [createPeUblAdapter()] }),
      secrets: new InMemorySecretStore(isInvoicingSecretRef),
      organizations: tenancy,
      authorization: createAuthorizationService(),
      entitlements,
      // No secret project: a provider without credentials still connects.
      now,
      newId: () => `eeeeeeee-eeee-4eee-8eee-${String(++ids).padStart(12, '0')}`,
    });
    const tenant = await resolveTenant(as, organization.id, tenancy);
    const created = await gateway.createConnection(tenant, {
      provider: PE_UBL_PROVIDER,
      displayName: 'Facturas XML',
      account: { taxId: OURS },
      jurisdiction: 'PE',
    });
    expect(created.secrets).toEqual({});
    const connection = await gateway.connect(tenant, created.id);
    expect(connection.status).toBe('connected');
    const file = enc(ubl());
    const imported = await gateway.importFile(tenant, {
      connectionId: connection.id,
      format: 'ubl_xml',
      recordType: 'document',
      content: file,
    });
    expect(imported).toMatchObject({ status: 'completed', counts: { created: 1, rejected: 0 } });
    expect(
      await gateway.importFile(tenant, {
        connectionId: connection.id,
        format: 'ubl_xml',
        recordType: 'document',
        content: file,
      }),
    ).toEqual(imported);
    const failed = await gateway.importFile(tenant, {
      connectionId: connection.id,
      format: 'ubl_xml',
      recordType: 'document',
      content: enc(ubl({ supplier: SUPPLIER })),
    });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'not_this_account' });
    const [stored] = (await gateway.listRecords(tenant, { recordType: 'document' })).items;
    const doc = stored?.record as unknown as NormalizedDocument & {
      source: { originalFormat: string };
    };
    expect(doc).toMatchObject({ number: '123', source: { originalFormat: 'ubl_2_1_xml' } });
    expect(JSON.stringify(stored)).not.toContain('UBLExtensions');
    await expect(
      gateway.startSync(tenant, {
        connectionId: connection.id,
        recordType: 'document',
        idempotencyKey: 'key-00000001',
      }),
    ).rejects.toThrow('capability_missing');
  });
});
