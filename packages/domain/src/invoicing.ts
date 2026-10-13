import type { Brand, IsoTimestamp, OrganizationId, UserId } from './ids.js';
import type { ChannelConnectionStatus, IntegrationProviderId, SecretRef } from './conversation.js';

/**
 * The Billing Integration Gateway (ADR-0193): an organization's connection to the invoicing
 * system it already uses (an electronic invoicing provider, a tax authority's read service or an
 * accounting tool), and what MelonOffice reads from it. It is the organization's own invoicing,
 * not MelonOffice's billing of the organization (plans and credits live in `billing.ts`).
 *
 * Version 1 reads and synchronizes only: nothing here issues, voids or changes a fiscal document.
 * The core is neutral by jurisdiction; a country's codes and rules live in its provider adapter.
 */

export type InvoicingConnectionId = Brand<string, 'InvoicingConnectionId'>;
export type InvoicingSyncJobId = Brand<string, 'InvoicingSyncJobId'>;
export type InvoicingRecordId = Brand<string, 'InvoicingRecordId'>;

/** What an invoicing provider can be asked for. */
export type InvoicingRecordType = 'party' | 'document' | 'payment';

/** File formats a provider's export can be imported from (ADR-0193). */
export type InvoicingFileFormat =
  /** One UBL 2.1 XML document per file. */
  | 'ubl_xml'
  /** A tax authority's period register export (for Peru, SIRE's sales register). */
  | 'authority_register'
  /** A provider's own CSV export, read by that provider's adapter only. */
  | 'provider_csv';

/**
 * What one provider's adapter can do, declared as data and copied onto each connection. The
 * gateway refuses anything a connection does not declare before its adapter is called.
 *
 * There is no write capability in version 1: issuing, voiding or changing a fiscal document needs
 * its own decision, tests and controls (ADR-0193). `write` is the empty list by type.
 */
export interface InvoicingCapabilities {
  /** Which records it reads, by listing or from files. */
  readonly records: readonly InvoicingRecordType[];
  /**
   * Whether it lists records from the provider (a sync). False for an adapter that only reads
   * files a person exports and imports: it has no sync, incremental reading or webhooks.
   */
  readonly listing: boolean;
  /** Whether it can list only what changed since a watermark. Otherwise every sync is full. */
  readonly incrementalSync: boolean;
  /** Whether the provider calls a webhook when something changes. */
  readonly webhooks: boolean;
  /** Which files its adapter can read. Empty: no import. */
  readonly fileImport: readonly InvoicingFileFormat[];
  /** Whether its documents carry the tax authority's status (accepted, rejected, voided). */
  readonly authorityStatus: boolean;
  /** Whether it reports payments that were confirmed (settled), not only recorded. */
  readonly paymentConfirmation: boolean;
  /** Whether disconnecting can revoke the access the provider granted. */
  readonly revokeOnDisconnect: boolean;
  /** The largest page the provider returns. */
  readonly maxPageSize: number;
  /** Always empty in version 1. */
  readonly write: readonly [];
}

/**
 * The provider account a connection reads from: public, non-sensitive identifiers only (for
 * example a tax id and a provider's account or company id). Checked by the adapter, never a
 * password, token or key.
 */
export type InvoicingAccount = Readonly<Record<string, string>>;

/**
 * Where the reading of one kind of record stands. The watermark moves only when a sync read every
 * page, so a sync that stopped early never skips what it did not read.
 */
export interface InvoicingSyncState {
  /** The provider's own watermark (an opaque value), from the last sync that read every page. */
  readonly watermark?: string;
  readonly lastCompleteAt?: IsoTimestamp;
  /** The last sync that ended, complete or not. */
  readonly lastSyncJobId?: InvoicingSyncJobId;
}

/**
 * An organization's connection to one invoicing provider. Lifecycle, permissions and secret
 * handling are the Integration Engine's (ADR-0044): the same statuses and transitions as a
 * channel connection, the same Secret Manager, references derived from the connection's id.
 */
export interface InvoicingConnection {
  readonly id: InvoicingConnectionId;
  readonly organizationId: OrganizationId;
  readonly provider: IntegrationProviderId;
  readonly category: 'invoicing';
  /** ISO 3166-1 alpha-2: whose tax rules its documents follow. */
  readonly jurisdiction: string;
  readonly status: ChannelConnectionStatus;
  /** Why it is in `error` (a stable code). */
  readonly statusReason?: string;
  readonly displayName: string;
  readonly account: InvoicingAccount;
  readonly capabilities: InvoicingCapabilities;
  /** References only, by purpose, derived by the server from the id. Never a value. */
  readonly secrets: Readonly<Record<string, SecretRef>>;
  readonly syncState: Readonly<Partial<Record<InvoicingRecordType, InvoicingSyncState>>>;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
  readonly updatedAt: IsoTimestamp;
  readonly updatedBy: UserId;
  readonly lastValidatedAt?: IsoTimestamp;
  readonly revision: number;
}

