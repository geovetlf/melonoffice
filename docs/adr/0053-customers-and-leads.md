# ADR-0053: Customers and leads (C1)

- Status: Proposed
- Date: 2026-09-28
- Builds on: ADR-0033/0035 (contacts and the Conversations Center), ADR-0044 (Integration Engine), ADR-0049 (activity), ADR-0051 (Company Brain), ADR-0052 (GIA's chat) and Geovet's C1 decisions of 2026-09-28
- Does not change: channel ingress, sending, the Integration Engine, the AI Gateway, credits, tenancy or Terraform.

## Context

Comercial's first capability is knowing who the business's leads and customers are. MelonOffice is not a CRM: C1 brings no pipeline, opportunities, campaigns or automations (C2 onwards). The rule is to reuse before creating, so C1 extends the `Contact` the conversations already use instead of adding a second contact system.

Geovet's decisions:

1. Stages are `lead`, `customer` and `inactive`. "Lost" belongs to C2.
2. Consent never blocks creating or managing a contact. It is required before a bulk or automated send.
3. One activity query keeps its limit of 30 actions; more actions means more queries, never a higher limit.
4. The responsible person is the organization's owner or an existing member. There is no commercial role system.
5. No public lead-capture form in C1.

## Decision

### 1. The model

`Contact` (`packages/domain/src/conversation.ts`) gains two optional fields:

- `commercial`: `{ stage, ownerId?, source: { kind, reference? }, consent: { messaging, at?, recordedBy? }, nextAction?: { text, dueOn }, stageChangedAt }`.
  - `source.kind` is `channel`, `manual`, `import` or `campaign`.
  - `consent.messaging` is `granted`, `denied` or `unknown`.
  - `nextAction.text` is at most 200 characters and `dueOn` is a date (`YYYY-MM-DD`) in the business's time zone.
- `revision`: absent means 0. Every commercial write expects the current revision and stores the next one, so two people editing the same contact cannot overwrite each other (409).

A contact without `commercial` is a conversation contact only, as before. Inbound messages keep creating contacts exactly as they did, and never touch `commercial`: a WhatsApp contact marked as a lead stays that lead when it writes again.

Notes are a separate append-only collection, `contactNotes/{id}` (`organizationId`, `contactId`, `text` ≤ 2000, `createdBy`, `createdAt`), so the contact document does not grow.

### 2. The service

`createCustomerService()` in `packages/conversations/src/customers.ts`, on the conversations repository (memory and Firestore):

- `list(stage?, owner?)` and `get` (contact + latest 20 notes) need `contact.read`.
- `create`, `update` and `addNote` need the new permission `contact.manage` (owner only today) and a person acting directly: GIA and the runtime get `requires_user`.
- **Creating** needs a name and a phone or an email. The phone is normalised to E.164 (spaces, dots, dashes, parentheses and a `00` prefix are accepted) and the email to lower case.
- **Duplicates** are exact, never by name: the same phone or email as another non-archived contact of the same organization is refused with `duplicate_contact` and the existing contact's id, so the screen can open it. Another organization's contacts are never compared.
- **Updating** changes details, stage, responsible person, consent and next action. The source is never changed by a request; marking a contact that came from a channel records `channel`.
- **The responsible person** must be an active member of the organization (`owner_not_member` otherwise).
- `consentAllows(contact, 'reply' | 'bulk' | 'automated')` is the one check future senders must call: replying is allowed unless consent was denied; bulk and automated sends need `granted`.

### 3. Audit

New category `contact`, target type `contact`, recorded in the same transaction as the change:

- `contact.created` (from none to the stage, reason `source_<kind>`)
- `contact.updated` (reason `details`, `next_action` or `next_action_cleared`)
- `contact.stage_changed` (from and to)
- `contact.owner_changed` (reason `assigned` or `cleared`)
- `contact.consent_changed` (from and to)
- `contact.note_added`

No event carries a name, phone, email, note text or next-action text.

### 4. Activity

The activity catalogue is now a list of groups, each within the 30-action limit of one query (decision 3). The office's actions stay one group; the second holds `contact.created`, `contact.stage_changed` and `contact.owner_changed`. The activity service runs one query per group in parallel, keeps only the organization's events, merges them newest first and returns one page as before. The Firestore index of ADR-0049 covers every group (same fields).

### 5. Company Brain and GIA

`customerKnowledge()` gives Company Brain three `calculated` facts in the `customers` domain: `leads_count`, `customers_count` and `inactive_contacts_count`. They are refreshed by the Brain's sync and, best effort, after each create or update. Company Brain never holds a person's data. GIA reads these totals through the Brain like any other fact and points to the Comercial office (her existing `department` screen); she never writes a contact.

### 6. API

Under `/v1/organizations/:id/customers`:

| Route                    | Permission       |                                                                                       |
| ------------------------ | ---------------- | ------------------------------------------------------------------------------------- |
| `GET ?stage=&owner=me`   | `contact.read`   | Up to 200 contacts, newest change first, with the counts per stage                    |
| `GET /:contactId`        | `contact.read`   | The contact and its latest notes                                                      |
| `POST`                   | `contact.manage` | Register a contact (409 with `contactId` on a duplicate)                              |
| `PATCH /:contactId`      | `contact.manage` | `{ revision, stage?, ownerId?, consent?, nextAction?, displayName?, phone?, email? }` |
| `POST /:contactId/notes` | `contact.manage` | `{ text }`                                                                            |

A view never includes another member's id: the responsible person and a note's author are `you`, `member` or none. Unknown fields are refused (400).

### 7. Web

A "Customers and leads" section in the Comercial office (`/office/sales`), for a role with `contact.read`: tabs Leads, Customers and Inactive with their counts; each contact's next action, marked when overdue in the business's time zone; the contact card (stage, "I'll handle it", consent, next action, notes); and the form to register a contact, which offers to open the existing one on a duplicate. Without data it says there are no customers yet; it never shows examples. Editing needs `contact.manage`.

### 8. Infrastructure

None. Every new query uses equality filters only (`organizationId`, `phone`, `email`, `contactId`), which Firestore serves without a composite index; sorting happens in memory within the 200-item bound. No Terraform, IAM or deploy change.

## Pending

- A contact registered by hand whose phone later writes on WhatsApp becomes a second contact, because ingress links only by channel identity. Linking them is a later, explicit step.
- Nothing sends bulk or automated messages yet, so `consentAllows` has no caller; C5 and campaigns must use it.
- There is no member directory in the web yet, so the screen assigns only "me"; the API already accepts any active member.
- No public lead-capture form (decision 5).
- The list shows the latest 200 per stage; paging comes when an organization needs it.
