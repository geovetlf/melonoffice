# ADR-0193: Billing Integration Gateway (read and sync an organization's own invoicing)

- Status: Proposed (phase 1 of 4; nothing is connected to a real provider)
- Date: 2026-10-13
- Builds on: [ADR-0019](0019-rbac-foundation.md) (permissions), [ADR-0020](0020-audit-log-foundation.md) (audit), [ADR-0030](0030-execution-jobs-and-lease.md) (leases), [ADR-0033](0033-conversations-foundation.md) (secrets in Secret Manager), [ADR-0044](0044-integration-engine.md) (Integration Engine), [ADR-0045](0045-channel-delivery-limits-and-retries.md) (retries and backoff)
- Decision: Geovet's brief of 2026-10-13 (01:59Z): a central gateway, a common adapter contract, Peru/SUNAT first, read and sync only, a normalized model, contract tests with doubles until a real provider is chosen.
- Terraform: none. Firestore: none yet (schema below, written in phase 2). No migration, no index, no UI.

## Context

Customers want MelonOffice to see their invoicing: who they billed, what SUNAT accepted, what was voided and what was paid. This is the organization's own invoicing system (an electronic invoicing provider, SUNAT's read services, an ERP), not MelonOffice's billing of the organization (`@melonoffice/billing`, plans and credits). In code the module is called `invoicing` so the two are never confused.

There is no universal API that reads every invoicing system. In Peru (read on 2026-10-13, sources in the phase plan below):

- SUNAT's **Consulta Integrada** API checks one document at a time (issuer, type, series, number, date, amount) and answers its status (`estadoCp`: 0 does not exist, 1 accepted, 2 voided, 3 authorized, 4 not authorized). OAuth `client_credentials` with a client id and secret the taxpayer generates in SOL. It cannot list.
- SUNAT's **SIRE** API (RVIE, sales register) exports a month of sales as an asynchronous ticket and zipped text files. Its token uses `grant_type=password` with the taxpayer's RUC, SOL user and **Clave SOL**, plus a client id and secret.
- SUNAT has no webhooks: reading is polling.
- PSEs and ERPs differ: Nubefact's API consults one document by series and number (no listing, no webhooks); Bsale lists documents by date and has webhooks on request; others publish no read API.

So the gateway cannot assume one way to read. It must take adapters that list, adapters that check one document, adapters that read exported files, and adapters with or without webhooks, and say which they are.

## Decision

1. **One gateway, inside the Integration Engine.** `createInvoicingGateway()` in `packages/integrations/src/invoicing/` is the only caller of an invoicing adapter (an architecture test enforces it). It reuses what exists and adds nothing parallel:
   - the provider registry (`createIntegrationRegistry(channels, { invoicing })`), with one provider-id namespace;
   - the connection lifecycle (`created` … `revoked`, `CONNECTION_TRANSITIONS`, `occupiesSlot`, `acceptsInbound`);
   - Secret Manager through the same `SecretStore`, with references derived from the connection id;
   - the same `IntegrationError` codes, the same audit trail and the same retry backoff (`backoffDelay`);
   - the plan's `integrations.categoriesAllowed` (new category `invoicing`) and one `integrations.connectionsMax` that counts channel and invoicing connections together.
