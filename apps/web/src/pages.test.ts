// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every page but the Home speaks the same language (phase 5): the page components of
 * packages/ui, not classes borrowed from another page or the old one-off states. This keeps
 * them from coming back.
 */
const root = import.meta.dirname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'preview' ? [] : sources(path);
    return path.endsWith('.tsx') && !path.endsWith('.test.tsx') ? [path] : [];
  });
}

/** The Home and what it renders keep their own parts (ADR-0109). */
const HOME = [
  'home/',
  'activity/ActivityFeed.tsx',
  'gia/GiaQuickAsk.tsx',
  'office/scene/',
  'shell/',
];
/** Pages whose one h1 is drawn outside PageHeader, and why (filled in below). */
const OWN_H1: ReadonlySet<string> = new Set<string>([]);

const pages = sources(root)
  .map((path) => ({ file: relative(root, path), code: readFileSync(path, 'utf8') }))
  .filter(({ file }) => !HOME.some((prefix) => file.startsWith(prefix)));

const classes = (code: string) =>
  [...code.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)].flatMap((m) =>
    (m[1] ?? m[2] ?? '').split(/\s+/),
  );

describe('the secondary pages', () => {
  it.each(pages)('$file shows its states with StateMessage', ({ code }) => {
    expect(classes(code)).not.toContain('panel__empty');
    expect(classes(code).filter((c) => c === 'notice' || c.startsWith('notice--'))).toEqual([]);
  });

  it.each(pages)('$file picks a period with PeriodPicker', ({ code }) => {
    expect(classes(code)).not.toContain('period-picker');
  });

  it.each(pages)('$file borrows no other page’s classes', ({ file, code }) => {
    const own = file.split('/')[0];
    const borrowed = classes(code).filter((c) => {
      const block = /^([a-z-]+)__/.exec(c)?.[1] ?? (c === 'approval-card' ? 'approvals' : '');
      const owner: Record<string, string> = {
        'dept-office': 'office',
        documents: 'documents',
        customers: 'customers',
        connections: 'connections',
        'ai-usage': 'aiUsage',
        memory: 'memory',
        approvals: 'approvals',
      };
      return owner[block] !== undefined && owner[block] !== own;
    });
    expect(borrowed).toEqual([]);
  });

  it.each(pages)('$file draws its h1 with PageHeader', ({ file, code }) => {
    if (OWN_H1.has(file)) return;
    expect(code).not.toMatch(/<h1\b/);
  });
});
