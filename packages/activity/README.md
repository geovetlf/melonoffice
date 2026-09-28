# @melonoffice/activity

What really happened in an organization's office, read from the audit trail ([ADR-0049](../../docs/adr/0049-office-activity.md)). There is no second record: the activity view is a filtered, read-only window on `auditLogs`. Server only, with no HTTP.

- `catalogue.ts`: the actions a person sees as activity (at most 30), and how each event is shown: who (you, a member, GIA, an agent, a contact, the system) and what it links to. No personal data or content is added.
- `period.ts`: today, this week (from Monday) and this month, in the business's time zone.
- `service.ts`: `createActivityService()`: `list(tenant, { period, timeZone })` with `activity.read`.
