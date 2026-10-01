// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DESKS } from './officeScene.js';

const web = `${import.meta.dirname}/../../..`;

/**
 * The office's people are pictures of their own, laid over the empty office (`OfficeStage`): GIA
 * at her desk and every real agent at theirs. A picture the browser refuses is a person missing
 * from the Home with no error on the page, so these hold how they reach it.
 */
describe("the office's people", () => {
  it('has a picture of the person at each of the six desks, and none standing for GIA', () => {
    for (const desk of DESKS.filter((key) => key !== 'gia')) {
      expect(existsSync(`${import.meta.dirname}/art/people/${desk}.webp`), desk).toBe(true);
    }
    // The person the render drew at the centre desk is not GIA: GIA is her official figure.
    expect(existsSync(`${import.meta.dirname}/art/people/gia.webp`)).toBe(false);
  });

  it('names nobody: the office’s people are pictures, never made-up names', () => {
    for (const file of ['OfficeStage.tsx', 'officeScene.ts']) {
      const source = readFileSync(`${import.meta.dirname}/${file}`, 'utf8');
      expect(source, file).not.toMatch(/\bAna\b/);
    }
  });

  it('reach the browser as files, which the web server’s policy allows, never as data: URIs', () => {
    // The server allows pictures from its own origin only (`default-src 'self'`, no `data:`):
    // Vite would inline a picture under 4 KB, as most people are, and the browser refuse it.
    const nginx = readFileSync(`${web}/nginx.conf.template`, 'utf8');
    const policies = [...nginx.matchAll(/Content-Security-Policy "([^"]+)"/g)].map((m) => m[1]);
    expect(policies.length).toBeGreaterThan(0);
    for (const policy of policies) expect(policy).not.toContain('data:');
    const vite = readFileSync(`${web}/vite.config.ts`, 'utf8');
    expect(vite).toMatch(/assetsInlineLimit:\s*0\b/);
  });
});
