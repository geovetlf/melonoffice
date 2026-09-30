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
   - a visual layer of raster rooms (WebP at 1x and 2x, `srcset`, lazy below the first floor), made from an SVG generator in `apps/web/scripts/office-art/` and baked by `bake.mjs`. The rooms carry no text or data, so any room art can be swapped at the same slot geometry. The reference image is a style reference only and is not shipped;
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
