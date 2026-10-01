# ADR-0110: The secondary pages, on shared page components

- Status: Accepted
- Date: 2026-10-01
- Builds on: [ADR-0106](0106-design-tokens-v1.md), [ADR-0107](0107-instrument-sans.md), [ADR-0108](0108-components.md), [ADR-0109](0109-home-rebuilt-on-the-toolkit.md)
- How a page moves: [MIGRATION.md](../design/phase-5/MIGRATION.md). Screenshots: [phase 5](../design/phase-5/README.md)

## Context

After phase 4 the Home was built from the toolkit, but every other page still looked designed on its own:

- **Page titles:** four ways. Twelve pages borrowed the department office's title class.
- **Lists:** several borrowed the approval card or the documents list.
- **Tables:** two kinds.
- **Period pickers:** four, each drawn by hand.
- **States:** loading, empty and failed lines were `panel__empty`, about 150 of them. Notices had their own tones.
- **Error messages:** seven components repeated the same code-to-message mapping.

## Decision

1. **Page components in packages/ui.** Presentation only, with no data or logic:
   - `PageHeader`: the page's one `h1`, its line, where it sits, facts and actions.
   - `Toolbar`: the filter bar.
   - `PeriodPicker`: on `mo-segmented`, emitting the option as before.
   - `DataTable`: scrolls inside its own box, and takes keyboard focus while it does.
   - `ListItem`: a record on a card.
   - `FormSection`.

   The stylesheet adds the page frame and the page section. It also adds stats, the inline link and the link button, and a file field's button. `StateMessage` now draws its mark in CSS, so a message's text is only its words.

2. **Touch.** Inside a page, chips, segments and small buttons grow to 44 px on screens 48 rem or narrower and on touch screens. The Home keeps its own sizes.
3. **Every secondary page moves onto them.** No text, message id, route, permission, request, value or behaviour changes:
   - Operation: Agents, Approvals, Documents, Reports, AI usage, Command center.
   - Daily work and GIA: Conversations, Automations, Connections, GIA's workplace.
   - Departments and the CRM: offices, an agent's place, customers, opportunities, follow-ups.
   - Knowledge and brand: Memory, Business, Brand, Partners.
   - Platform and the partner console.
   - The public pages: sign-in, sign-up, password reset, invitations, joining, no organization.
4. **One helper for a failed request's message** (`shell/errors.ts`): `errorCode()` and `errorMessage()`, with the same codes and ids as before. Follow-ups and the partner console keep their own mapping, which reads more than the code.
5. **Old classes go** when `grep` finds no reference left: 50 selectors.
6. **Tests keep it so.** `pages.test.ts` fails if a secondary page:
   - shows a state without `StateMessage`;
   - picks a period without `PeriodPicker`;
   - borrows another page's classes;
   - draws its `h1` outside `PageHeader`.

   The Home and what it renders keep their own parts.

## Consequences

- Every secondary page has the same header, sections, records, tables, filters, forms and states.
- No page scrolls sideways at 1440, 1024, 768 or 390. The contact card used to be 456 px wide at 390.
- The Home is pixel-identical.
- Loading-error lines on Automations had no role. They are failures, so they are now announced as alerts, with the same words.
- **Left as they are:**
  - The Home's activity feed keeps its own period picker and empty lines, and the Ctrl+K box keeps its class.
  - Some pages still show nothing while loading, as before: the partner console, CommercialAdmin, and the end of a Google sign-in. Giving them a state would change what they show.
  - The room art of the department offices is unchanged.
