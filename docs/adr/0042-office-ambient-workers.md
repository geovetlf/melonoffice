# ADR-0042: Ambient figures in the office

- Status: Proposed (pending Geovet's review)
- Date: 2026-09-28
- Amends:
  - [ADR-0040](0040-home-virtual-office.md) (people are drawn only for real agents)
  - [ADR-0041](0041-office-workstations-and-agent-presence.md) (a workstation is taken or free)
- Does not change: any API, permission, the runtime, the conversations logic, AI providers, credits, billing or the infrastructure. There is no backend for it.

## Context

A new organization has no agents yet. Under ADR-0040 and ADR-0041 its Home and department offices showed only empty desks, and the office looked abandoned.

Geovet asked for the offices to look alive in that case, with seated figures at some desks. Those figures must never pass for agents: no name, no profile, no state, no activity.

## Decision

1. A workstation shows one of three things, in this order:
   - its real agent, when one sits there;
   - else an ambient figure, when the layout says that desk shows one;
   - else a free desk.
2. The model says which, in `WorkstationOccupant`:
   - `{ kind: 'agent', agentId }` is a real agent (a specialist record);
   - `{ kind: 'ambient', visualId }` is a decorative figure.
     A desk never shows both. A real agent takes the desk, and the figure is gone.
3. The ambient desks come from the same provisional `OfficeLayout` that sets the seat count (`layoutOf` in `apps/web/src/office/workstations.ts`). The Home and the department offices both read it, so they always agree. At least one desk of each office stays visibly free.
4. An ambient figure is decoration only:
   - it is drawn inside the room's `aria-hidden` SVG;
   - it has no link, name, plate, state, presence dot or activity;
   - it never counts as an occupied seat, and the agent counts stay real.
5. A desk with an ambient figure is still a free workstation. It keeps its "Available workstation" control and the same (future) options. Its hover card notes "Ambient figure, not an agent".
6. The figure is a seated, stylized person in SVG: head, torso, arms and hands on the desk, and the chair. Its only motion is a barely visible breathing, applied only under `prefers-reduced-motion: no-preference`. There is no typing, mouse, messages or tasks.

## Consequences

- Empty offices look inhabited without inventing agents, work or activity.
- The rule "people are drawn only for real agents" from ADR-0040 now reads: "people with a name, state and profile are drawn only for real agents".
- When layouts and seat assignments are stored, the stored layout carries the ambient desks in place of `layoutOf`. The screens do not change.
