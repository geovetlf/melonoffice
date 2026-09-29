# ADR-0061: Comercial's lists, one page at a time

- Status: Proposed
- Date: 2026-09-29
- Builds on:
  - ADR-0053 (contacts and leads), ADR-0054 (opportunities and pipeline) and ADR-0058 (follow-ups): the three lists;
  - ADR-0055 (contact context), ADR-0057 (GIA's commercial insights) and ADR-0051 (Company Brain): the readers of those lists;
  - ADR-0049: the only composite Firestore index so far, and how it is managed in Terraform.
- Does not change:
  - the data model, any collection or document;
  - permissions: `contact.read`, `opportunity.read` and `follow_up.read` stay exactly as they were;
  - GIA, Company Brain, the AI Gateway, credits, audit, forecasting, reports or the Integration Engine.

## Context

Comercial's lists read an organization's whole collection and cut it in memory: at most 200 contacts, 500 opportunities and 500 follow-ups. Past that, a business could not see the rest.

Each list's counts and pipeline totals, and the contact names on each row, also came from reading every record. So a growing business paid for every record on every visit, in reads, memory, latency and transfer.

## Decision

### 1. Cursor pages, read in Firestore

Each list is read one page at a time: a query in the list's order, started after the previous page's last record, one record more than the page to know whether more follow.

| List          | Order                        | Filters kept by the cursor                      |
| ------------- | ---------------------------- | ----------------------------------------------- |
| Contacts      | newest change first, then id | stage, responsible                              |
| Opportunities | newest change first, then id | status, stage, responsible, contact             |
| Follow-ups    | soonest first, then id       | statuses (open), contact, opportunity, assignee |

The document id breaks ties between equal times, so a record never moves between pages because of a tie. A record that changes while someone pages leaves its old position. It appears at most once.

The pure `pageOf` (`packages/conversations/src/pages.ts`) gives the same pages over records in memory. The in-memory repository uses it, and so does Firestore while an index is missing (point 4).

### 2. The API

- `GET …/customers`, `…/opportunities` and `…/follow-ups` take `?cursor=` and `?limit=`.
- They answer `items`, `hasMore` and `nextCursor` (null on the last page), besides what they already answered.
- `limit` defaults to 50. The maxima are the old caps: 200 contacts, 500 opportunities, 500 follow-ups. A limit out of range is `invalid_request` `limit`.

### 3. The cursor is a position, never a permission

A cursor holds:

- the last record's time and id;
- the organization, list and filter it was made for (the filter as a fingerprint).

It is refused (`invalid_request` `cursor`) unless the organization, list and filter all match. Every page is still read in the organization of the person asking, with that person's permissions.

A forged cursor can at most move a position inside the person's own organization. Nothing is signed because nothing in a cursor grants anything.

### 4. Firestore indexes (Terraform, not applied)

The queries need 13 composite indexes. They are `google_firestore_index.commercial` in `infra/modules/environment`, DEV only like the rest of Firestore:

- 2 for contacts;
- 5 for opportunity pages and 1 for the pipeline sums;
- 5 for follow-ups.

Until they are applied, Firestore refuses a page query with `FAILED_PRECONDITION`. That one error, and only that one, makes the repository cut the same page from the whole collection. The list works exactly as before, slower, and the API logs `firestore.index_missing` with the query's name. So the code can be deployed before the indexes are applied, and nothing breaks in between.

A combination of filters no index serves, for example opportunities by status and responsible together, takes the same path. The screens never ask for one.

### 5. Counts and totals are counted, not read

- **Contact stage counts:** three Firestore `count()` queries.
- **Pipeline totals:** per stage, one `count()` and one `sum(value.amountMinor)` in the business's currency.
  - Open, won and lost follow from each stage's kind: an opportunity's status follows its stage, and a stage in use is never removed.
  - The figures equal the old `pipelineSummary`.
- **Follow-up counts:** these depend on each one's own time zone, so they read only the open follow-ups the filter keeps, never the closed history.
- **Contact names on a page:** read by id, for that page's rows only.

Company Brain's contact counts and pipeline summary come from the same counts.

### 6. Readers that are not screens

- **GIA's commercial insights (C4):** these ask for one page as large as the old cap, so GIA reads exactly what it read before, and no more. Their counts and totals are now counted.
- **The contact card (C3):** it reads that contact's opportunities with the contact filter, as before.
- **Company Brain:** it receives the same aggregates as before, never lists.

### 7. The screens

Contacts, opportunities and follow-ups show the first page and a **Load more** button while more follow. This is MelonOffice's list pattern, and it suits the pipeline board and phones. The button:

- asks the API with its cursor;
- never shows a record twice;
- says so when a page fails, keeping what is shown.

Counts shown beside a tab, a board column or a follow-up group are the totals of all records, not of the pages loaded.

## Consequences

- A business of any size sees all its contacts, opportunities and follow-ups. Each visit reads a page and a few aggregates.
- DEV needs a Terraform plan and apply for the 13 indexes, when Geovet decides. Until then the lists behave as before and the API logs each fallback.
- The new-opportunity form still offers up to 200 leads and 200 customers. A contact search will replace it when that is not enough.
- Forecast sources and GIA's insights still read whole collections or one large page. Aggregates for them are later work.

## Alternatives rejected

- **Offset pages:** Firestore charges for every skipped document, and records shift between pages as they change.
- **A signed cursor:** it adds a secret for no gain, because a cursor grants nothing (point 3).
- **Infinite scroll:** it is harder to use with a keyboard and a screen reader, and it would read pages nobody asked for.
- **Stored counters:** a second writer for every change, where Firestore's count and sum already answer.
