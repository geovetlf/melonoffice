# ADR-0111: An accessibility pass over the Home and the shell

- Status: Accepted
- Date: 2026-10-01
- Builds on: [ADR-0108](0108-components.md), [ADR-0109](0109-home-rebuilt-on-the-toolkit.md), [ADR-0110](0110-secondary-pages-on-the-page-components.md)
- Screenshots and audit: [phase 6](../design/phase-6/README.md)

## Context

The Home and the secondary pages were rebuilt in phases 1–5. Phase 6 checks them rather than redesigning anything.

An audit of `main` (axe-core 4.13, target sizes, a keyboard walk and the animations that run) found the following. None of it was sideways scroll or a missing `h1`; those were clean.

- **Search box:** it pointed `aria-controls` at a results list that exists only while there is a query. axe rates this critical, on every signed-in page.
- **Selected text:** the accent as text on its soft tint read 4.31:1. This covers a selected chip or segment, the sidebar's current page and an accent badge.
- **Keyboard:** there was no skip link, and 17 stops came before the content on a desktop. GIA's field and the quick ask's field showed no focus ring.
- **Touch targets:** at 768 and 390, many controls of the Home and the shell were below 44 px.
- **Decorative motion:** GIA blinked, and a department's room breathed and glowed.
- **Tables:** a table that scrolls repeated its section's landmark.
- **Left over from phase 5:** the pipeline board scrolled out of the keyboard's reach, the follow-up a link opened was not marked, and a paragraph sat inside the platform's totals list.

## Decision

1. **`accent-strong`.** A new token, the accent mixed with 20% black, for accent text on the soft tint. It follows a white-label colour and keeps 4.5:1 on every surface for any brand that passes on white (tested with six). The Home's period chips keep their look.
2. **The search box** names its results list only while it is shown.
3. **A "Skip to content" link** is the first stop on every signed-in page. It moves focus to `main`.
4. **Touch targets.**
   - On a tablet, a phone or a touch screen (≤ 48 rem or a coarse pointer), these controls are 44 px tall: sidebar items, notifications, the account button, GIA's field and suggestions, chips, segments, small buttons, task rows, panel links, link buttons and the back link.
   - A desktop with a pointer keeps its density. Its loose links are at least 24 px.
5. **Focus.** GIA's box takes the focus ring when its field has keyboard focus. The quick ask's field draws its own.
6. **Only real work moves:** live wall screens, work bars, typing, a desk's light and a room's data. GIA's blink and the room's breathing and glows are gone. Reduced motion still stops everything.
7. **Scrolling boxes.**
   - A `DataTable` that scrolls is a named group, not a region.
   - The pipeline board is reachable from the keyboard while it scrolls.
   - Both use one hook, `useScrollsSideways`.
8. **Phase 5 leftovers.**
   - The follow-up a link opened is marked with the accent's edge and tint.
   - The platform's unpriced note sits after its totals list.
9. **Clean-up.**
   - The 14 dead `home__*` selectors are deleted.
   - The quick ask's hint has its own class, so it no longer borrows Customers'.
10. **Kept in place by tests:**
    - contrast of `accent-strong` for six brands;
    - the search box's reference;
    - the skip link;
    - axe on the Home, empty and at work, in jsdom (the rules that need a layout run in the browser audit);
    - a scrolling table that is no landmark;
    - every animation is work or a sheet opening, and every loop stops with reduced motion;
    - every field that hides its own ring gets one back;
    - the touch rules cover the shell, the Home and the toolkit.

    `scripts/audit-a11y.mjs` checks axe, targets, overflow, the `h1`, the keyboard and motion in a browser at four widths.

## Consequences

- axe finds nothing on the Home, empty or at work, at 1440, 1024, 768 or 390. Every control of the Home meets the target size there.
- On a phone or tablet the Home is up to about 100 px taller. The desktop layout is unchanged.
- **Left for a later phase:**
  - Two regions on the contact card are both named "Oportunidades" (axe, moderate).
  - Four `mo-link`s used outside a sentence are 24 px on a touch screen.
  - The AI usage page's recent operations put a short title and its date on one line.
  - The other items of the phase 5 report remain open.
- A screen reader was not tried in this environment: only the accessibility tree and axe. A person should check it with VoiceOver or NVDA.
