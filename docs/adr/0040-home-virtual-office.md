# ADR-0040: The Home as the virtual office, and the way into each department

- Status: Proposed (pending Geovet's review)
- Date: 2026-09-27
- Builds on:
  - [ADR-0005](0005-initial-departments.md) (the D-11 departments as catalogue data)
  - [ADR-0006](0006-no-fixed-specialist-quantity.md) (the Home renders the specialists that exist)
  - [ADR-0025](0025-departments-and-specialists.md) (departments and specialists)
  - [ADR-0036](0036-web-identity-foundation.md) (the signed-in web app and its router)
- Decisions it applies (Geovet, 2026-09-27):
  - the Home is the company's office, seen whole;
  - the office uses the real D-11 catalogue: Consejo y Dirección is one room and Finanzas is its own.
- Does not change: any API, the conversations logic (CV-1 to CV-6A), the runtime, credits, GIA or the infrastructure.

## Context

The signed-in app showed only the Conversations Center. The product is a virtual office. The Home has to show the company working, and let a person walk into each department and later to each agent.

This has to happen without inventing anything:

- There is no GIA yet.
- There are no tasks, meetings or activity routes yet.
- Agents are specialist records, not running AI (D-28).
- Two libraries are not approved: PixiJS and a router library.

## Decision

### Five levels, two of them built

| Level | Place                   | Path                             | Now                                                   |
| ----- | ----------------------- | -------------------------------- | ----------------------------------------------------- |
| 1     | Home: the whole office  | `/` (`/home` too)                | Built                                                 |
| 2     | A department's office   | `/office/<slug>`                 | Built: the room, its real agents, areas marked "Soon" |
| 3     | An agent                | `/office/<slug>/agent/<agentId>` | Reserved: shows the agent's record and what will come |
| 4–5   | Its activity and output | (inside level 3)                 | Not built                                             |

Other pages:

- `/gia` is GIA's place. It is reserved and says so.
- `/conversations` is the Conversations Center, which moved from `/` and is otherwise unchanged.

How paths work:

- `shell/routes.ts` is the only place that turns a path into a page and a page into a path. It uses the history router of ADR-0036.
- The slug is the catalogue type (`design_video` becomes `design-video`), so it is the same in every language.
- A custom department's slug is `custom-<id>`.
- Unknown paths show "This place does not exist".
- The web server already falls back to the app on every path, so a refresh works.

### Data first, never invented

| Part                                                       | Source                                                                                   |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Rooms and their names                                      | `GET …/departments` (catalogue keys, D-17)                                               |
| People at the desks, the agents count, states, agent pages | `GET …/specialists`: active agents drawn, paused ones dimmed, the rest empty desks       |
| Credits                                                    | `GET …/credits` (balance only)                                                           |
| Plan                                                       | `GET …/billing` (plan id to its name). No upgrade is offered: only Emprendedor is active |
| Search                                                     | Departments and agents already loaded                                                    |
| Tasks, activity, meetings                                  | Example data in `home/sampleData.ts`, always shown under an "Example" badge              |
| GIA bar, attachments, voice, quick actions                 | Laid out; each says "Soon" or "GIA is not connected yet". They call nothing              |

Rules for loading:

- Each part is read only when the role holds its permission. Otherwise no call is made and the part is hidden.
- A part the API cannot answer shows as unavailable.
- An agent's state shows only what its record says: `available` for an active one, `paused` for a paused one. The other states (working, waiting, processing, needs attention) exist in the components for when the runtime reports them.
- Credit allotment, usage percentage and the weekly chart are drawn only when those values are given (D-12 is pending).

### The office, drawn

- Each department is a room: an SVG pod with a lit wall, the department's screen, shelves, lamps and desks.
- Its look (icon, screen motif, warm hue) is presentation data keyed by the catalogue type. An unknown type gets a default look, so a new department appears without code.
- Headquarters (Consejo y Dirección) sit on the top floor with GIA's mark (ADR-0005).
- The city at dusk sits behind the rooms.
- No WebGL, canvas or images.

Motion:

- The people sway slightly and the screens glow. Only transform and opacity animate, slowly.
- None of it runs when the person asks for reduced motion.

Entering a room:

- The View Transitions API grows the chosen room into the department's office.
- Navigation never waits for the transition.
- Without support, or with reduced motion, it is a plain navigation.

### Interaction and access

- A room is a real link: keyboard, focus ring, middle-click, and an accessible name that includes its agents ("Enter Marketing. 2 active agents").
- Hover and focus raise and light the room and show "Enter". On touch screens "Enter" is always visible.
- States carry an icon and a word, never color alone.
- A department's office has a breadcrumb (Office / Department / Agent), and focus moves to its heading.
- The sidebar separates the office (Home, GIA, each room) from the tools. Tools that do not exist are shown as "Soon", never as dead links.

Responsive layout:

- Desktop: the full scene.
- Below 64rem: the sidebar becomes a drawer, closed with Escape, the scrim or navigation.
- On a phone: the rooms become a swipeable row.

## Consequences

- The Home works today with real departments, agents, credits and plan, and never claims work that is not happening.
- Each placeholder is one prop or one file away from real data: the tasks, activity, meetings, credit extras, agent states and agent workspace.
- Adding a department type, a custom department or any number of specialists needs no change here.
- The Conversations Center lives at `/conversations`, reached from the sidebar's Communications.
