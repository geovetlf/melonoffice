# ADR-0106: Design tokens v1, one visual foundation for the whole app

- Status: Accepted
- Date: 2026-09-30
- Builds on: [ADR-0087](0087-brand-config-and-domain-resolution.md), [ADR-0090](0090-partner-console-and-brand-screens.md), [ADR-0096](0096-home-v4-interactive-office.md)
- Changes: the palette of design tokens v0 (`packages/ui`) and the `--office-*` properties of `office.css`.

## Context

Phase 0 of the Home redesign ([baseline](../design/baseline/README.md)) found problems with the app's look and with white-label:

- **Two palettes in one app.** `packages/ui` used a warm cream and terracotta (`--mo-*`). The signed-in app had its own cool grey palette with a hard-coded orange (`--office-*` in `office.css`). Pages mixed them.
- **White-label stopped at the sign-in page.** `applyBrand` set `--mo-color-accent`, but the signed-in app read `--office-accent: #e0643a`.
- **Failing contrast.** Some colours fell short of WCAG AA:
  - the orange on white, 3.47:1;
  - the amber credit balance and times, 2.64:1;
  - white on the orange send and primary buttons, 2.78:1.
- **The typeface depended on the device.** `system-ui` renders as Segoe UI, SF, Roboto or DejaVu depending on the device.

Geovet set the direction:

- porcelain `#F3F5F8`, surfaces `#FFFFFF`, text `#18202E` and `#556072`;
- a functional melon `#C0451D`, and an expressive melon `#FF8A5C` that is never small text;
- no blue app, and no new UI or CSS library.

## Decision

1. **One token set.**
   - `packages/ui/src/tokens.ts` (mirrored in `tokens.css`) defines colour, type, space, radius, shadow and motion.
   - The `--office-*` properties are removed. Every stylesheet reads `--mo-*` directly.
   - The only local overrides left are a department room's dusk plate (ADR-0040) and the office art's own colours (screens, circuits, desks).
2. **Semantic colours.** Components use the semantic names below, never palette values.
   - `background`, `surface`, `surface-elevated`, `surface-subtle`, `surface-muted` and `surface-glass`.
   - `border`, and `border-strong` for outlines that identify a control.
   - `hover`, `text-primary`, `text-secondary` and `text-on-accent`.
   - `accent`, `accent-hover`, `accent-soft`, `accent-expressive` and `highlight`.
   - `focus-ring`, and `success`, `warning`, `danger`.
   - Six agent states: `state-working`, `-available`, `-waiting`, `-attention`, `-paused` and `-offline`.
3. **Contrast is tested.** `tokens.test.ts` checks every combination on `background`, `surface` and `surface-subtle`:
   - every text colour against 4.5:1;
   - focus, strong border and every state colour against 3:1;
   - white on the accent against 4.5:1.

   The credit balance is now primary text in tabular figures. Primary buttons use the solid accent with white text.

4. **The brand reaches everything.**
   - `applyBrand` sets `accent`, `focus-ring` and `accent-expressive`. The expressive tone is a lighter mix of the brand colour.
   - `accent-hover` and `accent-soft` are mixed from `accent` in CSS, so they follow the brand too.
   - A brand colour is applied only when white text on it, and the colour as text on the app's background, both reach 4.5:1.
   - State colours never follow a brand.
   - A test fails if a stylesheet brings back its own melon or an `--office-*` property.
5. **Type.**
   - Onest (SIL Open Font License, variable weight 100 to 900, tabular figures) comes from `@fontsource-variable/onest` and is served with the app.
   - Browsers download only the subsets a page uses: Latin is about 34 KB.
   - The CSP (`default-src 'self'`) needs no change.
   - The system stack stays as the fallback, including Noto for CJK.
   - Phase 2 of the redesign compares Onest with two alternatives on the real Home. Changing it later is a one-token change.
6. **Not in this decision.** The Home's composition, the room art, the circuits, MelonMotor, uppercase labels and the shadows drawn over the art belong to later phases.

## Consequences

- The sign-in pages, every screen and the office share one palette. Cream and terracotta are gone.
- A white-label organization now sees its colour on:
  - navigation, links and focus;
  - buttons, including GIA's send button;
  - the soft tints and GIA's glow.
- The app ships a web font (about 34 KB for Latin, cached for a year under `/assets/`).
- `@fontsource-variable/onest` is a new dependency of `packages/ui`.
