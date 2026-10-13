import type {
  FiscalAuthorityStatus,
  FiscalDocumentDirection,
  FiscalDocumentLine,
  FiscalDocumentRelation,
  FiscalDocumentType,
  FiscalAmount,
  FiscalVoidStatus,
  IntegrationProviderId,
  InvoicingAccount,
  InvoicingCapabilities,
  InvoicingConnection,
  InvoicingFileFormat,
  InvoicingRecordType,
  TaxIdentifier,
} from '@melonoffice/domain';
import type { ConnectionCheck } from '../adapter.js';
import { isProviderId } from '../registry.js';

/**
 * The contract every invoicing provider's adapter meets (ADR-0193). An adapter only translates
 * and reads its provider's official API or export files. It never decides who may read, whether
 * a connection may be used, how often to retry or what to keep: the Billing Integration Gateway
 * does, and is its only caller.
 *
 * Read only, by construction: the contract has no method that issues, voids, sends or changes a
 * fiscal document, and `checkInvoicingAdapter` refuses an adapter that brings one.
 */

export const INVOICING_RECORD_TYPES = [
  'party',
  'document',
  'payment',
] as const satisfies readonly InvoicingRecordType[];

export const INVOICING_FILE_FORMATS = [
  'ubl_xml',
  'authority_register',
  'provider_csv',
] as const satisfies readonly InvoicingFileFormat[];

export const isInvoicingRecordType = (value: unknown): value is InvoicingRecordType =>
  typeof value === 'string' && (INVOICING_RECORD_TYPES as readonly string[]).includes(value);

export const isInvoicingFileFormat = (value: unknown): value is InvoicingFileFormat =>
  typeof value === 'string' && (INVOICING_FILE_FORMATS as readonly string[]).includes(value);

/** The secrets an invoicing connection reads, by purpose: names, never values. */
const CREDENTIAL_KIND = /^[a-z][a-z0-9_]{1,30}$/;

export const isCredentialKind = (value: unknown): value is string =>
  typeof value === 'string' && CREDENTIAL_KIND.test(value);

/** Read from the secret store for one call, then dropped: never stored, logged or returned. */
export interface InvoicingCredentials {
  readonly values: Readonly<Record<string, string>>;
}

/**
 * The original content a record was read from (an XML document, a JSON object, a register line),
 * exactly as the provider sent it. The gateway keeps its SHA-256, format and size; the content
 * itself is not stored in version 1 (ADR-0193).
 */
export interface InvoicingOriginal {
  readonly format: string;
  readonly content: string;
}

interface NormalizedBase {
  /** The record's id at the provider: stable across reads. */
  readonly externalId: string;
  readonly original: InvoicingOriginal;
}

export interface NormalizedParty extends NormalizedBase {
  readonly recordType: 'party';
  readonly taxId?: TaxIdentifier;
  readonly legalName: string;
  readonly roles: readonly ('customer' | 'supplier')[];
  readonly country?: string;
}

export interface NormalizedDocument extends NormalizedBase {
  readonly recordType: 'document';
  readonly direction: FiscalDocumentDirection;
  readonly type: FiscalDocumentType;
  readonly sourceType: string;
  readonly series?: string;
  readonly number: string;
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly issuer: { readonly taxId?: TaxIdentifier; readonly legalName: string };
  readonly counterparty?: { readonly taxId?: TaxIdentifier; readonly legalName: string };
  readonly currency: string;
  readonly netTotal: FiscalAmount;
  readonly taxTotal: FiscalAmount;
  readonly total: FiscalAmount;
  readonly lines: readonly FiscalDocumentLine[];
  readonly relations: readonly FiscalDocumentRelation[];
  readonly authorityStatus: FiscalAuthorityStatus;
  readonly authorityStatusCode?: string;
  readonly voidStatus: FiscalVoidStatus;
}

export interface NormalizedPayment extends NormalizedBase {
  readonly recordType: 'payment';
  readonly status: 'recorded' | 'confirmed' | 'reversed';
  readonly amount: FiscalAmount;
  readonly paidOn: string;
  readonly method?: string;
  readonly appliesTo: readonly { readonly externalId: string; readonly amount: FiscalAmount }[];
}

