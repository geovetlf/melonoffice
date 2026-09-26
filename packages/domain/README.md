# @melonoffice/domain

Pure domain types for MelonOffice. No I/O, no framework and no other workspace package may be imported here.

## Model (ADR-0008, decision D-28)

```
Department → Specialist / Agent → Role → Skills → Tools
```

- **Department**: a functional area of a company. Department types come from a catalogue (ADR-0005, D-11); nothing here assumes a fixed list or count, and companies can have their own custom departments.
- **Specialist / Agent**: a working instance with its own identity inside a department. SPECIALIST ≠ DEPARTMENT and SPECIALIST ≠ SKILL.
- **Role**: the specialist's one main specialty (ADR-0009, D-29).
- **Skills**: internal capabilities the specialist can use; never shown as separate specialists.
- **Tools**: typed functions or integrations a skill may use.

A specialist is split into **identity** (permanent id, editable name and avatar), **current configuration** (department, main role, enabled skills, state) and **history** (append-only events, each carrying a snapshot of the context at that moment).

There is no fixed number of specialists anywhere (ADR-0006, D-12a).

## Scope in Phase 1A

Only the types that state this model. Specialist management, catalogues, persistence and validation arrive in later phases.
