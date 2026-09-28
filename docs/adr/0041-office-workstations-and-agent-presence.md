# ADR-0041: Workstations and agent presence in the office

- Status: Proposed (pending Geovet's review)
- Date: 2026-09-27
- Builds on:
  - [ADR-0006](0006-no-fixed-specialist-quantity.md) (the office draws only agents that exist)
  - [ADR-0025](0025-departments-and-specialists.md) (departments and specialists)
  - [ADR-0040](0040-home-virtual-office.md) (the Home and the department offices)
- Does not change: any API, permission, the runtime, the conversations logic (CV-1 to CV-6A), AI providers, credits, billing or the infrastructure.

## Context

Each room of the office showed a fixed number of desks. The office has to become a structured place:

- Department → Workstations → Agents → Presence → Activity.

It also has to be ready for the day the runtime reports what agents are doing, without pretending that day has come.

There is no backend for workstations, assignments or presence. The specialist API gives each agent its:

- department;
- status;
- name;
- purpose.

No permission covers changing an office.

## Decision

### A model in the web app, read by every screen

`apps/web/src/office/workstations.ts` holds the model:

- **`Workstation`**:
  - `id` (`{departmentId}:seat-{n}`), `departmentId` and `number`;
  - `position` (fractions of the room, with a `row` for depth) and `facing`;
  - `agentId` and `status` (`available` or `occupied`).
- **`AgentPresence`**: `agentId`, `workstationId`, `state`, `activity`, `updatedAt` and `source`.
- **`AgentActivity`**: `kind`, `description`, `taskId`, `projectId`, `startedAt` and `progress`. This is the shape a future runtime report fills.
- **`OfficeLayout`**: `seats`.

These functions derive the model. The Home rooms, the department office and the agent profile all read it through them:

- `layoutOf`
- `arrangeSeats`
- `seatAgents`
- `presenceOf`
- `roomSeats`

No screen computes seats or states on its own.

### Nothing invented

- **Seat counts are provisional examples.** They sit in one table, `PROVISIONAL_SEATS`:
  - Marketing 6;
  - Operaciones 8;
  - Comercial 5;
  - Diseño 6;
  - Investigación 4;
  - Finanzas 4;
  - Consejo y Dirección 4;
  - any other department 4, with a maximum of 12.

  They are not a product decision. The office says so.

- **Seating is not stored.** A department's own agents, except archived ones, take the seats in a stable order (by id). Agents beyond the seat count are listed as "without a workstation", never dropped.
- **State comes from the record only** (`source: 'record'`):
  - active is _Disponible_;
  - paused is _En pausa_;
  - draft or disabled is _Fuera de línea_.

  _Trabajando_ and the other runtime states exist in `AgentState`, but nothing sets them. `activity` is always `null`, and the profile says so: "Sin actividad disponible", "Sin tarea asignada", "Sin actividad registrada" and "Sin proyectos".

- **No motion suggests work.** The people at the desks no longer sway, and their monitors no longer pulse. Only a present agent's monitor is lit. Motion is limited to hover, focus, entering and view transitions.

### Tenant boundary

Specialists come only from the signed-in organization's own route, which is permission-checked.

A workstation seats only specialists whose `departmentId` is that department's id. That id includes the organization, so an agent of another department, or of another organization, can never take a seat. A test covers a foreign agent with a same-type department.

### Interaction

- **Home.** Each room shows its seats taken, for example "2/6". The room's link names its agents and its seats in words.
- **Department office.** The drawn room has one desk per workstation, and each workstation is a real control on its desk. Each one shows its agent's name plate or "Disponible", and a card on hover or focus.
  - **Taken seat:** a link to the agent's profile (`/office/<slug>/agent/<id>`).
  - **Free seat:** a button that opens its options under the room: assign an agent, move the seat or remove it. All three are marked "Próximamente" and do nothing.
- **Phone.** The same list flows as cards under the room.
- **Agent profile.** It shows:
  - avatar, name, role (its purpose, until D-27 names roles) and department;
  - state, seat, activity, task, last activity and projects.

### Not built

The following are not built:

- stored layouts and assignments;
- endpoints to add, remove or move workstations, or to assign agents;
- a runtime presence source;
- CV-6B, X6e, autonomy or any AI call.

Changing workstations will need:

- a stored layout per department;
- an assignment record;
- a permission that does not exist today, for example `department.manage`, which needs Geovet's decision. None is added here.

## Consequences

- When layouts and assignments are stored, they replace `layoutOf` and the ordering in `seatAgents`. The screens do not change.
- When the runtime reports presence, `presenceOf` gains a `runtime` source. The office then shows real _Trabajando_ and activity through the same components.
- Paths keep the catalogue slugs from ADR-0040, for example `/office/sales` and `/office/leadership`.