/** What started a sync. */
export type InvoicingSyncTrigger = 'manual' | 'webhook' | 'schedule' | 'file_import';

/**
 * Where a sync is. `incomplete` is explicit: the sync ended without reading or keeping
 * everything, and says why. Nothing reads an incomplete sync as complete.
 *
 * - `queued`: waiting to run, or waiting for its next attempt (`nextAttemptAt`).
 * - `running`: a worker holds its lease.
 * - `completed`: every page was read and every record kept.
 * - `incomplete`: it ended early or some records were refused (`incompleteReason`).
 * - `failed`: nothing could be read (credentials refused, provider unknown).
 */
export type InvoicingSyncStatus = 'queued' | 'running' | 'completed' | 'incomplete' | 'failed';

export type InvoicingIncompleteReason =
  /** The run's page limit was reached; the cursor is kept to resume. */
  | 'pages_remaining'
  /** The provider kept failing; the cursor is kept to resume. */
  | 'retries_exhausted'
  /** Every page was read but some records were refused (listed in `rejections`). */
  | 'records_rejected'
  /** A person turned the connection off, paused it or deleted it while it ran. */
  | 'connection_stopped';

/** Counted per sync: the figures metrics and cost estimates are built from. */
export interface InvoicingSyncCounts {
  readonly pagesRead: number;
  readonly providerCalls: number;
  readonly recordsSeen: number;
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly rejected: number;
  /** Bytes of original content read (pages or files), as the provider sent them. */
  readonly bytesRead: number;
}

/** A refused record: its provider id and a stable code. Never its content. */
export interface InvoicingRejection {
  readonly recordType: InvoicingRecordType;
  readonly externalId: string;
  readonly code: string;
}

export interface InvoicingSyncJob {
  readonly id: InvoicingSyncJobId;
  readonly organizationId: OrganizationId;
  readonly connectionId: InvoicingConnectionId;
  readonly provider: IntegrationProviderId;
  readonly recordType: InvoicingRecordType;
  readonly trigger: InvoicingSyncTrigger;
  /** The same key starts the same sync once. */
  readonly idempotencyKey: string;
  /** Who it runs for: the person, or for a webhook or a schedule, the connection's creator. */
  readonly initiatedBy: UserId;
  readonly status: InvoicingSyncStatus;
  readonly incompleteReason?: InvoicingIncompleteReason;
  /** Why it failed, or the provider's last error: a stable code. */
  readonly errorCode?: string;
  /** The watermark it read from (incremental), absent for a full sync. */
  readonly since?: string;
  /** Where the next page starts: kept so a stopped sync resumes where it stopped. */
  readonly cursor?: string;
  /** The provider's watermark to keep once every page is read. */
  readonly nextWatermark?: string;
  readonly attempts: number;
  readonly nextAttemptAt?: IsoTimestamp;
  /** The worker holding it, and until when (ADR-0030's lease, on this record). */
  readonly leaseId?: string;
  readonly leaseUntil?: IsoTimestamp;
  readonly counts: InvoicingSyncCounts;
  /** At most `MAX_REJECTIONS` are kept; `counts.rejected` has the total. */
  readonly rejections: readonly InvoicingRejection[];
  /** For a file import: the file's SHA-256, so the same file imports once. */
  readonly fileDigest?: string;
  readonly createdAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly finishedAt?: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly revision: number;
}

/**
 * Where a record came from, so it can always be traced to the original: the provider, its id
 * there, and the SHA-256 of the original content the adapter read (an XML, a JSON object, a
 * register line), with its format and size.
 */
export interface InvoicingSource {
  readonly connectionId: InvoicingConnectionId;
  readonly provider: IntegrationProviderId;
  readonly externalId: string;
  /** e.g. `ubl_2_1_xml`, `provider_json`, `authority_register_line`. */
  readonly originalFormat: string;
  readonly originalDigest: string;
  readonly originalBytes: number;
  readonly syncJobId: InvoicingSyncJobId;
  readonly readAt: IsoTimestamp;
}

/**
 * An amount exactly as the fiscal document states it: a decimal string (never a float), with
 * its ISO 4217 currency. Fiscal documents carry unit prices with more decimals than a currency's
 * minor unit, so amounts are not rounded to céntimos here.
 */
export interface FiscalAmount {
  readonly value: string;
  readonly currency: string;
}

/** A tax identifier with its scheme, e.g. `{ scheme: 'PE:RUC', value: '20131312955' }`. */
export interface TaxIdentifier {
  readonly scheme: string;
  readonly value: string;
}

/** A counterpart in the organization's invoicing: who it billed or who billed it. */
export interface InvoicingParty {
  readonly id: InvoicingRecordId;
  readonly organizationId: OrganizationId;
  readonly taxId?: TaxIdentifier;
  readonly legalName: string;
  readonly roles: readonly ('customer' | 'supplier')[];
  /** ISO 3166-1 alpha-2, when known. */
  readonly country?: string;
  readonly source: InvoicingSource;
  readonly revision: number;
}

