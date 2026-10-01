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

/**
 * Motion shows real work or answers a person (ADR-0109, phase 6): a live screen, a work bar, an
 * agent typing, a desk's light, a room's data, GIA walking where the work is, and a sheet opening. Anything else is decoration,
 * and every looping animation stops with `prefers-reduced-motion: reduce`.
 */
describe('motion in the stylesheets', () => {
  const WORK = [
    'wall-screen-refresh',
    'wall-screen-work',
    'desk-typing',
    'desk-light',
    'room-data',
    // GIA's steps, only while she really walks somewhere (`GiaInOffice.tsx`).
    'gia-step',
    // The MelonOffice mark's slow breath on the office's glass wall, asked for by the owner
    // (`OfficeStage.tsx`); it stops with reduced motion like every loop.
    'stage-logo-breath',
  ];
  const ANSWERS = ['sheet-in', 'sheet-up'];
  const sheets = ['app.css', 'office.css', 'home.css'].map((name) => ({
    name,
    css: readFileSync(`${import.meta.dirname}/${name}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
  }));

  /** The body of the first `@media <query>` block, braces balanced. */
  const block = (css: string, query: string): string => {
    const start = css.indexOf(`@media ${query}`);
    if (start === -1) return '';
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      if (css[i] === '}' && (depth -= 1) === 0) return css.slice(start, i + 1);
    }
    return '';
  };

  it.each(sheets)('$name animates only work and answers', ({ css }) => {
    const names = [...css.matchAll(/animation:\s*([a-z][\w-]*)/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'none');
    for (const name of names) expect([...WORK, ...ANSWERS]).toContain(name);
  });

  it.each(sheets)('$name stops every loop with reduced motion', ({ css }) => {
    const reduced = block(css, '(prefers-reduced-motion: reduce)');
    const welcome = block(css, '(prefers-reduced-motion: no-preference)');
    const loops = [...css.matchAll(/([^{}]+)\{[^{}]*animation:[^;]*infinite[^}]*\}/g)];
    for (const [rule, selectors] of loops) {
      if (welcome.includes(rule)) continue;
      const stopped = (selectors ?? '')
        .split(',')
        .map((s) => s.trim())
        .every(
          (selector) =>
            reduced.includes(selector) ||
            // A room's data runs on a department room's ::before, which the block stops whole.
            (/^\.b-room--(working|attention)::before$/.test(selector) &&
              reduced.includes('.b-room--department::before')),
        );
      expect(stopped, `${selectors?.trim()} keeps moving with reduced motion`).toBe(true);
    }
  });
});

/** Keyboard focus and touch targets (phase 6). */
describe('focus and targets in the stylesheets', () => {
  const office = readFileSync(`${import.meta.dirname}/office.css`, 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const home = readFileSync(`${import.meta.dirname}/home.css`, 'utf8');
  const ui = readFileSync(`${import.meta.dirname}/../../../packages/ui/src/components.css`, 'utf8');

  it('gives a ring back to every field that hides its own', () => {
    const hidden = [...office.matchAll(/([^{}]+):focus-visible\s*\{[^}]*outline:\s*none/g)].map(
      (m) => (m[1] ?? '').trim(),
    );
    expect(hidden.length).toBeGreaterThan(0);
    const RING = /outline:\s*var\(--mo-state-focus-ring-width\) solid var\(--mo-color-focus-ring\)/;
    for (const field of hidden) {
      const rings = [...office.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(
        ([, selector, body]) =>
          (selector ?? '').includes(`${field.split(' ').at(-1)}:focus-visible`) &&
          RING.test(body ?? ''),
      );
      expect(rings.length, `${field} hides its ring and nothing gives it back`).toBeGreaterThan(0);
    }
  });

  it('makes the shell and the Home 44 px tall to the touch, and the toolkit too', () => {
    const touch = '@media (max-width: 48rem), (pointer: coarse)';
    expect(office).toContain(touch);
    const shell = office.slice(office.indexOf(touch));
    for (const control of [
      '.sidebar__item',
      '.notifications__item',
      '.gia-bar__input',
      '.panel__link',
      '.user-menu > summary',
      '.task__body',
    ]) {
      expect(shell).toContain(control);
    }
    expect(shell).toContain('var(--mo-min-target-size)');
    expect(home.slice(home.lastIndexOf(touch))).toContain('.gia-suggest__item');
    const kit = ui.slice(ui.indexOf(touch));
    for (const control of ['.mo-chip', '.mo-button--sm', '.mo-segmented > button']) {
      expect(kit).toContain(control);
    }
  });
});
