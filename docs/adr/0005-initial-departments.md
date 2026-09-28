# ADR-0005: Seven initial departments as catalogue data

- Status: Superseded by [ADR-0047](0047-six-initial-departments.md) (was Accepted: D-11, closed by Geovet on 2026-09-26)
- Date: 2026-09-26

## Decision

MelonOffice starts with seven departments:

| #   | Official name       | Short visual name | Catalogue id   |
| --- | ------------------- | ----------------- | -------------- |
| 1   | Consejo y Dirección | Dirección         | `leadership`   |
| 2   | Operaciones         | Operaciones       | `operations`   |
| 3   | Comercial y Ventas  | Comercial         | `sales`        |
| 4   | Marketing           | Marketing         | `marketing`    |
| 5   | Diseño y Video      | Diseño            | `design_video` |
| 6   | Investigación       | Investigación     | `research`     |
| 7   | Finanzas            | Finanzas          | `finance`      |

Rules:

- These are **catalogue data**, not code structure. No code may assume that only these seven exist. New department types, company-specific custom departments and activating/deactivating departments must work without model changes.
- **Sales is part of "Comercial y Ventas"**; there is no separate Sales department.
- **GIA is not a department** (nor a specialist, role or skill). It is the central assistant and is placed visually in the Consejo y Dirección area.
- In the Animated Home, the central pod represents Consejo y Dirección and the former Consejo pod represents Finanzas. This mapping is scene data, not code.
- User-visible names are i18n keys; the stable ids are never shown to users.
