# ADR-0054: Opportunities and pipeline (C2)

- Status: Proposed
- Date: 2026-09-28
- Builds on: ADR-0053 (customers and leads), ADR-0020/0049 (audit and activity), ADR-0048/0051 (business profile and Company Brain), ADR-0052 (GIA) and Geovet's C2 brief of 2026-09-28
- Does not change: channel ingress, sending, the Integration Engine, the AI Gateway, credits, MelonMotor (planning, workflows, runtime), tenancy or Terraform.

## Context

C1 gave contacts a commercial stage (lead, customer, inactive). C2 prepares the rest of the chain:

Lead → Opportunity → Pipeline → configurable stages → value → probability → next action → responsible → expected close → conversations → activities → won or lost.

Geovet's rules:

- Reuse, extend, integrate, test.
- No second CRM or pipeline engine.
- Adapt the pipeline to the kind of business Company Brain knows, and let each company configure its stages.
- "Lost" belongs to the opportunity, never to the contact.
- GIA may later read opportunities and suggest actions, but may not change anything until that phase is authorized.

The audit found no opportunity, pipeline or loss concept anywhere. MelonMotor's planning and workflows run agents' executions, not sales stages, so they are not a fit and are not reused as a sales engine. Everything else C2 needs exists: contacts, the conversations repository and its transactions, business type and currency in Company Brain, permissions, audit, activity and GIA.

## Decision

### 1. Where it lives

- Opportunities and the pipeline live next to C1's contacts, in `packages/conversations`:
  - `pipeline.ts`: templates and stage rules.
  - `opportunities.ts`: the service.
  - The repository port and its memory and Firestore implementations are extended.
- Contact and opportunity are in the same repository so that a change to both is **one transaction**:
  - a new opportunity for an unmarked contact makes it a lead;
  - a won opportunity makes its contact a customer.
- Domain types are in `packages/domain/src/opportunity.ts`.

### 2. Pipeline

- **One per organization in C2:** `pipelines/{orgId}_default`. The model has an id, so several pipelines can come later.
- **Stages:**
  - The open stages come first, in order, from 1 to 12.
  - Then come exactly one `won` and one `lost` stage, which cannot be removed.
  - Each stage has a stable id, a name (a template message key until someone renames it) and a default probability.
  - Stage ids are lowercase letters and underscores, because they are also audit transition codes.
- **Templates by kind of business** (`PIPELINE_TEMPLATES`) are data:
  - restaurant, store, ecommerce;
  - professional services, consulting and agency (the same template);
  - beauty salon, workshop, distributor;
  - `general` for any other kind.
  - The kind is Company Brain's `identity.business_type`, with the business profile's value until Company Brain has it.
- **Stored or proposed:**
  - Until an organization saves its stages or opens its first opportunity, `GET /pipeline` returns the proposal with `stored: false`.
  - Nothing is written until then.
- **Editing** (`pipeline.manage`):
  - A person can rename, add, reorder and remove open stages, change probabilities and rename won or lost.
  - The change is checked against the current revision.
  - A removed stage that an opportunity is still at is refused with `stage_in_use`, checked inside the transaction.

### 3. Opportunity

`opportunities/{id}` holds:

