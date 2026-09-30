import { describe, expect, it } from 'vitest';
import type { AgentState } from '../departments.js';
import {
  BUILDING_WIDTH,
  circuitLevel,
  corePoint,
  pulsesFor,
  routeLength,
  routeTo,
  tracePath,
} from './circuits.js';

const states = (entries: [AgentState, number][]) => new Map<AgentState, number>(entries);

describe('MelonMotor circuits', () => {
  it('carry only what the agents are really doing', () => {
    expect(circuitLevel(states([]))).toBe('off');
    expect(
      circuitLevel(
        states([
          ['paused', 2],
          ['offline', 1],
        ]),
      ),
    ).toBe('off');
    expect(circuitLevel(states([['available', 1]]))).toBe('ready');
    expect(
      circuitLevel(
        states([
          ['available', 1],
          ['working', 1],
        ]),
      ),
    ).toBe('busy');
    expect(
      circuitLevel(
        states([
          ['working', 2],
          ['attention', 1],
        ]),
      ),
    ).toBe('attention');
  });

  it('send one pulse per working agent, three at most, and none when nobody works', () => {
    expect(pulsesFor(states([['available', 4]]))).toBe(0);
    expect(pulsesFor(states([['working', 1]]))).toBe(1);
    expect(pulsesFor(states([['working', 5]]))).toBe(3);
  });

  it('run from the core through the gap between the rooms to the room screen', () => {
    const left = routeTo(2, 'left');
    const right = routeTo(0, 'right');
    expect(left[0]).toEqual(corePoint());
    expect(left[1]?.x).toBeCloseTo((BUILDING_WIDTH * 3) / 8);
    expect(left.at(-1)?.y).toBeCloseTo(229.5);
    expect(left.at(-1)?.x).toBeLessThan((BUILDING_WIDTH * 3) / 8);
    expect(right.at(-1)?.x).toBeGreaterThan((BUILDING_WIDTH * 5) / 8);
    expect(routeLength(left)).toBeGreaterThan(0);
  });

  it('cuts the corners like a circuit board', () => {
    const path = tracePath([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ]);
    expect(path).toBe('M0,0 L15,0 L20,5 L20,20');
  });
});
