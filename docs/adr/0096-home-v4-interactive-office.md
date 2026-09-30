# ADR-0096: Home V4, the interactive office

- Status: Proposed (pending Geovet's review)
- Date: 2026-09-30
- Amends:
  - [ADR-0040](0040-home-virtual-office.md) (how the Home draws the office)
  - [ADR-0041](0041-office-workstations-and-agent-presence.md) (workstations on the Home)
  - [ADR-0042](0042-office-ambient-workers.md) (ambient figures, unchanged in meaning)
- Does not change: any API, permission, route, the runtime, GIA, agents, credits, billing, departments or the infrastructure. There is no backend for it.

## Context

Geovet asked for the Home to be redrawn after a reference image: a warm, light cutaway of an office building, where each department is a room and the office itself is the workspace. Everything the Home already does had to stay: the sidebar (order, "Pronto" labels, plan card), GIA, the agents and their tasks, activity, credits and navigation.

## Decision

1. **Three layers.** The office is drawn in three separate layers:
   - a visual layer of raster rooms (WebP at 1x and 2x, `srcset`, lazy below the first floor), made in `apps/web/scripts/office-art/` and baked by `bake.mjs` (3D since the amendment below). The rooms carry no text or data, so any room art can be swapped at the same slot geometry. The reference image is a style reference only and is not shipped;
   - an interactive layer of HTML controls placed over the rooms in percentages (department links, agent buttons at their desks, GIA, MelonMotor);
   - the UI around it (header, command box, right panel, agent card, MelonMotor panel).
     Accessibility never depends on the image: every hotspot is a real link or button with its own label and keyboard focus.
2. **The building follows the catalogue.** Rooms are the departments the catalogue returns, ordered as in ADR-0040. Leadership is the headquarters, where GIA sits. The atrium holds MelonMotor. Floors grow with the department count, and an empty side slot is a meeting room with no hotspot. No department is hard-coded (Diseño is archived, ADR-0047, and is not drawn).
3. **Agent states come from real data.** `workStateOf` reads the agent's record and its latest task (`AgentTasksClient.list`, already used by the agent page):
   - paused → paused; draft or disabled → offline; archived → not drawn;
   - planning, running, verifying or retrying → working;
   - pending or paused task → waiting;
   - waiting for approval (the task or its follow-up), or failed in the last 24 hours → needs attention;
   - otherwise available.
     Tasks are read only with `specialist.read`, for at most 24 active agents, refreshed every 45 seconds while the page is visible. States show as a small light on the desk and one quiet pill per room, not as badges.
4. **Monitors show real work.** A room's wall screen shows the text of a task under way, or rests. No charts, figures or percentages are invented.
5. **The agent card** opens from an agent's desk. It shows the state, the current task with its runtime steps and the latest result. Its actions reuse what exists: give instructions (the agent's tasks, ADR-0063, with `specialist.task`), pause or resume (`specialist.manage`), see work and results (the agent page), documents (`document.read`). On a phone it is a bottom sheet.
6. **MelonMotor** is drawn as the office's infrastructure: thin lines from the atrium to the rooms, with a slow pulse only under `prefers-reduced-motion: no-preference`. Opened, it lists real flows only: hand-offs between departments in executing plans that come from a workflow (`plan.read`), and the tasks each department has under way. With nothing moving, it says so.
7. **The command box** keeps attach, voice and send, and adds four suggestions that fill the text without sending it. The existing quick actions move behind "More actions".
8. **Theme.** The signed-in app moves to a warm light theme through the existing `--office-*` tokens. Department rooms keep their dusk art and dark plate colours.
9. **Responsive.** Tablet stacks the right panel under the office. A phone shows a compact two-column building with avatars in each room, departments open full screen as today, and the agent card rises from the bottom.

## Consequences

- The Home is the office, with every department, agent, GIA and MelonMotor reachable by pointer, keyboard and screen reader.
- The Home now reads each active agent's latest task, which is up to 24 small reads per refresh. A summary endpoint can replace them later without changing the scene.
- Screens do not show pipeline or report figures yet. That would need more reads and is left for a later step.
- PixiJS, a router, a query library and a CSS framework are still not used.

## Amendment (2026-09-30): the whole Home in one view

Geovet asked for the whole Home to fit the window on a computer, with no vertical scroll outside the sidebar.

- On a screen at least 64rem wide and 36rem tall, the Home is exactly as tall as the window. The header and the command box take the room they need. The building takes the rest, and its width follows from its height: each floor is a side room (16:10), so every room stays in view. Nothing is scaled or cut to fit.
- The right panel is compact. Recent activity and today's tasks show 3, 2 or 1 entries by the window's height, and each keeps its link to all of them.
- The sidebar keeps its own scroll. Its text and rows are about 11% larger, and it is slightly wider.
- Below that size (a tablet in portrait, a phone), the Home flows as before.

## Amendment (2026-09-30): the offices in 3D

Geovet asked for the offices, furniture and agents to be redrawn in a modern 3D language (architectural visualisation, real materials, soft shadows, people in natural proportions), with nothing else on the Home changing.

