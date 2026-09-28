# @melonoffice/brain

Company Brain ([ADR-0051](../../docs/adr/0051-company-brain.md)): what each organization knows about itself, as items of knowledge with provenance, verification, status, versions and conflicts. It is MelonMotor's `company` context (ADR-0029). It is separate from a user's own profile and from conversation or execution memory. Server only; the API exposes it under `/v1/organizations/:id/brain`.

- `catalogue.ts`: the domains, their sensitivity and criticality, what each department's agents may read, and what GIA learns first.
- `knowledge.ts`: the checks every input passes, whoever sends it, and deterministic item ids, so two sources stating the same fact meet on one item.
- `merge.ts`: how a new fact meets the current one: create, confirm, update, or a conflict. It is pure and never calls a model.
- `service.ts`: `createCompanyBrain`. It handles propose and ingest, confirm, invalidate, archive, conflicts, selective context retrieval, gaps, GIA capture and documents. Every call is tenant-scoped and checked by RBAC, and every change is audited in the same transaction.
- `extractor.ts`: extraction through the existing AI Gateway (`assist`, subject `company_knowledge`). It is the only model use.
- `sources.ts`: the business profile, the organization's name, MelonOffice's own records, Integration Engine connections, and agent or analysis results.
