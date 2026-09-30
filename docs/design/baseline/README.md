# Design baseline (phase 0 of the Home redesign)

- Date: 2026-09-30, on `main` at `9246a02`.
- Purpose: the signed-in app as it is before the visual redesign, so every later phase can show before and after.
- Nothing visual changed in this phase.

## How these were taken

The signed-in app runs locally on the fake backend the tests already use (`apps/web/src/identity/testing.ts`), through a preview page that only the dev server serves:

```sh
pnpm install
pnpm --filter @melonoffice/web exec vite --port 5199
# in another terminal
CAPTURE_CHROMIUM_PATH=/path/to/chrome node apps/web/scripts/capture.mjs docs/design/baseline
```

- `apps/web/preview.html` and `apps/web/src/preview/` sign in a fixture owner and open `?route=` in `?scenario=`.
- `vite build` keeps `index.html` as its only entry, so the preview does not ship.
- Scenarios (`src/preview/scenarios.ts`):
  - `empty`: a new organization with the catalogue's departments and no agents.
  - `active`: six agents, two of them working, one waiting on an approval and one paused. It also has two follow-ups, one pending approval, four activity events and 487 credits.
- These are fixtures for review, like the tests' data, and are never served to an organization.
- Widths are 1440×900, 1024×768, 768×1024 and 390×844, as full-page JPEGs.
- **Fonts:** the capture container has no Segoe UI, SF or Roboto, so `system-ui` falls back to DejaVu Sans. Real devices show their own system font. That the typeface depends on the device is itself one of the findings below.

| Page                 | 1440                                       | 1024                                       | 768                                      | 390                                      |
| -------------------- | ------------------------------------------ | ------------------------------------------ | ---------------------------------------- | ---------------------------------------- |
| Home, office at work | [home-active-1440](home-active-1440.jpg)   | [home-active-1024](home-active-1024.jpg)   | [home-active-768](home-active-768.jpg)   | [home-active-390](home-active-390.jpg)   |
| Home, new office     | [home-empty-1440](home-empty-1440.jpg)     | [home-empty-1024](home-empty-1024.jpg)     | [home-empty-768](home-empty-768.jpg)     | [home-empty-390](home-empty-390.jpg)     |
| GIA                  | [gia-1440](gia-1440.jpg)                   | [gia-1024](gia-1024.jpg)                   | [gia-768](gia-768.jpg)                   | [gia-390](gia-390.jpg)                   |
| Comercial office     | [office-sales-1440](office-sales-1440.jpg) | [office-sales-1024](office-sales-1024.jpg) | [office-sales-768](office-sales-768.jpg) | [office-sales-390](office-sales-390.jpg) |
| Agents               | [agents-1440](agents-1440.jpg)             | [agents-1024](agents-1024.jpg)             | [agents-768](agents-768.jpg)             | [agents-390](agents-390.jpg)             |
| Approvals            | [approvals-1440](approvals-1440.jpg)       | [approvals-1024](approvals-1024.jpg)       | [approvals-768](approvals-768.jpg)       | [approvals-390](approvals-390.jpg)       |

## What the baseline shows

### Home

- **1440:** the 3×3 building, GIA and MelonMotor match ADR-0096. There is an empty band between the building and GIA's command box, because the building's width follows its height and stops short.
- **Header chips repeat each other.** The top bar says "5 agentes activos" and the page header says "2 agentes trabajando", with the same dot.
- **The date and greeting line** ("Miércoles, 30 de septiembre · Buenas tardes") sits above the title, in two colours.
- **The right panel is four cards of the same weight.** "Próximas reuniones", which has no calendar, weighs as much as recent activity.
- **Credits** are shown as a large amber number (`#D9901C`, 2.64:1 on white).
- **768:** the whole building stacks to one column of very tall rooms: Consejo, GIA and MelonMotor each take a full screen height. Department rooms switch to their empty art with avatars.
- **390:**
  - The search placeholder is cut ("Busca departa").
  - The agent and credit chips leave the top bar.
  - The building stacks as ADR-0096 describes.

### Other pages

- **Palette clash:** Agents and Approvals put a warm cream header block (`--mo-*`) inside the cool signed-in app (`--office-*`).
- **Comercial office:** it still draws the older warm 2D dusk room. The Home's rooms are the 3D office of the future, so a department looks different on the Home and in its own office.
- **Shared components:**
  - Agents lists its actions as three equal outline pills per row.
  - "Crear agente" looks like a text field.
  - Page headers, lists and panels differ from page to page, because each page borrows another page's classes.
- **Sidebar:**
  - The departments are Consejo, Operaciones, Comercial, Marketing, Investigación and Finanzas. There is no Diseño: it is archived into Marketing (ADR-0047).
  - "Proyectos" and "Calendario" are marked "Pronto".
  - Aprobaciones sits below the fold at 900px high.
