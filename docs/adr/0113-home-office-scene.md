# ADR-0113: The Home is one office scene

- Status: Accepted
- Date: 2026-10-01
- Builds on: [ADR-0047](0047-six-initial-departments.md), [ADR-0109](0109-home-rebuilt-on-the-toolkit.md), [ADR-0111](0111-accessibility-pass.md), [ADR-0112](0112-gia-a-person-in-the-office.md)
- Replaces, on the Home: the 3×3 building of ADR-0109 and the walkable building of ADR-0112 §3 (`OfficeBuilding`, `officeWalk.ts` and `GiaInOffice.tsx` stay in the code, unused by the Home).

## Context

The Home drew the office as a building of separate rooms. The owner chose one open office instead: a medium, glass, futuristic office seen from the front. GIA's desk is in the centre, six desks are around it and a glass wall is behind. The office is the page's interface, and nothing in it may say what the records do not.

## Decision

1. **One scene in layers** (`office/scene/OfficeStage.tsx`). Every place comes from one file, `officeScene.ts`, as fractions of the picture. A new render changes only that file and the art.
   - **The office, empty** (`art/office-empty.webp`). It is the render with its people removed by inpainting, and without the top and bottom bars the render had drawn.
   - **The people**, each cut from the render (`art/people/*.webp`). A desk shows its person only when its department has a real agent, active or paused; that person stands for the department's first agent by state. No one is drawn for a department without agents.
   - **GIA**:
     - she sits at her desk;
     - while a task she prepared is under way with an agent (`gia/presence.ts`), she stands at that agent's desk instead;
     - there is no walk: she is simply there.
   - **The glass wall**, with the office's real figures where the render had made-up ones. MelonMotor is its right panel and opens the existing MelonMotor panel.
   - **The name plates**, drawn from the real departments over the render's.
   - **The controls**:
     - each desk is a link to its department's office (`/office/<slug>`), the same route as the menu;
     - GIA's desk links to `/gia`;
     - each agent drawn is a button that opens the existing agent card.
   - **The places GIA will walk** (`GIA_ROUTES`), from her chair to each desk over open floor.
2. **Seven desks**: GIA and the six functions of the catalogue (sales, marketing, operations, research, finance, leadership). The render's "Diseño" desk is research, because Design & Video was retired into Marketing (ADR-0047). Its "Dirección" desk is the board.
3. **Zoom and pan** (`useStageZoom.ts`), with no library.
   - Input: the wheel (where the Home fits the window, or with Ctrl), a pinch, a drag once zoomed, and three buttons. Range 1× to 3×.
   - A drag never counts as a click.
   - A desk the keyboard reaches is brought into view.
   - Nothing glides, so reduced motion has nothing to stop.
4. **The menu**. On the Home, the sidebar is a floating glass panel opened from the burger at the top left; it is the same component, links and permissions. Escape, touching outside and the burger close it, and focus goes in and back.
5. **Motion**: only the MelonOffice mark's light breathes (`stage-logo-breath`, every 6 s), and it stops with reduced motion.

## Consequences

- The Home's people and figures are the records'.
- Only 1080 px of render exist today, so zoom past 2× shows pixels. A 3840 × 2160 render, plus a tablet and a phone framing (`SCENE_ART`), replace the art and the numbers in `officeScene.ts` without touching the interaction.
- The phone crops the office to 16 : 10 around GIA. Every desk stays in view and at least 44 px to touch, and plates keep only their names.
- **Left for later:**
  - GIA at her desk is the render's figure; the official GIA needs a seated pose.
  - A department with several agents shows one.
  - GIA's walk needs walk-cycle pictures, and a task's origin from the API.