export type NormalizedInvoicingRecord = NormalizedParty | NormalizedDocument | NormalizedPayment;

/** One page the gateway asks for. */
export interface InvoicingPageRequest {
  readonly recordType: InvoicingRecordType;
  /** Where to continue; absent on the first page. Opaque: only the adapter reads it. */
  readonly cursor?: string;
  /** Only what changed after this watermark (incremental). Absent: everything (full). */
  readonly since?: string;
  readonly pageSize: number;
  readonly timeoutMs: number;
}

/** One page the provider returned. */
export interface InvoicingPage {
  readonly records: readonly NormalizedInvoicingRecord[];
  /** Absent: this was the last page. */
  readonly nextCursor?: string;
  /** The provider's watermark to keep once the last page is read. */
  readonly watermark?: string;
  /** Bytes of the provider's answer, as received. */
  readonly bytes: number;
}

/**
 * What a verified webhook says changed. Only a hint: the gateway never keeps a webhook's content
 * as data; it starts an incremental sync that reads the provider's API again.
 */
export interface InvoicingWebhookHint {
  /** The provider's event id: the same event starts its syncs once. */
  readonly eventId: string;
  readonly recordTypes: readonly InvoicingRecordType[];
}

export interface InvoicingAdapter {
  /** The official provider, e.g. a PSE's API or a tax authority's read service. */
  readonly provider: IntegrationProviderId;
  readonly category: 'invoicing';
  /** ISO 3166-1 alpha-2 countries whose documents it reads. */
  readonly jurisdictions: readonly string[];
  readonly capabilities: InvoicingCapabilities;
  /**
   * The secrets a connection needs, by purpose (e.g. `api_token`, `client_id`,
   * `client_secret`, `webhook_secret`). Each lives in Secret Manager under a name derived from
   * the connection's id; the API never accepts their values.
   */
  readonly credentialKinds: readonly string[];
  /**
   * The account a person configures: only its known, public fields (a tax id, a provider's
   * company id). Throws `invalid_connection` on anything else.
   */
  checkAccount(value: unknown): InvoicingAccount;
  /** The account's identity at the provider, to refuse two connections to the same account. */
  accountIdOf(account: InvoicingAccount): string;
  /** Whether the credentials open the account. Reads only. */
  validateConnection(
    connection: InvoicingConnection,
    credentials: InvoicingCredentials,
  ): Promise<ConnectionCheck>;
  /**
   * With `capabilities.listing`: one page of records, normalized. Once: retrying is the gateway's. Throws
   * `provider_rejected` (credentials or request refused; the detail is a stable code) or
   * `provider_unavailable` (no answer, rate limited; may carry `retryAfterMs`).
   */
  listPage?(
    connection: InvoicingConnection,
    credentials: InvoicingCredentials,
    request: InvoicingPageRequest,
  ): Promise<InvoicingPage>;
  /** With `capabilities.webhooks`: the provider's signature over the exact raw body. */
  verifyWebhook?(rawBody: string, headers: Headers, secret: string): boolean;
  /** With `capabilities.webhooks`: what changed. Throws `invalid_payload`. */
  parseWebhook?(rawBody: string): InvoicingWebhookHint;
  /**
   * With `capabilities.fileImport`: the records in one exported file. Throws `invalid_file` with
   * a stable detail on anything it cannot read.
   */
  readFile?(
    format: InvoicingFileFormat,
    content: Uint8Array,
    account: InvoicingAccount,
  ): InvoicingPage;
  /** With `capabilities.revokeOnDisconnect`: asks the provider to revoke the access it granted. */
  revokeAccess?(connection: InvoicingConnection, credentials: InvoicingCredentials): Promise<void>;
}

/** Everything an adapter may have. Anything else (an `issue`, a `void`, a `send`) is refused. */
const ADAPTER_KEYS: ReadonlySet<string> = new Set([
  'provider',
  'category',
  'jurisdictions',
  'capabilities',
  'credentialKinds',
  'checkAccount',
  'accountIdOf',
  'validateConnection',
  'listPage',
  'verifyWebhook',
  'parseWebhook',
  'readFile',
  'revokeAccess',
]);

