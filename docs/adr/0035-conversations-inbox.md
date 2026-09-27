# ADR-0035: The Conversations Center inbox (CV-3)

- Status: Proposed (Phase CV-3, pending Geovet's review)
- Date: 2026-09-27
- Builds on:
  - [ADR-0019](0019-rbac-foundation.md) (permissions)
  - [ADR-0025](0025-departments-and-specialists.md) (departments)
  - [ADR-0029](0029-runtime-guards.md) (the `conversation` context kind)
  - [ADR-0033](0033-conversations-foundation.md) (conversations and the human inbox API)
  - [ADR-0034](0034-human-tool-invocation.md) (a person's reply through the tool gate)
- Scope: CV-3 of the Conversations Center, approved by Geovet on 2026-09-27: a working inbox for daily use. No AI, no automation, no new infrastructure.

## Context

CV-1 already stores conversations, contacts, identities and messages, and has routes to list conversations with filters, read one, read its messages, assign it to a member or a department, move its status and edit its tags. CV-2 lets a person reply through the tool gate.

What a person still could not do from the API:

- find a conversation by who it is with (name, phone, email);
- sort by anything other than the latest activity;
- change the priority, which already existed on every conversation with the value `normal`;
- open a conversation with everything it needs to show at once;
- see the contact beside each conversation in the list.

The web app had no inbox at all.

## Decision

CV-3 extends the CV-1 service and routes. It adds no entity, collection, permission, role, status, audit store or send path.

### 1. Search

- `q` on the conversation list searches the contact's name, email and phone, and the names and addresses of its channel identities.
- Text is compared without case, accents or repeated spaces ("jose perez" finds "José Pérez"). A query made only of digits and phone separators matches phones and WhatsApp ids by their digits ("+52 1 55" finds `5215512345678`).
- A query is 2 to 100 characters with no control characters. Anything else is `invalid_request`, never ignored.
- Search reads contacts, so it needs `contact.read` as well as `conversation.read`.
- **Message text is not searched.** The repository has no text index, and scanning every message of an organization per keystroke would not scale. A real search index is a later decision.
- The search reads only the tenant's own contacts and identities, through a new repository read, `listOrganizationIdentities(organizationId)`, which is a single equality query on `organizationId`, like the other list reads. It needs no composite index.

### 2. Sorting and filters

- `sort` is `last_activity` (the default, as before), `created` or `priority` (urgent, high, normal, low). Every order breaks ties by the latest activity.
- `priority` joins the existing filters: status, channel, assignee, unassigned, department, contact, tag and date.
- "New" is not a status. The web app shows it as open conversations nobody is assigned to. The statuses stay `open`, `pending` and `closed`, with CV-1's transitions.

### 3. Priority

- `POST /v1/organizations/:org/conversations/:id/priority`, with body exactly `{ priority }`.
- It is a person's act, like assign, status and tags: `conversation.manage`, `actor: 'user'` only (GIA and the runtime get `requires_user`), and optimistic revision.
- Setting the same priority again is `invalid_transition` (409), as with status.
- It is audited as the new action `conversation.priority_changed`, with `transition { from, to }`.

### 4. One conversation, whole

- `GET /v1/organizations/:org/conversations/:id/detail?limit=` returns the conversation, its contact, the channel identity it speaks through, and its latest messages, oldest first (200 at most).
- It needs `conversation.read` and `contact.read`.
- It never includes the connection, its secret references, or anything read from them.
- Another organization's conversation is `conversation_not_found`, exactly like a missing one.
- In the service this is `detail()`. Its `ConversationDetail` is the shape the future `conversation` context of ADR-0029 will be read in: it is a read of existing records, not a new memory store.

### 5. The list shows who it is with

- Each listed conversation carries `contact: { id, displayName, phone }` when the reader holds `contact.read`, and `null` otherwise.
- The service's `inbox()` returns the conversations with their contacts. `list()` stays as it was.

### 6. The web inbox

`apps/web/src/conversations/ConversationsCenter.tsx` shows:

- a search box, a sort and the tabs All, New, Open, Pending and Closed;
- the list, with contact, channel, last message, time, status, priority, tags and assignment;
- the open conversation, with contact, history, status, priority, assign to me or unassign, department, tags and the CV-2 reply box.

The web app talks to the API only through `createInboxClient(request, organizationId)`, which calls these routes with the caller's authenticated request function. Replies use CV-2's route. The web app never reaches a provider.

There are no new dependencies. It uses React, the existing i18n (every text in EN and ES) and `@melonoffice/ui`.

It is **not mounted** in the app: the web app has no sign-in yet, so it has no token to call the API with. Mounting it needs a web sign-in, which is a separate decision (see Limitations).

## What stays as it was

- **Permissions.** `conversation.read`, `conversation.manage`, `contact.read`, `department.read` and `conversation.send` (CV-2) cover everything. No permission or role was added (D-27).
- **Actors.** GIA and the runtime can read the inbox (list, search, detail), as CV-1 allowed. They cannot change it.
- **Audit.** Management acts are audited in the existing audit trail (`conversation.assigned`, `status_changed`, `tags_changed`, and now `priority_changed`). Message text is never copied into audit.
- **Sending.** It is only CV-2's route through the tool gate.
- **Execution.** X6a–X6d, the runtime, the worker, jobs, credits and the AI gateway are untouched.
- **Cost.** Nothing in CV-3 calls a model or consumes credits.
- **Tenancy.** The organization always comes from the authenticated tenant. A client-supplied organization id is never trusted: a body with extra fields is a 400, and a path naming another organization is a 403 before any read.

## Alternatives considered

- **A tag catalogue per organization.** Rejected for now. Tags stay short codes on the conversation, as CV-1 decided, and are always scoped by the conversation's organization.
- **A new "new" status.** Rejected: it would duplicate `open` with no assignee.
- **Searching message text by scanning.** Rejected for its cost. It needs an index (a later phase).
- **A members list for assigning to others.** There is no members route yet, and adding one is a tenancy change. The web app offers "assign to me" and unassign. The API still takes any active member's id.

## Limitations

- The web inbox is not mounted until the web app has a sign-in.
- Message text is not searchable.
- The list is read in full per organization and filtered in the service, as in CV-1. This is fine for a small business and needs paging and indexes later.
- The web app assigns only to the person using it or to nobody.

## Future path

- A web sign-in with Identity Platform, then mounting the Conversations Center.
- A members route for assigning to teammates.
- A search index covering message text.
- GIA reading the inbox through its tools once GIA has them. The service already answers GIA's reads.
- Specialists reading `detail()` as `conversation` context through the runtime (ADR-0029, ADR-0031).
