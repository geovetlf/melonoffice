// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The app's stylesheets take type from packages/ui's tokens (ADR-0107): sizes from the scale
 * (sizes relative to their parent in `em`, and fluid headline sizes, aside), tracking from the
 * tight and wide amounts, and no text smaller than the smallest size.
 */
describe('type in the stylesheets', () => {
  const sheets = ['app.css', 'office.css', 'home.css'].map((name) => ({
    name,
    css: readFileSync(`${import.meta.dirname}/${name}`, 'utf8'),
  }));

  it.each(sheets)('$name sets sizes from the type scale', ({ css }) => {
    expect(css).not.toMatch(/font-size:\s*[\d.]+(rem|px)\s*;/);
  });

  it.each(sheets)('$name never lets fluid text shrink below the smallest size', ({ css }) => {
    // Headlines may grow fluidly; the floor of a fluid size is the scale's smallest or more.
    const floors = [...css.matchAll(/font-size:\s*clamp\(\s*([\d.]+)rem\s*,/g)].map((m) =>
      Number(m[1]),
    );
    for (const floor of floors) expect(floor).toBeGreaterThanOrEqual(0.6875);
  });

  it.each(sheets)('$name sets tracking from the tokens', ({ css }) => {
    expect(css).not.toMatch(/letter-spacing:\s*-?[\d.]+(em|px|rem)\s*;/);
  });

  it.each(sheets)('$name stacks overlays on the layer tokens', ({ css }) => {
    // Small values order parts of one drawing; anything that floats over the page uses a layer.
    const raw = [...css.matchAll(/z-index:\s*(\d+)\s*;/g)].map((m) => Number(m[1]));
    for (const value of raw) expect(value).toBeLessThan(10);
  });
});
