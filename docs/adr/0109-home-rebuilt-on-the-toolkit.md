# ADR-0109: The Home, rebuilt on the toolkit

- Status: Accepted
- Date: 2026-09-30
- Amends: [ADR-0096](0096-home-v4-interactive-office.md) (the header, the side panel, the rooms' light and the idle motion)
- Builds on: [ADR-0106](0106-design-tokens-v1.md), [ADR-0107](0107-instrument-sans.md), [ADR-0108](0108-components.md)
- Screenshots: [phase 4](../design/phase-4/README.md)

## Context

Geovet's brief for the Home keeps its concept: the virtual office is the interface. It keeps the 3×3 building of ADR-0096 with its 3D rooms, GIA at the centre and MelonMotor below. It asks for the finish of the approved reference, with these changes:

- a title that says what the office is doing, with a line of real context under it, instead of "date · greeting";
- a side panel with a hierarchy rather than four equal cards;
- motion only where something real happens;
- GIA as the heart of the office, in the expressive melon;
- a sober MelonMotor;
- no decorative blue glows or frosted glass;
- only tokens and the phase 3 components.

## Decision

1. **Header.**
   - The title keeps its rule: "ya está trabajando" while there are active agents, "lista para trabajar" otherwise.
   - Under it is one line from the records: how many active agents, in how many departments. With none, it says so and where to create the first one.
   - The date and greeting are removed.
   - The two status chips stay, as in the reference. They are lighter (hairline, no shadow) and use `StatusDot`: working with a halo, or grey when nobody works; attention as a diamond, or green when nothing waits.
2. **Rooms.**
   - Every capsule rests on the surface rim and the resting shadow, with the extra-large corner.
   - A department lifts on hover or focus with the network's edge and the overlay shadow.
   - The plates are solid glass surfaces with no backdrop blur.
3. **GIA and MelonMotor.**
   - GIA's room and sphere hold the expressive melon's light, so she reads as the office's heart.
   - MelonMotor keeps the network's edge and loses its glow.
4. **Motion that shows nothing real is still.** These no longer run:
   - GIA's pulsing ring and blinking dot;
   - MelonMotor's glow;
   - the ready circuits' breathing;
   - the seated figures' breathing.

   Pulses for real work, working lights and live screens stay. Reduced motion still stops everything.

5. **The office's own light is tokenised.** New colour tokens: `scene-circuit`, `scene-circuit-soft`, `scene-screen` and `scene-screen-deep`. `home.css` has no hard-coded colour left.
6. **Side panel.**
   - `Panel` takes a level. Recent activity leads, with the raised shadow. Today's tasks is the default. Meetings, which has nothing to show without a calendar, is quiet: a dashed outline and no fill.
   - Empty activity adds one line saying what will show up there.
   - Tasks are open circles: an approval in the waiting colour, an overdue follow-up in red.
   - Credits show the balance in tabular figures, and no meter while plans have no allotment.
7. **Layout.**
   - On a computer, the building is centred in the height it has. The spare space frames it evenly, instead of opening a gap above GIA's command box.
   - On a tablet in portrait (30 to 48 rem), the full-width centre rooms and the department rooms are wider, so the Home is about a sixth shorter at 768. The phone layout is unchanged.
8. **Sidebar.** The departments are listed in the order the building reads: Consejo, Comercial, Operaciones, Marketing, Finanzas, Investigación. This is the same function (`inBuildingOrder`) as the rooms' placement. It changes order only: no route, id, department or permission.

## Consequences

- The Home is built from the tokens and components of ADR-0106 to ADR-0108, with no values of its own.
- Its composition, data, states (`workStateOf`), links, permissions, GIA, MelonMotor and the room art are unchanged.
- Rooms with no agents still draw their ambient figures (ADR-0042). The meetings panel still says no calendar is connected, which is the truth, rather than "no upcoming meetings".
