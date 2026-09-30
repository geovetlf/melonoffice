import { describe, expect, it } from 'vitest';
import type { AgentState } from '../departments.js';
import {
  cellKey,
  circuitLevel,
  network,
  pulsesFor,
  routeLength,
  tracePath,
  type Rect,
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

  it('run from the hub between GIA and MelonMotor along the gaps into each room', () => {
    // Three rows of rooms 100 tall, 10 apart: side rooms 180 wide, the centre 120.
    const cells = new Map<string, Rect>();
    for (let row = 0; row < 3; row += 1) {
      cells.set(cellKey(row, 0), { x: 0, y: row * 110, w: 180, h: 100 });
      cells.set(cellKey(row, 1), { x: 190, y: row * 110, w: 120, h: 100 });
      cells.set(cellKey(row, 2), { x: 320, y: row * 110, w: 180, h: 100 });
    }
    const net = network(cells);
    expect(net?.hub).toEqual({ x: 250, y: 215 });
    const left = net?.routeTo(0, 0) ?? [];
    expect(left[0]).toEqual({ x: 250, y: 215 });
    expect(left[1]).toEqual({ x: 185, y: 215 });
    expect(left.at(-1)).toEqual({ x: 177, y: 50 });
    const right = net?.routeTo(2, 2) ?? [];
    expect(right.at(-1)).toEqual({ x: 323, y: 270 });
    // Consejo, above GIA, is reached from below.
    expect(net?.routeTo(0, 1)?.at(-1)?.y).toBe(97);
    expect(routeLength(left)).toBeGreaterThan(0);
    // Without GIA's and MelonMotor's rooms laid out there is no network yet.
    expect(network(new Map())).toBeUndefined();
  });

  it('cuts the corners like a circuit board', () => {
    const path = tracePath([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
    ]);
    expect(path).toBe('M0,0 L12,0 L20,8 L20,20');
  });
});
