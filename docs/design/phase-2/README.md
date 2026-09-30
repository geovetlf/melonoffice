# Phase 2: typeface for the Home

Three candidate typefaces on the real Home, compared for Geovet to choose from. **Instrument Sans was chosen** (see the decision at the end and [ADR-0107](../../adr/0107-instrument-sans.md)).

## How the comparison was made

- **Same conditions for all three:**
  - the local preview (`apps/web/preview.html`) and the `active` scenario, with the same data, in Spanish;
  - the same viewports and waits;
  - the same tokens from phase 1: sizes, weights, line heights and colours.
- **What changes:** only the first family of `--mo-font-family` (`?font=onest|figtree|instrument-sans`, see `apps/web/src/preview/fonts.ts`). The fallbacks stay the same, and each version uses one family only.
- **Where the fonts come from:** Figtree and Instrument Sans are dev dependencies of `apps/web`, loaded by the preview only. The production app still ships Onest alone.
- **How to reproduce:** `node apps/web/scripts/compare-fonts.mjs <out-dir>` with the preview running.

## Side by side (A Onest · B Figtree · C Instrument Sans)

| Part of the Home                 | Comparison                                   |
| -------------------------------- | -------------------------------------------- |
| Sidebar (brand, sections, items) | [compare-sidebar](compare-sidebar.jpg)       |
| Top bar (search, chips, credits) | [compare-topbar](compare-topbar.jpg)         |
| Header (date, title, status)     | [compare-header](compare-header.jpg)         |
| A room's label                   | [compare-room](compare-room.jpg)             |
| Side panel (lists, small text)   | [compare-side-panel](compare-side-panel.jpg) |
| GIA's command box and chips      | [compare-command](compare-command.jpg)       |
| The whole Home on a phone (390)  | [compare-phone-390](compare-phone-390.jpg)   |

Full pages, one family each:

| Typeface          | Office at work, 1440                                                     | 1024                                                                     | New office, 1440                                                       |
| ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| A Onest           | [onest-home-active-1440](onest-home-active-1440.jpg)                     | [onest-home-active-1024](onest-home-active-1024.jpg)                     | [onest-home-empty-1440](onest-home-empty-1440.jpg)                     |
| B Figtree         | [figtree-home-active-1440](figtree-home-active-1440.jpg)                 | [figtree-home-active-1024](figtree-home-active-1024.jpg)                 | [figtree-home-empty-1440](figtree-home-empty-1440.jpg)                 |
| C Instrument Sans | [instrument-sans-home-active-1440](instrument-sans-home-active-1440.jpg) | [instrument-sans-home-active-1024](instrument-sans-home-active-1024.jpg) | [instrument-sans-home-empty-1440](instrument-sans-home-empty-1440.jpg) |

## Measurements

| Measurement                                                      | A Onest       | B Figtree     | C Instrument Sans |
| ---------------------------------------------------------------- | ------------- | ------------- | ----------------- |
| x-height / cap height (em)                                       | 0.527 / 0.707 | 0.500 / 0.700 | 0.510 / 0.720     |
| Average character width (em)                                     | 0.592         | 0.530         | 0.564             |
| Width of "Tu oficina ya está trabajando" at the Home's size (px) | 362           | 345           | 353               |
| Weights (variable)                                               | 100–900       | 300–900       | 400–700           |
| Tabular figures (`tnum`)                                         | yes           | yes           | yes               |
| Latin file (woff2)                                               | 34 KB         | 19 KB         | 29 KB             |
| Licence                                                          | SIL OFL 1.1   | SIL OFL 1.1   | SIL OFL 1.1       |

At these sizes no text wraps differently: the side panel and the sidebar are the same height in all three (`metrics.json`).

## Observations