/** What a document is, across jurisdictions. Its source code (SUNAT's 01, 03…) is kept apart. */
export type FiscalDocumentType = 'invoice' | 'receipt' | 'credit_note' | 'debit_note' | 'other';

/**
 * Whether the organization issued it (a sale) or received it (a purchase).
 */
export type FiscalDocumentDirection = 'issued' | 'received';

/**
 * What the tax authority said about the document, apart from whether it was issued, voided or
 * paid (ADR-0193):
 *
 * - `not_reported`: the source does not say (the provider does not know, or it was never sent).
 * - `pending`: sent, no answer yet.
 * - `accepted`: the authority accepted it (for Peru, SUNAT's or an OSE's acceptance).
 * - `accepted_with_observations`: accepted, with observations.
 * - `rejected`: refused; it has no fiscal effect.
 * - `not_found`: the authority has no record of it.
 */
export type FiscalAuthorityStatus =
  'not_reported' | 'pending' | 'accepted' | 'accepted_with_observations' | 'rejected' | 'not_found';

/**
 * Whether it was voided, apart from the authority's acceptance:
 *
 * - `none`: nothing says it was voided.
 * - `requested`: a void was requested and not yet confirmed.
 * - `voided`: the authority (or the source, for a jurisdiction without one) confirms it is void.
 */
export type FiscalVoidStatus = 'none' | 'requested' | 'voided';

/** How another document relates to this one. */
export interface FiscalDocumentRelation {
  readonly type: 'credits' | 'debits' | 'voids' | 'replaces' | 'references';
  /** The related document as the source names it. */
  readonly targetExternalId?: string;
  readonly targetSeries?: string;
  readonly targetNumber?: string;
  readonly targetSourceType?: string;
}

/** One line of a fiscal document. */
export interface FiscalDocumentLine {
  readonly position: number;
  readonly description: string;
  readonly quantity: string;
  readonly unitCode?: string;
  readonly unitPrice?: FiscalAmount;
  readonly net: FiscalAmount;
  readonly tax?: FiscalAmount;
  /** The source's own tax category code (for Peru, SUNAT's affectation code). */
  readonly taxCategory?: string;
  readonly productCode?: string;
}

/**
 * A fiscal document read from the organization's invoicing system. The four questions people
 * confuse are kept apart: was it issued (it exists here, `direction`), what did the authority say
 * (`authorityStatus`), was it voided (`voidStatus`) and was it paid (only confirmed payments
 * count, `confirmedPaid`).
 */
export interface FiscalDocument {
  readonly id: InvoicingRecordId;
  readonly organizationId: OrganizationId;
  readonly jurisdiction: string;
  readonly direction: FiscalDocumentDirection;
  readonly type: FiscalDocumentType;
  /** The source's own document type code (for Peru, SUNAT catálogo 01: `01`, `03`, `07`, `08`). */
  readonly sourceType: string;
  readonly series?: string;
  readonly number: string;
  /** The date on the document (YYYY-MM-DD), in the issuer's calendar. */
  readonly issueDate: string;
  readonly dueDate?: string;
  readonly issuer: { readonly taxId?: TaxIdentifier; readonly legalName: string };
  readonly counterparty?: { readonly taxId?: TaxIdentifier; readonly legalName: string };
  /** The party record of the counterpart, once read. */
  readonly counterpartyId?: InvoicingRecordId;
  readonly currency: string;
  readonly netTotal: FiscalAmount;
  readonly taxTotal: FiscalAmount;
  readonly total: FiscalAmount;
  readonly lines: readonly FiscalDocumentLine[];
  readonly relations: readonly FiscalDocumentRelation[];
  readonly authorityStatus: FiscalAuthorityStatus;
  /** The authority's own status code as the source gave it, for tracing. */
  readonly authorityStatusCode?: string;
  readonly authorityCheckedAt?: IsoTimestamp;
  readonly voidStatus: FiscalVoidStatus;
  /** Sum of confirmed payments, never of payments only recorded. */
  readonly confirmedPaid: FiscalAmount;
  readonly source: InvoicingSource;
  readonly revision: number;
}

/**
 * A payment as the source records it. `recorded`: the source has it (someone entered it).
 * `confirmed`: the source states the money was received (for example, matched to a bank
 * movement). Only `confirmed` counts as paid.
 */
export interface InvoicingPayment {
  readonly id: InvoicingRecordId;
  readonly organizationId: OrganizationId;
  readonly status: 'recorded' | 'confirmed' | 'reversed';
  readonly amount: FiscalAmount;
  /** YYYY-MM-DD. */
  readonly paidOn: string;
  readonly method?: string;
  /** The documents it pays, as the source names them. */
  readonly appliesTo: readonly { readonly externalId: string; readonly amount: FiscalAmount }[];
  readonly source: InvoicingSource;
  readonly revision: number;
}
