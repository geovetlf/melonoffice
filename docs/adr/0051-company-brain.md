# ADR-0051: Company Brain

- Status: Proposed
- Date: 2026-09-28
- Builds on: ADR-0019 (RBAC), ADR-0020 (audit), ADR-0027/0037/0038 (AI Gateway and assisted calls), ADR-0029 (the four kinds of context), ADR-0044 (Integration Engine), ADR-0048 (business profile), ADR-0049 (activity) and Geovet's "Implementación core — Company Brain" of 2026-09-28
- Does not change: tenancy, billing, credits, plans, executions, the tool gate, conversations, the Integration Engine or the web app.

## Context

Geovet asked for Company Brain as a core capability of MelonMotor: the organization's own knowledge, from every source, with provenance, states, versions, conflicts, least-privilege retrieval for GIA and agents, audit, and no second architecture.

Before this ADR, the real code held:

- a Company Context **contract** only (ADR-0029, `packages/domain/src/context.ts`);
- the business profile as its first data (ADR-0048);
- the audit trail as the only record of events;
- the AI Gateway with one assisted path;
- the Integration Engine's connections.

It had no event bus, no Decision Engine, no document store, no CRM adapter and no vector store.

## Decision

### 1. Where it lives

- `packages/brain` is the service, with no HTTP of its own.
- `packages/firestore/src/knowledge.ts` is its storage.
- `apps/api/src/brain.ts` holds its routes.
- It is the `company` kind of context of ADR-0029, kept apart from:
  - **user profile**: the user's own record; Company Brain stores only who recorded a fact;
  - **conversation memory**: conversations and their summaries;
  - **execution/agent memory**: executions, their outputs and agents' kept answers.
- There is one Company Brain per organization. Every read and write names a resolved tenant, and every stored record carries its `organizationId`.

### 2. The model

Company Brain has no table per topic. It has one generic, typed item, so it grows without new schemas.

- **`KnowledgeItem`** (`knowledgeItems/{id}`):
  - `domain`, `key`, and an optional `subject` (`{type, id}`, e.g. product `combo_familiar`) with its `label`;
  - a typed `value`: text, number with unit, money in minor units with ISO currency, boolean, list or date;
  - `verification`: proposed, unverified, confirmed, calculated or imported;
  - `status`: active, outdated or archived;
  - `sensitivity`: internal, confidential or restricted;
  - `critical`;
  - `provenance`: `sourceType`, `sourceId`, `sourceReference`, `recordedBy`, `confidence`;
  - `relations` (`belongs_to`, `used_in`, `targets`, `has_price`, `part_of`, `related_to`);
  - `effectiveFrom`/`effectiveUntil`, `revision`, `createdAt`/`updatedAt`, `openConflictId`.
- **Domains** (catalogue data): identity, business_model, products, customers, commercial, marketing, brand, operations, finance, team, policies, goals, documents, integrations, decisions.
  - Decisions, goals, document references and integration references are items in their domains, with their provenance; they are not separate entities.
