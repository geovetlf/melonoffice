# ADR-0107: Instrument Sans, and type tokens that suit it

- Status: Accepted
- Date: 2026-09-30
- Builds on: [ADR-0106](0106-design-tokens-v1.md)
- Changes: ADR-0106 §5 (Onest as the provisional typeface).

## Context

Phase 2 of the Home redesign compared Onest, Figtree and Instrument Sans on the real Home, under identical conditions ([comparison](../design/phase-2/README.md)). Geovet chose **Instrument Sans**. The direction is a SaaS product that looks premium, technological, modern and futuristic, and stays professional and usable.

The comparison also showed where Instrument Sans needs help, and measuring the font confirmed it:

- **Its word space is narrow:** 0.20 em, against 0.25 to 0.27 em in the other two. Its middle dot is 0.10 em. At 11 to 12 px, short meta strings run together ("Tú·hace 8 minutos", "vencido hace 1 día").
- **Its headlines are already tight.** The -0.02 em the app used on headlines made them tighter still.
- **Some text was too small.** The Home's room labels could drop to 10 px through fluid sizes (`clamp(0.62rem, …)`), and several stylesheets set sizes and tracking by hand: 11, 11.2, 11.5, 13 and 16.3 px, and four different tracking amounts for uppercase labels.

## Decision

1. **Instrument Sans is MelonOffice's typeface.**
   - It is served with the app from `@fontsource-variable/instrument-sans` (SIL Open Font License, variable weight 400 to 700, tabular figures) and replaces Onest in `packages/ui`.
   - Latin is about 29 KB, and the CSP needs no change.
   - The system stack stays as the fallback, including Noto for CJK.
   - The app's weights (400, 500, 600 and 700) are all within its range.
2. **Type tokens that suit it** (`packages/ui/src/tokens.ts`):
   - `--mo-font-word-spacing: 0.05em` on the page brings the word space back to 0.25 em. Form controls inherit it, instead of the browser's reset.
   - `--mo-font-tracking-tight: -0.01em` for headlines and the wordmark.
   - `--mo-font-tracking-wide: 0.08em` for every uppercase label, instead of 0.06, 0.08, 0.1 and 0.12 em.
   - `--mo-font-size-xxs: 0.6875rem` (11 px) is the smallest text the app sets, fluid sizes included.
3. **Stylesheets take type from the tokens.**
   - Hand-set sizes in `app.css`, `office.css` and `home.css` now use the scale: 11 px goes to `xxs`, 12 px to `xs`, 13 px to `xs` (sidebar headings, now semibold) or `sm` (the compact side panel's links), 14 px to `sm`, and so on.
   - Every fluid size's floor is at least `xxs`.
   - `styles.test.ts` fails if a stylesheet sets a size in `rem` or `px`, a fluid floor below `xxs`, or its own tracking. Sizes in `em`, relative to their parent, are allowed.
4. **The comparison stays reproducible.**
   - The preview keeps `?font=onest|figtree|instrument-sans`. Onest and Figtree are dev dependencies of `apps/web`, loaded by the preview only.
   - The production build ships Instrument Sans alone.

## Consequences

- The app now looks tighter and more technical, while small text stays readable: meta strings keep their spaces, and nothing is smaller than 11 px.
- The Home's layout is unchanged:
  - the side panel and sidebar keep their heights at 1440;
  - room labels fit at 1440, 1024 and 390;
  - the title is 364 px wide, where Onest was 362 px.
- A later change of typeface is a change of `font.family`, plus whatever that face's metrics need, in one place.
