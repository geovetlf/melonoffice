# ADR-0008: Department → Specialist/Agent → Role → Skills → Tools

- Status: Accepted (D-28, closed by Geovet on 2026-09-26)
- Date: 2026-09-26

## Decision

| Entity             | Responsibility                                                                  |
| ------------------ | ------------------------------------------------------------------------------- |
| Department         | A functional area of a company; groups specialists, tasks, documents, activity. |
| Specialist / Agent | A working instance with its own identity inside a department.                   |
| Role               | The specialist's one main specialty (ADR-0009).                                 |
| Skills             | Internal capabilities the specialist can use.                                   |
| Tools              | Typed functions or integrations a skill may call.                               |

- **SPECIALIST ≠ DEPARTMENT** and **SPECIALIST ≠ SKILL**. A specialist is a working instance with one main role. Examples: María → Meta Ads Specialist; Carlos → TikTok Publisher; Ana → Graphic Designer; Pedro → Market Research Specialist.
- "One Marketing agent with several functions drawn inside" is **not** the product or visual model.
- A specialist has **identity** (permanent id, editable name and avatar), **current configuration** (department, main role, enabled skills, state) and **history** (append-only events). Every task, result and history record keeps a snapshot of role, relevant skills, specialist and department at that moment; later changes never reinterpret earlier records.
- Identity, tasks, conversations, memory, results and traceability survive role changes, deactivation, reactivation, logical deletion and new skills.
- Specialists are records, not running AI instances; AI runs only when there is work.

The types stating this model live in `packages/domain`. Departments, specialists, their versions and eligibility are stored and read as of [ADR-0025](0025-departments-and-specialists.md).
