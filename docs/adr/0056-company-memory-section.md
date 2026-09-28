# ADR-0056: The company's memory, a section of the sidebar

- Status: Proposed
- Date: 2026-09-28
- Builds on: ADR-0048 (business profile), ADR-0051 (Company Brain), ADR-0052 (GIA chat), and Geovet's "Cambio UX — Company Brain / Memoria de la empresa" of 2026-09-28
- Supersedes: the onboarding step of ADR-0048, which showed the business form in place of the Home while the business was not described.
- Does not change: the API, Company Brain's service, storage, permissions, the audit catalogue, or Terraform. GIA's service is unchanged; only one line of its instructions changes (point 7).

## Context

A new organization's owner saw the business form in place of the Home until they saved it. Geovet wants:

- the Home always to be the first screen;
- the company's information in a permanent sidebar section, "Memoria de la empresa";
- that section to read, complete and correct Company Brain;
- no second memory: what a person types there and what GIA proposes in a chat must be the same knowledge.

Company Brain already had the complete API (ADR-0051) but no screen:

- summary, list by domain, item and versions;
- propose (a person's direct statement is recorded as confirmed);
- confirm, invalidate, archive;
- conflicts and their resolution;
- gaps;
- documents.

GIA already proposes the facts a person states in a chat, and a person confirms them.

## Decision

1. **The Home is never blocked.** The onboarding step is removed.
2. **A sidebar section.** "Memoria de la empresa" (`/memory`) sits in the Office navigation, after GIA and before the rooms.
   - It is shown to a member who may read the business (`organization.read`) or its knowledge (`knowledge.read`).
   - `/settings/business` still opens it, and GIA's link to the business profile now points to it.
3. **What the page holds**, top to bottom:
   - **Add information** (`knowledge.propose`): a fact in one of Company Brain's categories, in the person's words (text or a list), or a document's text. The key comes from what the person names it ("Horario de atención" becomes `horario_de_atencion`).
   - **To review:** open disagreements, with the current and new values and who gave each (keep current or use the new one, `knowledge.manage`); facts proposed and waiting for confirmation, such as GIA's from a chat (confirm or discard); and GIA's onboarding questions not yet answered, each with "Answer".
   - **Company information:** the business profile form (ADR-0048), no longer a separate settings page.
   - **What your office knows:** every fact by category, plus a "History of changes" view that shows the latest 30 changes, newest first, including outdated and archived facts. Each fact has:
     - its value, verification badge, status, source, who recorded it, date and version;
     - Edit (proposes a new value for the same key, which becomes a new version);
     - Confirm, Mark as outdated and Archive;
     - See versions.
4. **One place to change each fact.**
   - Facts that come from the business profile are changed in the profile form, not a second time in the list.
   - Calculated totals (C1 and C2 counts) are read-only.
5. **Everything goes through Company Brain's service**, so origin, verification, versions, conflicts, audit and permissions are its own. The screen only hides buttons a role may not use.
6. **Onboarding without a wall.**
   - What the owner types at sign-up (the organization's name) and in the business profile still feeds Company Brain through the existing hooks.
   - The profile is completed and changed only in the company memory, never shown again on the Home.
   - GIA asks for what is missing, one question at a time.
7. **GIA offers to add what is missing.**
   - GIA's instructions now say that when it asks one of Company Brain's missing-information questions, it sets `screen` to `business_profile` (the company memory).
   - The chat then shows "Add to Company memory".
   - When GIA noted facts from the person's message, the chat links to "Review in Company memory", where a person confirms them.
   - GIA still never writes a confirmed fact: its proposals keep Company Brain's provenance, confirmation, permission and audit rules.
8. **Shared read hook.** `shell/useRead.ts` holds the keyed read hook that the opportunities screen and this page share.

## Pending

- The GIA chat does not confirm a change inside the chat. Its proposals wait in "To review", linked from the chat.
- Editing a fact's subject (a specific product or location) and relations.
- Uploading files as documents. Only pasted text is supported until a bucket exists.
