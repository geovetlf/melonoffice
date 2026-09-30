# Phase 3: component audit and plan

- Date: 2026-09-30, on `main` at `6f5bab2`, after ADR-0106 (tokens) and ADR-0107 (Instrument Sans).
- Screenshots of the state before: `before/` in this folder, taken with `apps/web/scripts/capture-components.mjs`.

## What exists

| Group                   | Today                                                                                                                                                                                                                                                                             | Problem                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buttons                 | `Button` in `packages/ui` (161 uses: 103 `secondary`, the rest `primary`), plus 56 raw `<button>` elements with their own classes (`customers__tab`, `panel__link`, `agent-sheet__action`, …).                                                                                    | Only two variants: no quiet or destructive action, no small size, no loading state. The secondary button's border is decorative (1.6:1), so the control is not identified by it. |
| Inputs                  | 112 `input`, `select` and `textarea` elements with no class. They are styled by their parent (`.login input`, `.connection-form input`, `.brand-form__field`), or not at all.                                                                                                     | Conversations shows browser-default fields (small search box, native select). Heights, radii and focus differ from screen to screen.                                             |
| Search                  | `.search` in the top bar (a pill); `.search__results` as a list under it.                                                                                                                                                                                                         | The only designed field. Its results list has its own look.                                                                                                                      |
| Chips, filters and tabs | Four families for the same job: `.period-picker__option` (32 px, pill), `.customers__tab` (bold pill), `.inbox` filters (bold pill), the memory filters; plus `.home4__chip` and `.gia-suggest__item`.                                                                            | Four different heights, weights and "selected" styles for the same idea.                                                                                                         |
| Badges                  | `.sidebar__soon`, `.memory__badge`, `.platform__badge`, `.assist__badge` (italic, `0.85em`), `.notifications__count`.                                                                                                                                                             | Five badge styles. Their tones don't map to meaning (accent-soft is used for "proposed", "unverified" and "inactive").                                                           |
| Cards and panels        | `.panel` (20 px corners) is used everywhere; the Home side panel restyles it (18 px); list items are `approval-card`, `connection-card`, `report-card`, `customers__card`, each with its own border and corners. Pages sit in a subtle surface box (`--mo-color-surface-subtle`). | 26 distinct corner values and about 27 shadows (phase 0 count). Page boxes and cards compete.                                                                                    |
| Menus and popovers      | `.user-menu__panel`, `.notifications__panel`, `.search__results`, and each overlay stacks at its own z-index (20 to 50).                                                                                                                                                          | Three menu surfaces with different padding and items that have no hover structure.                                                                                               |
| Dialogs and sheets      | `.gia-quick` (dialog with scrim), `.agent-sheet` (side sheet, bottom sheet on a phone), `.motor-panel`, `.seat__panel`, the phone menu (drawer and scrim).                                                                                                                        | Each has its own surface, shadow, header and close button.                                                                                                                       |
| States                  | `p.panel__empty` (with `role="status"` or `role="alert"`) and `.notice--*`. Loading, empty and error look the same; the only loading cue is text ("Cargando…").                                                                                                                   | No spinner, and no visual difference between "loading", "nothing here" and "failed".                                                                                             |
| Agent indicators        | `.b-room__dot--*`, `.desk__light--*`, `.home4__chip-dot--*`, `.gia-state__dot`, `.topbar__dot`: five families of coloured circles.                                                                                                                                                | A state is shown by colour alone. Working (melon) and attention (red) are both warm.                                                                                             |
| Avatars                 | `.agent-avatar` (gradient, initials), the account avatar, `.gia-avatar`.                                                                                                                                                                                                          | Acceptable; sizes are set by hand.                                                                                                                                               |
| Credits                 | `.topbar__credits` (pill), `.credits__number` (tabular), `.credits__meter`.                                                                                                                                                                                                       | Fine after phase 1. The meter stays hidden while plans have no allotment.                                                                                                        |
| Navigation              | `.sidebar__item` (active: soft accent, inset bar), `.sidebar__heading` (uppercase), "Pronto" badges, the phone drawer.                                                                                                                                                            | Consistent. Hover and focus need the shared state layer.                                                                                                                         |
| GIA and MelonMotor      | The command box (`.gia-command`), the quick ask, the GIA chip, the MelonMotor panel.                                                                                                                                                                                              | The command box is the best-finished component. The quick ask is a plain box on a scrim.                                                                                         |

## Plan

The toolkit is built once in `packages/ui` and the app's existing families are restyled to use it. No route, API, permission, piece of product logic, GIA, MelonMotor or the Home's composition changes.

1. **Component tokens** (`tokens.ts`): control heights (`sm` 32 px for dense filters, `md` 44 px, the target size), overlay layers (`sticky`, `popover`, `scrim`, `sheet`, `dialog`), the scrim colour, the disabled opacity, and the focus ring.
2. **Primitives** (`packages/ui/src/components.css`, plus React components where they carry behaviour):
   - `Button`: `primary`, `secondary`, `ghost` and `danger` variants; `sm` and `md` sizes; `loading` with `aria-busy`; icon-only buttons.
   - Fields: `input`, `select` and `textarea`, the search field, labels, hints and errors. The base style goes on the elements at zero specificity, so every form in the app gets it without markup changes.
   - `Chip` (toggle and filter), segmented control and tabs.
   - `Badge` in neutral, accent, success, warning and danger tones, plus a count badge.
   - `StatusDot` for the six agent states, drawn by shape as well as colour:
     - available: filled;
     - working: filled with a halo;
     - waiting: ring;
     - attention: diamond;
     - paused: hollow;
     - offline: small.
   - Surfaces: card, panel, menu, tooltip, dialog, sheet and scrim, by level (resting, raised, overlay).
   - `Spinner` and `StateMessage` (loading, empty, error, success, warning).
   - `Avatar` and meter.
3. **Apply** the primitives to what exists:
   - panels (one definition);
   - the four filter families;
   - badges;
   - menus;
   - the agent sheet, MelonMotor panel, quick ask and phone drawer;
   - state messages;
   - agent lights;
   - page boxes.
4. **Gallery**: `apps/web/components.html`, preview only. It shows every primitive in every state, captured at 1440, 1024, 768 and 390, next to before and after screenshots of the screens.

## Not in this phase

- The Home's composition, room art, circuits and MelonMotor art (phase 4).
- The department office's older dusk room.
- Copy changes (phase 5).