- contact, stage and status (`open`, `won` or `lost`, from the stage's kind);
- title (at most 120 characters);
- an optional value: an integer in minor units plus an ISO currency, defaulting to the business's currency from Company Brain;
- probability (the stage's default unless a person sets it; 100 when won, 0 when lost);
- responsible member, expected close date and next action;
- a loss reason code (`price`, `timing`, `competitor`, `no_response`, `not_a_fit`, `other`), `closedAt`, revision, creator and timestamps.

Rules:

- **Moving:**
  - A move between open stages is a stage change.
  - Moving to `won` closes the opportunity and makes the contact a customer in the same write.
  - Moving to `lost` requires a reason, and the contact keeps its stage.
- **Closed opportunities:** a won or lost opportunity changes only by being reopened to an open stage; anything else is `opportunity_closed`.
- **Revisions:** every write checks the revision; a stale one is `opportunity_concurrency_conflict`.
- **Conversations** are the contact's conversations, read from the repository and never copied or linked by hand. The API shows them only to a reader with `conversation.read`.
- **Activities** are the opportunity's history, read from the audit trail through the new `AuditHistoryReader.history(organizationId, target, limit)`.
  - It uses equality filters only (no composite index).
  - It reads at most 200 events.
  - There is no second log.

### 4. Permissions, GIA and credits

- `opportunity.read`, `opportunity.manage` and `pipeline.manage` are new; today only the owner has them.
- Reads allow the `gia` actor, so GIA can query opportunities in a later phase.
- Every write needs a person acting directly; GIA and the runtime get `requires_user`.
- C2 calls no AI, so it consumes no credits.

### 5. Audit and activity

- **New actions:**
  - `opportunity.created`, `opportunity.updated` (a reason says which field) and `opportunity.stage_changed`;
  - `opportunity.owner_changed`, `opportunity.won`, `opportunity.lost` (with the reason code) and `opportunity.reopened`;
  - `pipeline.created` (with the template) and `pipeline.updated`.
- **New target types:** `opportunity` and `pipeline`.
- **No personal or commercial data:** no event records a title, amount, name, phone or note.
- **Activity:** opened, won and lost join the customer group of the activity view. That group now has 6 actions, well within 30 per query.

### 6. Company Brain

`pipelineKnowledge()` gives `calculated` facts in the `commercial` domain:

- `open_opportunities_count`, `won_opportunities_count` and `lost_opportunities_count`;
- `open_pipeline_value`, as `money` in the business's currency. Amounts in other currencies are counted but not added, because no exchange rate is invented.

The facts are refreshed on Company Brain's sync and, best effort, after each create or update.

### 7. API

All routes are under `/v1/organizations/:id`:

| Route                                                 | Permission           | What it does                                                                                    |
| ----------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /pipeline`                                       | `opportunity.read`   | Stored or proposed stages                                                                       |
| `PUT /pipeline`                                       | `pipeline.manage`    | `{ revision, stages: [{ id?, name?, probability? }] }`                                          |
| `GET /opportunities?status=&stage=&contact=&owner=me` | `opportunity.read`   | Up to 500, with the totals; the contact's name only to a reader of contacts                     |
| `GET /opportunities/:id`                              | `opportunity.read`   | Opportunity, contact summary, stage, the contact's conversations and the history                |
| `POST /opportunities`                                 | `opportunity.manage` | `{ contactId, title, stageId?, value?, probability?, ownerId?, expectedCloseOn?, nextAction? }` |
| `PATCH /opportunities/:id`                            | `opportunity.manage` | `{ revision, … , stageId?, lostReason? }`                                                       |

A view never includes another member's id: the responsible person is `you`, `member` or none.

### 8. Web

An "Opportunities" section in the Comercial office shows:

- the totals;
- tabs for open, won and lost;
- a board with one column per open stage, with its count and value;
- each opportunity's card: move it (a loss asks for a reason), "I'll handle it", value, probability, expected close, next action (marked when overdue), the contact's conversations and its history;
- a form to open an opportunity for a C1 lead or customer, with the amount typed in the business's currency;
- the stage editor.

Without data, the section says so.

### 9. Infrastructure

None:

- Every new query uses equality filters only, and the results are sorted in memory within a bound.
- No Terraform, IAM, apply or deploy.

## Pending

- Several pipelines per organization, and a pipeline per department or product line.
- GIA querying opportunities and suggesting actions (C4). It is allowed to read, but is not wired to them.
- Reminders for next actions and expected closes, which need the scheduler.
- Assigning other members from the screen (the API accepts any active member) and paging beyond 500.
- Exchange rates for values in another currency.