2. **Common adapter contract** (`contract.ts`). An adapter declares, as data: its provider id, jurisdictions, credential kinds and capabilities (`records`, `incrementalSync`, `webhooks`, `fileImport`, `authorityStatus`, `paymentConfirmation`, `revokeOnDisconnect`, `maxPageSize`, `write`). It implements `checkAccount`, `accountIdOf`, `validateConnection`, `listPage` (cursor + watermark), and when its capabilities say so `verifyWebhook` + `parseWebhook`, `readFile`, `revokeAccess`. `checkInvoicingAdapter` refuses any other member and any capability it does not know.
3. **Read only in version 1.** `write` is the empty list by type and by check; the contract has no method to issue, void, send or change a document, and a test lists its methods. Writing needs a separate decision, tests and controls.
4. **Jurisdiction-neutral core.** The normalized model has no SUNAT code. A document keeps its source type (`sourceType`, e.g. `01`) next to the neutral type (`invoice`), tax ids carry a scheme (`PE:RUC`), and the authority's own status code is kept for tracing (`sunat_cp:2`). Peru's mappings (catálogo 01, RUC check digit, `estadoCp`) live in `invoicing/pe/sunat.ts`, for Peruvian adapters only.
5. **Four questions kept apart** on a fiscal document: it was **issued** (it exists in the source, `direction`), what the **authority** said (`authorityStatus`: not reported, pending, accepted, accepted with observations, rejected, not found), whether it was **voided** (`voidStatus`: none, requested, voided) and whether it was **paid** (`confirmedPaid`, the exact sum of payments the source reports as `confirmed`; a `recorded` payment never counts).
6. **Traceability.** Every record keeps its source: connection, provider, provider id, sync, time read, and the SHA-256, format and size of the original content (an XML, a JSON object, a register line). The original itself is not stored in phase 1; phase 2 decides where (see risks).
7. **Amounts are exact.** Decimal strings with their ISO 4217 currency, never floats and not rounded to céntimos (unit prices carry more decimals than a currency). Sums use integer arithmetic.
8. **Syncs.** A sync reads one record type of one connection:
   - **Idempotent.** A caller's key starts one sync (`manual:`, `webhook:{event}:{type}`, `file:{type}:{sha256}`, `resume:{sync}`), and only one sync per connection and record type runs at a time.
   - **Leased and bounded.** A worker leases it (ADR-0030's pattern on the record), reads up to `pagesPerRun` pages, saves its cursor after each page, and gives the lease back. A sync ends `incomplete` after `pagesPerSync` pages.
   - **Retries.** A provider that does not answer is retried with exponential backoff and jitter, never earlier than its `Retry-After`, up to `maxAttempts`. Credentials refused: `failed`.
   - **Explicit incomplete states** (`incompleteReason`): `pages_remaining`, `retries_exhausted`, `records_rejected` (listed, by provider id and code) and `connection_stopped`. The first, second and fourth keep their cursor and can be resumed.
   - **Watermark.** Incremental syncs read from the record type's watermark, which moves only when a sync read every page, so a sync that stopped never skips anything.
   - **Records** are upserted by organization, connection, type and provider id: unchanged when the original's digest is the same, a new revision otherwise. A bad record is refused alone and counted; it never stops the others.
9. **Webhooks are hints.** A webhook is verified with the connection's `webhook_secret` (the adapter's signature check over the raw body). It then starts incremental syncs, once per provider event id, and its content is never stored as data. The organization comes from the stored connection. A paused connection acknowledges and reads nothing; a disconnected one refuses.
10. **File import.** For providers or authorities that only export files (`ubl_xml`, `authority_register`, `provider_csv`): through the connection's adapter, bounded (`maxFileBytes`, 10 MB by default), the same file once (by SHA-256), counted like a sync.
11. **Disconnection.** Turning a connection off or pausing it ends its running syncs as `incomplete` (`connection_stopped`), refuses its webhooks and, when the provider can, revokes the access it granted (best effort). Synced records are kept. Deleting (`revoked`) is final; its secrets are deleted by an operator.
12. **Permissions.** Connection management uses the existing `channel.read`, `channel.create`, `channel.update`, `channel.disconnect` and `channel.delete`. New: `invoicing.read` (records, syncs, figures) and `invoicing.sync` (start, resume, import). Both go to the owner role only. Every change and every sync start is a person's own act (`requires_user`): never GIA or the runtime. The runtime finishes a sync for the person who started it; a webhook's sync runs for the person who created the connection.
13. **Credentials.** Secret values live in Secret Manager only, as `invoicing-{connectionId}-{kind}`. The API never takes a value: creation refuses any account field named like a secret (`pass`, `clave`, `token`, `key`, `secret`, `usuario`…), whatever the adapter allows. The Clave SOL is never asked in MelonOffice's web app and never stored in plain text: if a SIRE adapter is chosen, the owner puts it in Secret Manager directly (as with WhatsApp's secrets), and that adapter needs its own decision (see risks).
14. **Audit** (category `channel`, so the trail's filters do not change): `channel.invoicing_connection_created`, `_checked`, `_changed`, `channel.invoicing_sync_started` and `_finished`. Codes and counts only: never content, amounts, names or secrets.
15. **Metrics and costs** (`metrics.ts`). Per organization, provider and connection: syncs by trigger and status, pages, provider calls, records seen, documents processed (created, updated, unchanged, rejected), bytes read, syncs per day and median minutes between syncs. Every figure is counted from the syncs themselves. A cost estimate needs a unit cost with its source for each driver priced (provider call, document, megabyte, sync); without one the answer is `unknown`, never zero. No price is written in code.
16. **No connector is operational** until its adapter passes the contract suite (`checkInvoicingAdapterContract`) against the provider's sandbox or a real account, with Geovet's authorization. Until then only the test double exists, and it is registered nowhere outside tests.

## Data schema (Firestore, phase 2)

Every document carries `organizationId`; every query is scoped by it. Server-only collections, closed to clients by the existing rules.

| Collection             | Id                                               | Holds                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `invoicingConnections` | connection id                                    | `InvoicingConnection`: provider, jurisdiction, status, account (public ids), capabilities, secret references, `syncState` per record type (watermark, last complete), revision                |
| `invoicingSyncJobs`    | sync id                                          | `InvoicingSyncJob`: record type, trigger, key, status, incomplete reason, error code, since, cursor, next watermark, attempts, next attempt, lease, counts, up to 100 rejections, file digest |
| `invoicingSyncKeys`    | `{org}:{connection}:{key}`                       | the sync id, written in the same transaction: a key starts one sync                                                                                                                           |
| `invoicingSyncLocks`   | `{org}:{connection}:{recordType}`                | the running sync's id, set and cleared in the same transactions as the sync: one sync per connection and record type, also across instances                                                   |
| `invoicingRecords`     | `{org}:{connection}:{type}:{sha256(providerId)}` | `InvoicingParty`, `FiscalDocument` (lines and relations inline, at most 1,000 and 50) or `InvoicingPayment`, each with its source and revision                                                |

Indexes needed (phase 2, Terraform): syncs by organization + connection + created; records by organization + type + connection; payments by organization + connection + applied document.

## Phases

1. **Phase 1 (this change): architecture.** Contract, normalized model, gateway, in-memory store, test double, contract suite, Peru mappings, permissions, audit actions, metrics. INTERNAL ONLY, no UI required. No API route, no worker job, no Firestore, no Terraform.
2. **Phase 2: storage and execution.** Firestore repository against the emulator, its indexes in Terraform (plan only), the sync job on the existing job queue (Cloud Tasks `execution-jobs`), a schedule through the existing recurrence (ADR-0185), API routes, the webhook route. Needs Geovet's go and a DEV plan.
3. **Phase 3: the first real adapter.** Chosen by Geovet from what customers use (options below), passing the contract suite against its sandbox or a DEV account he authorizes. Only then is it called operational.
4. **Phase 4: the user-facing slice.** Screens for connections, syncs and documents, as a vertical slice, after his decisions on what users see.

### Options for the first adapter (Geovet decides)

| Option                                    | What it reads                          | Credentials of the customer                   | Fit                                                                          |
| ----------------------------------------- | -------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------- |
| SUNAT Consulta Integrada                  | One document's status at a time        | client id + secret (no Clave SOL)             | Confirms SUNAT status of documents read elsewhere; cannot discover them      |
| SUNAT SIRE (RVIE)                         | A month of sales, async                | client id + secret + SOL user + **Clave SOL** | Lists everything issued, by month, without XML; needs the Clave SOL decision |
| A PSE or ERP with a list API (e.g. Bsale) | Documents by date, webhooks on request | The customer's token there                    | Fits incremental sync; only for its own customers                            |
| A PSE without a list API (e.g. Nubefact)  | One document by series and number      | The customer's token there                    | Status and originals of known documents only                                 |
| Exported files (UBL XML, SIRE text)       | What the customer uploads              | None                                          | Works for every provider, no credentials; manual                             |

## Residual risks

- **Clave SOL.** SIRE's API needs it. Storing it in Secret Manager is encrypted at rest and never shown, but holding a taxpayer's SOL password (or a secondary user's) is a legal and trust decision for Geovet, not a technical one. Not built.
- **Originals.** Only their digest is kept in phase 1. Keeping XMLs (for audit or to re-normalize) needs a Cloud Storage bucket and a retention policy: infrastructure and a decision.
- **One plan slot across two services.** The channel connection service does not yet count invoicing connections against `integrations.connectionsMax`; the gateway counts both. Phase 2 wires the channel side before any route exists, or the limit can be exceeded by one service.
- **Retention after disconnection.** Synced records are kept. How long, and whether deleting a connection deletes them, is a product and legal decision.
- **Authority status freshness.** A document read as `accepted` can be voided later (up to seven calendar days for a comunicación de baja). Incremental reads only see it if the source reports the change; a periodic status re-check (Consulta Integrada) may be needed.
- **Provider limits and prices.** None of the sources read publish rate limits or API prices. Cost estimates stay `unknown` until someone supplies sourced unit costs.
- **Firestore sizes.** A document with 1,000 lines fits in one Firestore document only if lines stay short; phase 2 must measure and may move lines to a subcollection.

## Consequences

- `IntegrationCategory` gains `invoicing`; a channel adapter cannot claim it.
- New error codes: `capability_missing`, `sync_not_found`, `sync_in_progress`, `sync_not_resumable`, `invalid_file`, `file_too_large`, `record_not_found`.
- `InMemorySecretStore` takes the same `accepts` predicate as the Secret Manager store.
- Code: `packages/domain/src/invoicing.ts`, `packages/integrations/src/invoicing/`, `registry.ts`, `secrets.ts`, `errors.ts`, `packages/rbac` (two permissions), `packages/audit` (five actions, two target types).
