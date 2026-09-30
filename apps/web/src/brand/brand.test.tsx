import { readFileSync } from 'node:fs';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Root } from '../Root.js';
import { applyBrand, loadPublicBrand, parsePublicBrand } from './brand.js';

/** The brand a host shows (ADR-0087): the API decides it; the page only applies what is safe. */
describe('the brand of this host', () => {
  afterEach(() => {
    cleanup();
    document.title = 'MelonOffice';
    document.documentElement.removeAttribute('style');
    document.head.querySelector('link[rel="icon"]')?.remove();
  });

  it('asks the API for this host and keeps only checked values', async () => {
    const asked: string[] = [];
    const fetcher = (async (url: string) => {
      asked.push(url);
      return new Response(
        JSON.stringify({
          context: 'organization',
          brand: {
            productName: 'A Office',
            faviconUrl: 'javascript:alert(1)',
            primaryColor: 'red',
          },
        }),
      );
    }) as typeof fetch;
    expect(await loadPublicBrand('https://api.example', 'app.a.example', fetcher)).toEqual({
      context: 'organization',
      productName: 'A Office',
    });
    expect(asked).toEqual(['https://api.example/v1/public/brand?host=app.a.example']);
    const failing = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch;
    expect(await loadPublicBrand('https://api.example', 'x.example', failing)).toBeUndefined();
    expect(parsePublicBrand({ context: 'tenant' })).toBeUndefined();
  });

  it('changes nothing for the platform, and applies a readable color only', () => {
    applyBrand({ context: 'platform', productName: 'Other' });
    expect(document.title).toBe('MelonOffice');
    applyBrand({
      context: 'organization',
      productName: 'A Office',
      faviconUrl: 'https://a.example/icon.png',
      primaryColor: '#ffff00',
    });
    expect(document.title).toBe('A Office');
    expect(document.head.querySelector('link[rel="icon"]')?.getAttribute('href')).toBe(
      'https://a.example/icon.png',
    );
    // Yellow under white text is unreadable: MelonOffice's color stays.
    expect(document.documentElement.style.getPropertyValue('--mo-color-accent')).toBe('');
    applyBrand({ context: 'organization', primaryColor: '#123abc' });
    const root = document.documentElement.style;
    expect(root.getPropertyValue('--mo-color-accent')).toBe('#123abc');
    expect(root.getPropertyValue('--mo-color-focus-ring')).toBe('#123abc');
    expect(root.getPropertyValue('--mo-color-accent-expressive')).toContain('#123abc');
  });

  it('keeps the accent in the tokens, so a brand reaches the signed-in app', () => {
    // Every screen reads the accent from packages/ui's tokens, which `applyBrand` sets: no
    // stylesheet keeps its own melon, and the old office palette is gone.
    for (const sheet of ['app.css', 'office.css', 'home.css']) {
      const css = readFileSync(`${import.meta.dirname}/../${sheet}`, 'utf8');
      expect(css).not.toMatch(/--office-/);
      expect(css).not.toMatch(/#(f2784b|e0643a|a8431e|e85d3a|ff8a5c|c0451d)\b/i);
      expect(css).not.toMatch(/rgb\(242 120 75/);
    }
  });

  it('names the product on the sign-in page by the brand of this host', async () => {
    render(
      <Root
        initialLocale="en"
        loadIdentity={() => Promise.resolve(undefined)}
        loadBrand={() => Promise.resolve({ context: 'organization', productName: 'A Office' })}
      />,
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'A Office' })).toBeTruthy();
    expect(document.title).toBe('A Office');
  });
});