- The rooms and workstations are modelled in three.js (`apps/web/scripts/office-art/scene3d/`) with physical materials (oak, walnut, plaster, glass, metal, fabric), image-based light, soft shadows and ambient occlusion, and baked to WebP by `bake.mjs` in headless Chromium. three.js is a bake-time tool only: it is not a dependency of the app and nothing 3D runs in the browser.
- Every room is an open box seen straight on with a shifted lens, so rooms side by side still read as one building. The back wall's foot is at 60% of the height and its big screen at the same rectangle as before, so every control stays where it was.
- Each department's room says what it does: Comercial a pipeline board, Operaciones a kanban and a process, Marketing a moodboard and a campaign poster, Investigación a board of pinned findings and a library, Finanzas a chart and files. Consejo shares headquarters with GIA: a strategy table by the window, GIA at her desk. Diseño is archived and not drawn, but its room is baked for when it returns.
- A workstation is three layers (chair and shadow, person, desk), so the Home still seats an agent or not. The monitor shows the department's kind of work, with no words or figures. The agent's state is drawn over it (dark when paused or offline, dimmed for an ambient figure, moving lines while working), and the state light is unchanged.
- GIA is part of headquarters' art. Her link covers her and keeps the chip, which now carries her avatar.
- The art carries no text or data, so any room or person can be replaced by other art (a 3D artist's renders, for example) at the same sizes and slots without changing code.

## Amendment (2026-09-30): the office of the future and MelonMotor's circuits

Geovet asked for the offices to read as a real office of the future where AI agents work: glass, metal, white and light grey, integrated light and discreet holographic touches, with no wood and nothing that looks like a spaceship or a game. MelonMotor becomes the building's nervous system, with circuits that move with real activity.

- **Materials.** The art is re-baked with no wood: a light composite floor with a clear coat, white composite and aluminium furniture, smoked glass, fine LED lines under screens and along the floor, and a soft bloom only on light sources. The palette stays cool; coral marks GIA and attention. Green is not used.
- **Each room shows its function** on glass panels behind the desks, with shapes and no words or figures: Comercial a funnel and a pipeline, Operaciones a kanban and a process flow, Marketing campaign creatives, Diseño layouts and creatives, Investigación a data network and documents, Finanzas charts, Consejo objectives and strategy in headquarters.
- **GIA** stands on a lit platform at the centre of headquarters, part of the building. Her link and chip are unchanged.
- **MelonMotor** is a glass column of light in the atrium with a circuit wall behind it. Its link and panel are unchanged.
- **Circuits** (`apps/web/src/office/scene/circuits.ts`) are drawn in SVG over the building: from the core to GIA and to each department's screen, with 45° corners. Each circuit's level comes only from its agents' real states (`attention`, `busy`, `ready`, `off`). Busy circuits carry one pulse per working agent (three at most) plus one returning; attention carries coral pulses back to the core; a circuit with nobody active is faint and still. GIA's trunk carries one pulse per active department at once. Hovering or focusing a room lights its circuit; opening MelonMotor shows the flows through the core. Nothing is invented: with no activity nothing moves.
- **Oficina viva.** Screens refresh with a slow sweep and circuits breathe when ready. On a phone, where the circuits are hidden, each working room shows a thin moving data line.
- **Reduced motion** stops every pulse, sweep and breath and keeps the static lines.
- **Performance.** SMIL and CSS only (`transform`, `opacity`, `filter`), no new dependencies, and art stays WebP.
- **Diseño.** The Home draws whatever the department catalogue returns. If Diseño is listed in an organisation, its room is drawn with its own art.

## Amendment (2026-09-30): the pixel reference

Geovet supplied a reference image of the Home and asked for it to be followed faithfully in composition, proportions, spacing and styling, while every piece stays real HTML, CSS and React with real data.

- **Board 3x3.** The office is three rows of three glass capsules, with the centre column narrower (10 : 7 : 10). The rows are Comercial | Consejo | Operaciones, Marketing | GIA | Finanzas and Investigación | MelonMotor | the sixth room. Catalogue types are placed in that order (`layout.ts`). Any other department follows in the business profile's order (ADR-0048), and the building still grows a row for every two more departments.
- **GIA** has her own central room. Clicking it opens GIA. **Consejo** has its own board room above her, and **MelonMotor** sits below her.
- **Rooms** are re-baked with a closer camera, big wall screens that show each department's function, dark chairs, plants and people seen from behind at their desks. Seats come from the art's floor corners (`roomFloor.ts`).
- **Circuits** are measured from the rooms as laid out. They run from a hub between GIA and MelonMotor along the gaps into each room. Their levels and pulses still come only from real agent states.
- **Chrome.** The palette moves to cool greys and blues. The top bar shows the credit balance when there is one, and the organisation's name moves into the account menu. The command box is a white pill with an orange send button and suggestion chips under it. MelonMotor's tagline is "Conecta y potencia tu empresa".
- **Real data rule.** The reference's activity, tasks, meetings and counts are examples. The Home shows real data or the empty states in the same places. There is no credit bar while plans have no allotment.
- **Diseño** is retired into Marketing (ADR-0047), so the sixth room is a meeting room unless an organisation has one more department.
- **Mobile** stacks Consejo, GIA and MelonMotor at full width, then the departments two per row.