- **Item ids are deterministic:** a hash of organization, domain, key and subject. Two sources stating the same fact meet on one item, which is how conflicts are found.
- **`KnowledgeVersion`** (`knowledgeVersions/{itemId}_{revision}`, created once): every revision as it was, with operation, who changed it and the reason. "Current S/28, before S/25, when, by whom, from which source" is the item plus its versions.
- **`KnowledgeConflict`** (`knowledgeConflicts/{id}`): two claims (value, verification, provenance), open or resolved, and how it was resolved.
- **`KnowledgeDocument`** (`knowledgeDocuments/{id}`, id from the text's SHA-256): a document as received, with its status and fact count.

### 3. Rules (deterministic, no model)

- **Verification comes from the source:**
  - a person acting directly with `knowledge.manage` gives `confirmed`;
  - GIA, an agent or a workflow gives `proposed`;
  - a document gives `unverified`;
  - analytics or MelonOffice's own records give `calculated`;
  - a CRM, integration or import gives `imported`.
  - An AI inference is never confirmed until a person confirms it.
- **Merge** (`merge.ts`):
  - A new fact is created.
  - The same value changes nothing, unless a person now states it, which confirms it.
  - A different value:
    - from a person replaces it, and settles any open conflict;
    - from the same source as the current unconfirmed value is that source's newer reading;
    - replaces a mere proposal;
    - otherwise it opens a **conflict** and the value stays as it was. One open conflict per item; a later disagreement updates it.
- **Critical facts** (legal identity, prices, costs, margins, finance, policies, decisions) are flagged `needsConfirmation` until a person confirms them.
- **Mutations:**
  - create, update, merge, confirm, invalidate (outdated, with `effectiveUntil`), archive and resolve conflict;
  - each is a new revision with its version, in one transaction with its audit event;
  - confirm, invalidate, archive and resolve need the current revision and a person acting directly.

### 4. Access

- **New permissions** (owner only today):
  - `knowledge.read`, up to confidential;
  - `knowledge.read_restricted`;
  - `knowledge.propose`;
  - `knowledge.manage` (direct only);
  - `knowledge.capture` (spends credits).
- **Retrieval by purpose**:
  - `gia` reads every domain the person may read;
  - each department's agents read only their domains, up to a sensitivity ceiling:
    - marketing and research: no costs, budgets or customer records;
    - sales and operations: up to confidential;
    - finance and leadership: restricted.
  - The ceiling is never above the person's own permissions.
  - A department not in the table reads nothing until someone decides its access.
- **Isolation:** another organization's records are never returned, even by id.

### 5. Context retrieval (selective, cheap)

`context(tenant, {purpose, domains?, keys?, subjects?, query?, limit?})`:

- **Candidates:** it reads the organization's active items (one query, capped), then filters by the purpose's domains and sensitivity.
- **Scoring:** key and subject matches, accent-insensitive word matches of the query, then trust and recency.
- **Result:** at most 40 small facts (value as one line, verification, source), plus a `company_context` ref whose version is the latest change among them.
- **Nothing more is sent:** it lists the domains it withheld and says when it was truncated, and it never returns the whole brain. No model, embedding or vector store is used; one can be added behind the same call when volume justifies it.

### 6. Sources wired today

- **The organization's name:** entered at creation, as the owner's confirmed fact. This initializes the brain; it is best effort, and the organization is created whatever happens.
- **The business profile (ADR-0048):** each save feeds it as the owner's confirmed facts. Saving again changes nothing.
- **MelonOffice's own records** (`POST .../brain/sync`): active departments, active agents and connected channels, as `calculated`. Safe to repeat.
- **Integration Engine connections:** `ingestFromConnection` accepts facts only through the organization's own connected connection. A CRM gives `crm` facts and any other connection `integration`, both `imported`. There is no CRM adapter yet, so nothing calls it in production.
- **Agents, workflows and analyses:** `recordResult` records their results as proposals, or as `calculated` for analyses. The runtime acts as `agent`.
- **GIA capture** (`POST .../brain/capture`) and **documents** (`POST .../brain/documents`, plain text up to 60,000 characters):
  - extraction goes through the existing AI Gateway, with a new assisted subject `company_knowledge`, the permission `knowledge.capture` and its own policy `company_knowledge_assist` v1 (same model, DEV only, 1 credit ceiling, no fallback);
  - the model returns a closed schema, and each candidate is checked like any input;
  - results enter as `proposed` (GIA) or `unverified` (document), with the document as their source;
  - without a usable model the document is kept, marked `stored`, and nothing is invented.
- **Onboarding:** `gaps()` returns only the questions whose facts are still missing (what the business does, main products, customers, areas, goals, tone), the facts to confirm, and the number of open conflicts. GIA asks from this list and never asks again what is known.

### 7. Audit and observability

- **Audit actions** (category `knowledge`): `knowledge.created`, `updated`, `confirmed`, `invalidated`, `archived`, `conflict_detected`, `conflict_resolved` and `document_ingested`.
  - They carry target (`knowledge_item`, `knowledge_conflict` or `knowledge_document`), `targetVersion` = revision, `reference` = `{domain}:{sourceType}`, and a reason code.
  - The audit trail never holds values; old and new values are the item's versions.
- **Logs:** `brain.knowledge_written` (outcome, domain, source, latency), `brain.knowledge_conflict`, `brain.context_retrieved` (purpose, facts, candidates, latency), `brain.extraction_failed` and `brain.authorization_denied`, through the existing logger.

### 8. HTTP

`/v1/organizations/:id/brain`:

| Method and path                                             | What it does                       |
| ----------------------------------------------------------- | ---------------------------------- |
| `GET` (the root)                                            | summary and gaps                   |
| `GET knowledge?domain=&inactive=1`                          | list                               |
| `GET knowledge/:itemId`                                     | item and versions                  |
| `POST knowledge`                                            | propose                            |
| `POST knowledge/:itemId/confirm`, `/invalidate`, `/archive` | with `{revision}`                  |
| `GET conflicts`                                             | open conflicts                     |
| `POST conflicts/:id/resolve`                                | with `{choice}`                    |
| `GET gaps`                                                  | missing facts and facts to confirm |
| `POST context`                                              | selective retrieval                |
| `POST capture`                                              | GIA capture                        |
| `POST documents`                                            | a document                         |
| `POST sync`                                                 | MelonOffice's own records          |

- Views never include another person's id: `recordedBy` is you, member, GIA, agent or system.
- The API without a knowledge store answers 503 `brain_not_configured`.

## Consequences

- GIA (Fase 1c) and agents get company context through one tenant-scoped, permission-checked call, sized for cost.
- No Terraform change: the item reads use only the organization's equality filter. Versions and conflicts use equality filters that Firestore serves without a composite index.
- The organization-creation route gains an optional after-create hook. The profile route feeds the brain after saving.
- The one AI Gateway is now built once in `createApp` and shared by conversation assist and Company Brain.

## Not decided here (pending)

- File uploads (PDF, images) need a storage bucket (Terraform); today documents are plain text.
- CRM, ecommerce, accounting and marketing adapters: the Integration Engine has only WhatsApp.
- An event bus: the audit trail stays the record. `knowledge.*` events are not in the Home's activity allowlist yet.
- Plan-based limits (items, documents, extraction volume) wait on plan allotments (D-12). Today the limits are fixed technical bounds.
- A web screen for Company Brain. GIA's conversational onboarding is in her chat (ADR-0052).
- Embeddings or vector search: not needed at this volume.
- Roles other than owner (D-27).
