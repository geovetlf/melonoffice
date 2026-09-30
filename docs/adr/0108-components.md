# ADR-0108: Components, one toolkit for every screen

- Status: Accepted
- Date: 2026-09-30
- Builds on: [ADR-0106](0106-design-tokens-v1.md), [ADR-0107](0107-instrument-sans.md)
- Audit and screenshots: [phase 3](../design/phase-3/README.md)

## Context

Phase 3 of the Home redesign audited the app's components ([audit](../design/phase-3/AUDIT.md)). The same job was drawn several ways:

- **Filters and tabs:** four chip families.
- **Badges:** five styles.
- **Menus:** three, on frosted glass.
- **Sheets and dialogs:** each with its own surface.
- **Buttons:** only two variants.
- **Fields:** 112 styled by their parent, or not at all (Conversations showed browser-default controls).
- **Loading, empty and failed lists:** looked the same.
- **Agent lights:** five families of coloured circles, drawn by colour alone.

The Conversations tabs set `aria-selected` on a button that does not draw it, so the chosen tab could not be seen.

## Decision

1. **Component tokens** (`packages/ui/src/tokens.ts`):
   - control heights: `md` 44 px, the target size; `sm` 32 px, for dense rows inside a panel;
   - overlay layers: `sticky`, `popover`, `scrim`, `sheet`, `dialog`;
   - the scrim and pressed colours, and soft tones for success, warning and danger (tested at 4.5:1 with their text);
   - the disabled opacity and the focus ring.
2. **The toolkit** is `packages/ui/src/components.css`, with React components where they carry behaviour.
   - **`Button`:** `primary`, `secondary`, `ghost` and `danger` variants, `sm` and `md` sizes, `loading` (`aria-busy`, spinner, waits) and `iconOnly`. The earlier API is unchanged.
   - **Fields:** base styles on `input`, `select` and `textarea` at zero specificity, so every form gets them and a screen's own rule still wins. They have a 3:1 outline, a drawn chevron and states for hover, focus, disabled and invalid (`aria-invalid`). They never widen their column. Labels, hints and errors; the search field.
   - **Choices:** `mo-chip` for filters (pressed, selected or current), `mo-segmented` and `mo-tabs`.
   - **`Badge`:** tones and outline, and `count`.
   - **`StatusDot`:** the six agent states by shape as well as colour. Working has a halo, waiting is a ring, attention a diamond, paused a square, offline is smaller, and available is filled.
   - **Surfaces:** `mo-card`, `mo-panel`, `mo-overlay` with `mo-menu`, `mo-tooltip`, `mo-scrim`, `mo-dialog` and `mo-sheet`. The sheet becomes a bottom sheet on a phone.
   - **`Spinner` and `StateMessage`:** loading, empty, error (`alert`), success and warning, boxed or inline, with one action.
   - **`Avatar`, the meter and figures** in tabular numbers.
3. **Applied to the app** without touching any route, API, permission, piece of logic or the Home's composition:
   - **Filters:** every filter and tab button is a chip. The Conversations tabs now show which one is selected.
   - **Actions:** buttons that borrowed the tab class are buttons again. Approve is primary and reject is destructive; cancel and clear are quiet.
   - **Badges:** memory verification, provider health, "Pronto" and the notification count are badges whose tone follows what they mean.
   - **Menus and the search results:** solid raised surfaces, with no frosted glass.
   - **The agent card, MelonMotor's panel, the quick ask and the phone menu:** they use the overlay layers, the scrim and the button primitive.
   - **Labels:** the uppercase labels inside overlays are sentence case. The sidebar keeps its uppercase headings, as Geovet asked.
   - **Panels:** there is one definition, and the Home's side panel no longer restyles it. A failed list shows its message in the danger colour.
   - **Page boxes:** the box left from the old dark frame is gone, so screens sit on the background like the Home.
   - **Agent lights:** the room lights and the Home's status chips take the dot shapes.
4. **Kept in place by tests:**
   - the new components' own tests;
   - the soft-tone contrast tests;
   - `styles.test.ts` now fails if a stylesheet stacks something with a raw `z-index` of 10 or more instead of a layer token.
5. **Reviewed in a gallery:** `apps/web/components.html` (preview only) shows every component in every state. `scripts/capture-components.mjs` captures it at 1440, 1024, 768 and 390, with hover, pressed and focus states, the screens and the overlays.

## Consequences

- The Home redesign (phase 4) builds from these parts, with no new styles of its own.
- Existing screens are more consistent, and no screen scrolls sideways at 390.
- Memory's form used to be 459 px wide at 390; its selects no longer widen their column.
- Screens still differ in their page headers and lists. Phase 5 moves them onto `mo-panel`, `mo-card` and `StateMessage` one by one.
