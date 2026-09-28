# ADR-0048: The business profile

- Status: Proposed (B2, pending Geovet's review)
- Date: 2026-09-28
- Builds on: ADR-0018 (tenancy), ADR-0019 (RBAC), ADR-0020 (audit), ADR-0047 (six departments), the Master Functional Map v1 and Geovet's decisions of 2026-09-28 (decision 3)
- Does not change: departments, specialists, executions, conversations, credits, billing, the tool gate, the AI Gateway, GIA or infrastructure.

## Context

MelonOffice is for small business owners, and it has to adapt to the kind of business. Geovet decided on 2026-09-28 what the profile holds:

- **Required:** business name, type of business, country, currency, city and time zone. City and time zone are needed for "today / this week / this month", schedules, attendance, tasks and activity.
- **Optional:** everything else (employees, sales channels, what the business offers, what it needs, notes).

Later phases will use the profile to adapt MelonOffice to the business. B2 only stores it, shows it and uses it to order the departments.

## Decision

### 1. One profile per organization, apart from the organization

- The profile is stored at `businessProfiles/{organizationId}`, one document per organization, read by id. No composite index is needed.
- It is a separate record so that existing organizations, created before B2, can fill it in later. The organization's creation transaction does not change.
- The business name is the organization's name, chosen when it is created. The profile does not repeat it, and B2 does not edit it.

### 2. Fields and checks

The API checks every field. The screen only offers choices.

| Field                        | Required | Check                                                                                                                                  |
| ---------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `businessType`               | yes      | An id in the business type catalogue (section 3).                                                                                      |
| `country`                    | yes      | ISO 3166-1 alpha-2, as Intl names it. Groupings and private-use codes (EU, EZ, UN, QO, XA, XB, ZZ) are refused.                        |
| `currency`                   | yes      | ISO 4217, from `Intl.supportedValuesOf('currency')`.                                                                                   |
| `timeZone`                   | yes      | An IANA time zone Intl accepts (`UTC` included).                                                                                       |
| `city`                       | yes      | At most 100 characters, one line, trimmed, not blank.                                                                                  |
| `employees`                  | no       | One of `1`, `2_5`, `6_10`, `11_50`, `51_plus`.                                                                                         |
| `salesChannels`              | no       | A subset of physical_store, whatsapp, social_media, website, marketplace, delivery_apps, phone, in_person. It is stored in that order. |
| `offering`, `needs`, `notes` | no       | At most 500 characters each, trimmed.                                                                                                  |

- Unknown fields are refused, including `organizationId`, `revision` or any author field. Who and when come from the server.
- An empty or whitespace-only optional field counts as absent.

### 3. The kinds of business

The catalogue is data in `packages/business/src/catalogue.ts`: restaurant, store, ecommerce, professional_services, agency, consulting, beauty_salon, workshop, distributor, other. Each kind has a message key (`business.type.{id}`) and a suggested department order.

| Kind                       | Suggested order                                                     |
| -------------------------- | ------------------------------------------------------------------- |
| restaurant                 | Comercial, Operaciones, Marketing, Finanzas, Consejo, Investigación |
| ecommerce                  | Comercial, Marketing, Operaciones, Finanzas, Investigación, Consejo |
| professional_services      | Comercial, Marketing, Finanzas, Consejo, Investigación, Operaciones |
| every other kind (general) | Comercial, Marketing, Operaciones, Finanzas, Consejo, Investigación |

- Only the Master Functional Map's three examples have their own order. The others use the general order until Geovet decides theirs.
- The order only arranges departments: no department, agent or capability is hidden or removed.

### 4. Who can read and change it

- Reading needs `organization.read`, which any active member has.
- Changing needs the new permission `organization.update`. Only the owner has it, and only when acting directly (`via: 'direct'`).
- GIA, or anyone acting through GIA, can read but never write. A write is refused with `requires_user`, as decision 5 says GIA does not modify data.
- An inactive organization is refused.

### 5. Audit

- Each change records one `organization.profile_updated` event, in the same transaction as the write.
- The event has target `organization`, reference `business_type:{id}` and reason `created` or `updated`.
- The event never records the profile's content: no city, free text or currency.
- Saving the same content again writes nothing and records nothing.

### 6. API and app

- `GET /v1/business-types` needs only a sign-in, and returns the kinds with their message keys.
- `GET /v1/organizations/:organizationId/business-profile` returns `{ profile | null, departmentPriority }`.
- `PUT` on the same path takes the fields of section 2. It returns 400 `{ error: 'invalid_profile', field }` for a refused field, and 403 for no permission or no membership.
- If the API runs without the profile store, the route answers 503 `business_not_configured`.
- In the web app:
  - **Settings → Business** (`/settings/business`) shows the profile. Anyone who can read the organization sees it; only a person with `organization.update` can edit.
  - **First step:** while the profile is missing, a person who can describe the business sees the form instead of the Home. Everyone else goes straight to the Home, and no other page changes.
  - **Pickers:** countries, currencies and time zones come from the browser's own Intl data. The time zone starts as the device's own.
  - **Order:** once the profile exists, the sidebar and the Home's rooms follow its suggested order, with the Board (headquarters) still on top. Before that, nothing moves.

### 7. Not decided here

- The order for the kinds without their own.
- Any change the profile makes beyond the order: that belongs to later phases, one department at a time.
- es-PE, or other regional wording. There are no strings that differ yet, so it waits until one does.

## Consequences

- Existing organizations, MOpruebas included, see the first step on their next visit if their owner opens the Home. They lose nothing.
- New data: one Firestore collection with document-id reads. As for every other collection, only the API reads and writes it, with its own service account; the web never reaches Firestore. No Terraform change.
