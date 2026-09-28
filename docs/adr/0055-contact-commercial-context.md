# ADR-0055: A contact's commercial context (C3)

- Status: Proposed
- Date: 2026-09-28
- Builds on: ADR-0053 (customers and leads), ADR-0054 (opportunities and pipeline), ADR-0035 (Conversations Center), ADR-0020/0049 (audit and activity), and Geovet's C3 brief of 2026-09-28
- Does not change: storage, collections, the audit catalogue, permissions, the Integration Engine, the AI Gateway, GIA, credits, MelonMotor, or Terraform.

## Context

C1 gave contacts a commercial stage. C2 gave them opportunities in a pipeline.

A person opening a contact from Comercial, or a conversation in the inbox, still had to go to three places to learn the basics:

- who the contact is;
- how they arrived;
- their conversations and opportunities;
- the stage, value and responsible person;
- the next action;
- what happened.

Geovet's rules:

- Reuse and extend.
- No second CRM, inbox, contact base, history or activity system.
- Keep it simple for small Peruvian businesses.
- GIA may not change opportunities in C3.

## Decision

### 1. One read, where each part already lives

`GET /v1/organizations/:id/customers/:contactId`, C1's contact card, now also returns:

- **`conversations`:** the contact's conversations from the conversations repository, newest first, at most 20.
- **`opportunities`:** the contact's opportunities from C2's service, with their current stage (id, kind, name), most recently changed first, at most 20.
- **`history`:** the contact's own audit events (`contact.*`) plus those of its most recent 10 opportunities (at most 20 each), merged newest first, at most 40.
  - It is read through C2's `AuditHistoryReader`, so it uses equality filters only.
  - Each entry says which opportunity it is about, or `null` for the contact.

Each part is shown only to a role that may read it:

- conversations need `conversation.read`;
- opportunities and their history need `opportunity.read`.

A part the reader may not see is `null`, not an empty list, so the screen can say "your role cannot see this" instead of "none".

Views never include another member's id (`you`, `member` or none), as in C1 and C2. Nothing is copied or stored: the card is assembled on each read.

The opportunity service is now built once in `createApp` and shared by both the customer and the opportunity routes.

### 2. Web

- **The Comercial card** (C1's `CustomerCard`) shows the contact's facts and stage, then:
  - its conversations, each linking to that conversation in the inbox;
  - its opportunities, each with stage, value, responsible person, probability, expected close, next action (marked when overdue) and the loss reason;
  - notes;
  - the merged history.
- **The Conversations Center** shows a "Commercial context" panel beside the open conversation:
  - the contact's stage, how they arrived, the responsible person, the next action and the open opportunities;
  - a link to the full card.
  - Only a role that reads contacts sees the panel, and nothing is changed from there.
- **Deep links** avoid a router library:
  - `/conversations?c=<id>` opens a conversation;
  - `/office/sales?contact=<id>` opens a contact's card.
  - They are built in `shell/routes.ts` (`paths.conversation`, `paths.customer`), read by `openedWith()`, and checked against the id pattern.
  - C2's opportunity card now links to the exact conversation too.

### 3. GIA, credits and infrastructure

- **GIA:** C3 adds nothing GIA can call or change. GIA's reads remain as C2 left them.
- **Credits:** no AI is used, so no credits are consumed.
- **Infrastructure:** no new query shapes, indexes, Terraform, apply or deploy.

## Pending

- Paging a contact's conversations, opportunities or history beyond the bounds above.
- Opening a new opportunity directly from a contact's card or a conversation. Today this is done in the Opportunities section.
- GIA summarising a contact's context and suggesting a next action (C4, read-only).