| Criterion                 | A Onest                                                                                                    | B Figtree                                                                                    | C Instrument Sans                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Legibility, small text    | The best of the three. The largest x-height and open shapes; "Tú · hace 8 minutos" reads clearly at 12 px. | Good. Its lower x-height makes 12 px text look slightly smaller and lighter.                 | Good at 14 px and up. At 12 px its narrow spaces run words together ("Tú·hace 8 minutos", "1 día"). |
| Hierarchy, titles         | Solid, wide bold. Its curly "y" gives the title a character of its own.                                    | Clean and even, with the least contrast between title and body.                              | The most tension: tight spacing and tall capitals give the most "product" headline.                 |
| Personality               | Warm and friendly without being childish. It matches the rounded melon mark.                               | Friendly and neutral. It is very common in SaaS, so it reads the least as MelonOffice's own. | Precise and editorial. The most tech and premium, and the least warm.                               |
| Tech / premium / friendly | medium / medium / high                                                                                     | medium / low-medium / high                                                                   | high / high / medium-low                                                                            |
| Sidebar and navigation    | The most presence per item.                                                                                | The lightest and most compact.                                                               | Compact and sharp. The Spanish accents sit well.                                                    |
| Buttons, chips, badges    | Chips read clearly. Pill labels get wider.                                                                 | The most compact chips.                                                                      | Crisp, but tight words inside chips ("3 tareas requieren tu atención").                             |
| Numbers (credits, counts) | Wide, sturdy figures. "487" is the strongest.                                                              | Rounder, lighter figures.                                                                    | Narrow figures. The "1" is tight next to other characters.                                          |
| Density                   | The widest: about 5% wider than Figtree.                                                                   | The densest.                                                                                 | In between.                                                                                         |
| Desktop / phone           | Good on both. At 390 the search placeholder is cut sooner, because the glyphs are wider.                   | Good on both. The most text fits.                                                            | Good on desktop. On a phone the 11 to 12 px text is the hardest of the three to read.               |
| Beside the 3D office      | The friendliest next to the soft 3D rooms and GIA.                                                         | Neutral: it disappears against the art.                                                      | Sharp against the soft rooms: more "control room", less "office".                                   |

## Decision: C, Instrument Sans ([ADR-0107](../../adr/0107-instrument-sans.md))

Geovet chose Instrument Sans. It is now the app's typeface, with type tokens that correct what the comparison showed: a 0.05 em word spacing for its narrow space, headline and uppercase tracking set once, and 11 px as the smallest size.

Before and after, at 2x. Each image has three columns: Onest on `main`, Instrument Sans with no adjustment, and Instrument Sans with the ADR-0107 tokens.

| Part of the Home | Before and after                         |
| ---------------- | ---------------------------------------- |
| Sidebar          | [ba-sidebar](final/ba-sidebar.jpg)       |
| Top bar          | [ba-topbar](final/ba-topbar.jpg)         |
| Header           | [ba-header](final/ba-header.jpg)         |
| A room's label   | [ba-room](final/ba-room.jpg)             |
| Side panel       | [ba-side-panel](final/ba-side-panel.jpg) |
| Command box      | [ba-command](final/ba-command.jpg)       |

The app with Instrument Sans:

- Home at 1440 ([office at work](final/home-active-1440.jpg), [new office](final/home-empty-1440.jpg)), [1024](final/home-active-1024.jpg) and [390](final/home-active-390.jpg).
- Other screens: [GIA](final/gia-1440.jpg), [Agents](final/agents-1440.jpg), [Approvals](final/approvals-1440.jpg) and the [Comercial office](final/office-sales-1440.jpg).

### Validation

| Check                     | Result                                                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Small text (11–12 px)     | Meta strings keep their spaces ("Tú · hace 8 minutos"), and nothing is below 11 px.                                              |
| Hierarchy                 | Titles, panel headings and body text separate clearly. Uppercase labels are semibold at 12 px with one tracking amount.          |
| Density                   | Same layout as before: side panel 733 px, sidebar 398 px; the title is 364 px, Onest was 362 px ([metrics](final/metrics.json)). |
| Titles                    | Tight (-0.01 em) and technical, with no crowding.                                                                                |
| Navigation                | Items read clearly; the active item and the "Pronto" badges are unchanged.                                                       |
| Buttons, chips and badges | Readable at every size. The notification count is 11 px bold.                                                                    |
| Figures (credits, counts) | Tabular in the credit balance, and narrow elsewhere, as the typeface draws them.                                                 |
| Desktop and phone         | 1440, 1024 and 390 hold. Room labels fit, and the phone placeholder is cut as before.                                            |
| Contrast and white-label  | Unchanged from ADR-0106: colour tokens and their tests were not touched.                                                         |