const CAPABILITY_KEYS = [
  'records',
  'listing',
  'incrementalSync',
  'webhooks',
  'fileImport',
  'authorityStatus',
  'paymentConfirmation',
  'revokeOnDisconnect',
  'maxPageSize',
  'write',
] as const;

const COUNTRY = /^[A-Z]{2}$/;
/** The largest page any adapter may declare. */
export const MAX_INVOICING_PAGE_SIZE = 500;

/** Whether capabilities read back from storage or declared by an adapter are well formed. */
export function isInvoicingCapabilities(value: unknown): value is InvoicingCapabilities {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    Object.keys(c).every((k) => (CAPABILITY_KEYS as readonly string[]).includes(k)) &&
    Array.isArray(c.records) &&
    c.records.length > 0 &&
    c.records.every(isInvoicingRecordType) &&
    new Set(c.records).size === c.records.length &&
    typeof c.listing === 'boolean' &&
    // Without listing there is nothing to read incrementally or to be told about.
    (c.listing || (c.incrementalSync === false && c.webhooks === false)) &&
    // An adapter reads somehow: by listing, or from files.
    (c.listing || (Array.isArray(c.fileImport) && c.fileImport.length > 0)) &&
    typeof c.incrementalSync === 'boolean' &&
    typeof c.webhooks === 'boolean' &&
    Array.isArray(c.fileImport) &&
    c.fileImport.every(isInvoicingFileFormat) &&
    typeof c.authorityStatus === 'boolean' &&
    typeof c.paymentConfirmation === 'boolean' &&
    typeof c.revokeOnDisconnect === 'boolean' &&
    Number.isSafeInteger(c.maxPageSize) &&
    (c.maxPageSize as number) > 0 &&
    (c.maxPageSize as number) <= MAX_INVOICING_PAGE_SIZE &&
    // Version 1 reads only (ADR-0193).
    Array.isArray(c.write) &&
    c.write.length === 0
  );
}

/**
 * Refuses an adapter that does not meet the contract: an unknown key (anything that could write),
 * capabilities that are malformed or declare writing, or an optional method its capabilities need
 * and it lacks. Called by the registry, so a wrong adapter never starts.
 */
export function checkInvoicingAdapter(adapter: InvoicingAdapter): void {
  const fail = (why: string): never => {
    throw new Error(`invalid invoicing adapter ${String(adapter.provider)}: ${why}`);
  };
  for (const key of Object.keys(adapter)) {
    if (!ADAPTER_KEYS.has(key)) fail(`unknown member ${key}`);
  }
  if (!isProviderId(adapter.provider)) fail('provider');
  if (adapter.category !== 'invoicing') fail('category');
  if (
    !Array.isArray(adapter.jurisdictions) ||
    adapter.jurisdictions.length === 0 ||
    !adapter.jurisdictions.every((j) => COUNTRY.test(j))
  ) {
    fail('jurisdictions');
  }
  if (!isInvoicingCapabilities(adapter.capabilities)) fail('capabilities');
  if (
    !Array.isArray(adapter.credentialKinds) ||
    !adapter.credentialKinds.every(isCredentialKind) ||
    new Set(adapter.credentialKinds).size !== adapter.credentialKinds.length
  ) {
    fail('credentialKinds');
  }
  const c = adapter.capabilities;
  if (c.listing !== (adapter.listPage !== undefined)) fail('listing and listPage disagree');
  if (c.webhooks) {
    if (adapter.verifyWebhook === undefined || adapter.parseWebhook === undefined) {
      fail('webhooks without verifyWebhook and parseWebhook');
    }
    if (!adapter.credentialKinds.includes('webhook_secret')) fail('webhooks without a secret');
  }
  if (c.fileImport.length > 0 && adapter.readFile === undefined)
    fail('fileImport without readFile');
  if (c.revokeOnDisconnect && adapter.revokeAccess === undefined) {
    fail('revokeOnDisconnect without revokeAccess');
  }
}
