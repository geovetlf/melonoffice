// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast.js';
import { color, cssVariables, palette } from './tokens.js';

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

describe('contrast (WCAG 2.2 AA)', () => {
  it.each([
    ['primary text on surface', color.textPrimary, color.surface, AA_TEXT],
    ['primary text on subtle surface', color.textPrimary, color.surfaceSubtle, AA_TEXT],
    ['secondary text on surface', color.textSecondary, color.surface, AA_TEXT],
    ['secondary text on subtle surface', color.textSecondary, color.surfaceSubtle, AA_TEXT],
    ['text on accent (primary button)', color.textOnAccent, color.accent, AA_TEXT],
    ['text on accent hover', color.textOnAccent, color.accentHover, AA_TEXT],
    ['sidebar text on sidebar', color.sidebarText, color.sidebarBackground, AA_TEXT],
    ['focus ring on surface', color.focusRing, color.surface, AA_NON_TEXT],
    ['focus ring on subtle surface', color.focusRing, color.surfaceSubtle, AA_NON_TEXT],
    ['danger text on surface', color.danger, color.surface, AA_TEXT],
    ['warning text on surface', color.warning, color.surface, AA_TEXT],
    ['success text on surface', color.success, color.surface, AA_TEXT],
  ])('%s', (_label, foreground, background, minimum) => {
    expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(minimum);
  });

  it('computes known reference ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('brand identity', () => {
  it('does not use green as a brand colour', () => {
    const brand = [color.accent, color.accentDecorative, color.highlight, palette.coral400];
    expect(brand).not.toContain(palette.statusSuccess);
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
