import { font } from '@melonoffice/ui';

/**
 * The typefaces compared for the Home redesign (phase 2). Each replaces only the first family of
 * the token `--mo-font-family`, so every option keeps the same fallbacks, sizes and weights.
 * Onest is the app's own (packages/ui); the others load here, for the preview only.
 */
export const REVIEW_FONTS = {
  onest: { family: 'Onest Variable', load: () => Promise.resolve() },
  figtree: {
    family: 'Figtree Variable',
    load: () => import('@fontsource-variable/figtree/wght.css'),
  },
  'instrument-sans': {
    family: 'Instrument Sans Variable',
    load: () => import('@fontsource-variable/instrument-sans/wght.css'),
  },
} as const;

export type ReviewFont = keyof typeof REVIEW_FONTS;

const isReviewFont = (name: string | null): name is ReviewFont =>
  name !== null && Object.hasOwn(REVIEW_FONTS, name);

/** Loads the named typeface and makes it the app's; an unknown name leaves the tokens as they are. */
export async function applyReviewFont(name: string | null): Promise<void> {
  if (!isReviewFont(name)) return;
  const choice = REVIEW_FONTS[name];
  await choice.load();
  const fallbacks = font.family.slice(font.family.indexOf(',') + 1).trim();
  document.documentElement.style.setProperty(
    '--mo-font-family',
    `'${choice.family}', ${fallbacks}`,
  );
  await document.fonts.load(`400 1em '${choice.family}'`);
  await document.fonts.load(`700 1em '${choice.family}'`);
}
