# ADR-0057: GIA's commercial intelligence (C4)

- Status: Proposed
- Date: 2026-09-28
- Builds on:
  - ADR-0052 (GIA's chat) and ADR-0051 (Company Brain);
  - ADR-0053 (customers and leads) and ADR-0054 (opportunities and pipeline);
  - ADR-0055 (a contact's commercial context);
  - Geovet's C4 brief of 2026-09-28.
- Does not change:
  - storage, collections or Terraform;
  - permissions or roles;
  - the audit catalogue;
  - the AI Gateway, its policy or credits;
  - the Integration Engine, MelonMotor or Company Brain's service.

## Context

GIA already answers from Company Brain and today's activity, through the one AI Gateway, for 1 credit a message (ADR-0052).

C1 to C3 gave the business its contacts, opportunities, pipeline and each contact's context. GIA could not read any of that, so she could not say how sales are going or what to attend to today.

Geovet's rules:

- Reuse; build no second AI engine, CRM, router or memory.
- GIA reads, analyses, explains and suggests. She never changes a contact, lead, opportunity, stage, owner or price, and never sends a message or calls.
- Prefer, in this order, structured data, then fixed rules, then AI, with one model call.
- Invent no data, score or forecast. When there is not enough data, say so.
- Respect permissions without leaking what is hidden.
- Use the business's time zone. Never mix currencies.

## Decision

### 1. Insights are calculated, not generated

`packages/conversations/src/insights.ts` computes the commercial picture by fixed rules. It is a pure function, `commercialInsights`, plus `createCommercialInsights`, which reads its input through the existing services, as the person asking:

| Part                                 | Read through                                | Permission          |
| ------------------------------------ | ------------------------------------------- | ------------------- |
| Contacts: leads, customers, inactive | C1 `CustomerService.list`                   | `contact.read`      |
| Opportunities and pipeline           | C2 `OpportunityService.list` and `pipeline` | `opportunity.read`  |
| Conversations                        | the conversation repository, as C3 does     | `conversation.read` |

- Each service still checks the tenant, the organization's status and its permission.
- The insight service drops any record from another organization a second time.
- A part the person may not read is `null`, and nothing from it reaches another part. For example, without `contact.read`, an opportunity never names its contact, and no count or date is taken from contacts.
- No other data is read: no Firestore access outside those services, and no audit reads.

**What it counts:**

- leads, customers and inactive contacts;
- open, won and lost opportunities;
- pipeline value;
- won value: all time, this month and this week;
- count and value by stage;
- closing soon;
- expected close date passed;
- overdue next action;
- quiet opportunities;
- leads without a next action;
- inactive customers;
- conversations waiting for an answer;
- new contacts and opportunities today and this week;
- lost reasons.

**Rules, fixed in `INSIGHT_RULES` and told to the model:**

| Rule              | Definition                                                                    |
| ----------------- | ----------------------------------------------------------------------------- |
| Closing soon      | Open, with the expected close date within 7 days.                             |
| Quiet             | Open, with no change for 14 days or more.                                     |
| Inactive customer | A customer with no change, message or opportunity change for 60 days or more. |
| Active lead       | A lead with activity within 3 days.                                           |
| Highest values    | The top 3 open opportunities per currency, 6 in all.                          |

**What to attend to.** Every record gets its reasons. The records are ordered by the most pressing reason first:

1. overdue next action;
2. next action due today;
3. expected close date passed;
4. closing soon;
5. conversation waiting for an answer;
6. high value with no recent activity;
7. lead with no follow-up;
8. inactive customer.

Within one reason, the longest overdue or quiet comes first, and the nearest close date comes first. At most 10 records are listed. Each reason carries its date and days, so GIA can say why. There is no score.

**Dates.** "Today", "this week" (from Monday) and "this month" are in the business profile's time zone, `America/Lima` when there is none.

**Currencies.** Every amount stays in its own currency: each total, stage value and highest-value list is per currency. Nothing is converted.

### 2. GIA reads them in her one call

- `createGia` takes an optional `commercial` port. The API gives it the insight service, built once with the C1/C2 services, which Comercial's routes now share.
- For every message, GIA reads the insights beside Company Brain, gaps and activity. The insights go into her one AI Gateway call as `<commercial_context>`, as data:
  - the figures already formatted in the currency (`S/ 12,000.00`);
  - the reasons written out ("next action was due 2026-09-25, 3 days late");
  - the records named by a short reference (`o_a`, `c_b`, `v_a`), never by their ids.
- There is still one model call and 1 credit.
- New rules in her instructions (`commercialRules`):
  - answer commercial questions only from `<commercial_context>`;
  - never recalculate, estimate, score or forecast;
  - never add, compare or convert currencies;
  - if a part says the person may not read it, answer exactly "No tienes permisos para consultar esa información." and give nothing of it;
  - with no records, say "Todavía no tengo suficientes datos para responder eso.";
  - for "what should I attend today", list the attention items in order, with their reasons and amounts;
  - adapt her words to the business type from Company Brain, without changing a figure;
  - never create, change, move, assign, win, lose, close or price anything, and never send or call; she suggests what the person can do, in `proposedAction`;
  - ask at most one question, and only when neither context answers it.
- If the insights cannot be read, GIA still answers and tells the model so. The answer's `context.commercial` is then false.

### 3. Links to what she named

- The answer's schema adds `links`: up to 4 of the given references, from a closed list. The list is capped at the gateway's 50 codes. References contain only letters, as the gateway's codes require.
- The service keeps only references it gave. Anything else, or a repeat, is dropped.
- The API answer carries `links`, each one of:
  - `{kind: 'opportunity', id, label}`
  - `{kind: 'contact', id, label}`
  - `{kind: 'conversation', id, label}`
  - `{kind: 'leads' | 'customers' | 'pipeline'}`
- The existing chat shows them under "Where to see it", on the existing Comercial screens:
  - an opportunity: `/office/sales?opportunity=`, which opens its card;
  - a contact: `/office/sales?contact=` (C3);
  - a conversation: `/conversations?c=` (C3);
  - leads or customers: `/office/sales?stage=lead|customer`, which opens that tab;
  - the pipeline: `/office/sales?view=pipeline`, which scrolls to it.
- There is no new chat, page or navigation.

### 4. Audit and credits

- The existing `gia.message_answered` event records the person, the organization, the result, the model, the credit reference, and on failure the error code.
- A successful answer that read the commercial insights has `reason: 'commercial_context'`: the source used, as a code.
- The event never holds the question, the answer, a figure or a name.
- The AI Gateway audits its own call and charges the credits as before. A failed call charges nothing.

## What GIA does not do

- She modifies nothing. The insight service has no write path, and its tests check that reading changes no record and writes no audit event.
- She sends, calls, creates tasks and assigns nothing.
- She stores nothing new. The chat is still not stored.
- Company Brain is used only as the business's context. No CRM detail is copied into it.

## Consequences

- One message reads the organization's contacts, opportunities and conversations, up to the existing list limits (200 contacts, 500 opportunities). This happens even for a question that is not commercial, because deciding what is commercial would need a second model call or a guess. Counts come from the services' totals; lists over the limit are marked as partial.
- The model still writes the sentence. The figures, dates, reasons and order it may use are calculated, and the rules tell it to use them exactly. A model can still phrase them badly; the answer stays marked as generated by AI.
- The Firestore reads are the same ones Comercial's screens make.

## Pending

- "Hot" leads have no score (none is invented). GIA lists active leads, meaning recent activity, and says why.
- Customers' purchase history outside opportunities does not exist yet.
- A per-owner view ("my opportunities") is not a separate rule. The records say `owner you | member | none`, so GIA can filter by it.
- Stage names of templates reach the model as ids (`quote`); GIA says them in words. A server-side catalogue of stage names is not wired to the API.
