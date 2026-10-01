import { describe, expect, it } from 'vitest';
import {
  DESKS,
  GIA_ROUTES,
  LOGO,
  SCENE_ART,
  SEATS,
  WALL_PANELS,
  within,
  type SceneBox,
  type ScenePoint,
} from './officeScene.js';

const inBounds = ([x, y]: ScenePoint) => x >= 0 && x <= 1 && y >= 0 && y <= 1;
const boxInBounds = ([l, t, r, b]: SceneBox) =>
  l >= 0 && t >= 0 && r <= 1 && b <= 1 && l < r && t < b;

describe('the office’s places (officeScene.ts)', () => {
  it('has seven desks: GIA’s and the six real functions, each once', () => {
    expect([...DESKS].sort()).toEqual(Object.keys(SEATS).sort());
    expect(DESKS).toHaveLength(7);
    expect(Object.values(SEATS).map((seat) => seat.department)).toEqual([
      null,
      'sales',
      'operations',
      'finance',
      'marketing',
      'research',
      'leadership',
    ]);
    // Design & Video is part of Marketing (ADR-0047): no desk for it.
    expect(Object.values(SEATS).some((seat) => seat.department === 'design_video')).toBe(false);
  });

  it('keeps every place inside the picture, each person at their own desk', () => {
    expect(SCENE_ART.desktop.width / SCENE_ART.desktop.height).toBeCloseTo(2.169, 2);
    for (const seat of Object.values(SEATS)) {
      for (const box of [seat.figure, seat.desk, seat.plate]) expect(boxInBounds(box)).toBe(true);
      expect(inBounds(seat.person)).toBe(true);
      expect(within(seat.person, seat.figure)).toBe(true);
    }
    for (const box of [WALL_PANELS.left, WALL_PANELS.right, LOGO.box]) {
      expect(boxInBounds(box)).toBe(true);
    }
  });

  it('routes GIA from her chair to each desk over open floor, never across another desk', () => {
    for (const [key, route] of Object.entries(GIA_ROUTES)) {
      const to = SEATS[key as keyof typeof GIA_ROUTES];
      expect(route[0]).toEqual(SEATS.gia.person);
      expect(route.at(-1)).toEqual(to.stand);
      // Where she stands is beside the desk, not on it.
      expect(within(to.stand, to.desk)).toBe(false);
      for (let i = 1; i < route.length; i += 1) {
        const [ax, ay] = route[i - 1] ?? [0, 0];
        const [bx, by] = route[i] ?? [0, 0];
        for (let t = 0; t <= 1; t += 0.02) {
          const point: ScenePoint = [ax + (bx - ax) * t, ay + (by - ay) * t];
          expect(inBounds(point)).toBe(true);
          for (const [other, seat] of Object.entries(SEATS)) {
            // Her own desk is the one she leaves, by its back: only the first leg is on it.
            if (other === 'gia' && i === 1) continue;
            expect(within(point, seat.desk), `${key} crosses ${other} at ${point.join(',')}`).toBe(
              false,
            );
          }
        }
      }
    }
  });
});
