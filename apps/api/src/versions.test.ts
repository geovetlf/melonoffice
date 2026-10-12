import { describe, expect, it } from 'vitest';
import { versionAfter } from './versions.js';

describe('versionAfter', () => {
  it('is the clock when the clock is later', () => {
    expect(versionAfter('2026-10-12T02:00:00.000Z', new Date('2026-10-12T02:00:00.005Z'))).toBe(
      '2026-10-12T02:00:00.005Z',
    );
  });

  it('moves one millisecond past the last version in the same millisecond or a clock behind', () => {
    expect(versionAfter('2026-10-12T02:00:00.000Z', new Date('2026-10-12T02:00:00.000Z'))).toBe(
      '2026-10-12T02:00:00.001Z',
    );
    expect(versionAfter('2026-10-12T02:00:00.000Z', new Date('2026-10-12T01:59:59.000Z'))).toBe(
      '2026-10-12T02:00:00.001Z',
    );
  });

  it('is the clock for a first version', () => {
    expect(versionAfter(undefined, new Date('2026-10-12T02:00:00.000Z'))).toBe(
      '2026-10-12T02:00:00.000Z',
    );
  });
});
