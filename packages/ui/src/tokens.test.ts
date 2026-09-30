// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';
import { color, cssVariables, palette } from './tokens.js';

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

/** The sRGB mix CSS `color-mix(in srgb, a p%, b)` computes, as #rrggbb. */
function mix(a: string, share: number, b: string): string {
  const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [x, y] = [channels(a), channels(b)];
  return `#${x
    .map((value, i) => Math.round(value * share + (y[i] ?? 0) * (1 - share)))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

describe('contrast (WCAG 2.2 AA)', () => {
  const surfaces = [
    ['background', color.background],
    ['surface', color.surface],
    ['subtle surface', color.surfaceSubtle],
  ] as const;
  const text = [
    ['primary text', color.textPrimary],
    ['secondary text', color.textSecondary],
    ['accent text', color.accent],
    ['danger text', color.danger],
    ['warning text', color.warning],
    ['success text', color.success],
  ] as const;
  const nonText = [
    ['focus ring', color.focusRing],
    ['strong border', color.borderStrong],
    ['working state', color.stateWorking],
    ['available state', color.stateAvailable],
    ['waiting state', color.stateWaiting],
    ['attention state', color.stateAttention],
    ['paused state', color.statePaused],
    ['offline state', color.stateOffline],
  ] as const;

  it.each(text.flatMap(([t, fg]) => surfaces.map(([s, bg]) => [`${t} on ${s}`, fg, bg] as const)))(
    '%s',
    (_label, foreground, background) => {
      expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(AA_TEXT);
    },
  );

  it.each(
    nonText.flatMap(([t, fg]) => surfaces.map(([s, bg]) => [`${t} on ${s}`, fg, bg] as const)),
  )('%s', (_label, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it.each([
    ['success', color.success, color.successSoft],
    ['warning', color.warning, color.warningSoft],
    ['danger', color.danger, color.dangerSoft],
  ])('keeps %s text readable on its soft background', (_label, foreground, background) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it('keeps text on the accent and on its hover readable', () => {
    expect(contrastRatio(color.textOnAccent, color.accent)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrastRatio(color.textOnAccent, mix(color.accent, 0.84, '#000000'))).toBeGreaterThan(
      contrastRatio(color.textOnAccent, color.accent),
    );
  });

  it('computes known reference ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('brand identity', () => {
  it('does not use green as a brand colour', () => {
    const brand = [color.accent, color.accentExpressive, color.highlight];
    expect(brand).not.toContain(palette.statusSuccess);
    expect(brand).not.toContain(palette.stateAvailable);
  });

  it('derives the accent tints from the accent, so a white-label colour carries them', () => {
    expect(color.accentHover).toContain('var(--mo-color-accent)');
    expect(color.accentSoft).toContain('var(--mo-color-accent)');
  });
});

describe('tokens.css', () => {
  const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

  it('declares exactly the variables derived from tokens.ts, with the same values', () => {
    // Formatters lowercase hex colours and wrap long values, so compare case- and
    // whitespace-insensitively.
    const normalize = (vars: Record<string, string>) =>
      Object.fromEntries(
        Object.entries(vars).map(([name, value]) => [
          name,
          value.replace(/\s+/g, ' ').trim().toLowerCase(),
        ]),
      );
    const declared = Object.fromEntries(
      [...css.matchAll(/(--mo-[\w-]+):\s*([^;]+);/g)].map(([, name = '', value = '']) => [
        name,
        value.trim(),
      ]),
    );
    expect(normalize(declared)).toEqual(normalize(cssVariables()));
  });
});
