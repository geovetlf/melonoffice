import { describe, expect, it } from 'vitest';
import { cellKey, type Rect } from './circuits.js';
import { activityOf, viewFor } from './GiaInOffice.js';
import { distance, walkPlan, type Leg } from './officeWalk.js';

/** The office as laid out on a computer: 10 : 0.9 : 7 : 0.9 : 10 columns, walkways between. */
function block(floors = 3) {
  const unit = 30;
  const side = 10 * unit;
  const shaft = 0.9 * unit;
  const centre = 7 * unit;
  const room = side / 1.8;
  const walk = room * 0.16;
  const xs = [0, side + shaft, side + shaft + centre + shaft];
  const ws = [side, centre, side];
  const cells = new Map<string, Rect>();
  for (let row = 0; row < floors; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      cells.set(cellKey(row, column), {
        x: must(xs[column]),
        y: row * (room + walk),
        w: must(ws[column]),
        h: room,
      });
    }
  }
  return { cells, height: floors * (room + walk), room, walk };
}

/** The value, which the test expects to be there. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

const inside = (r: Rect, p: { x: number; y: number }) =>
  p.x > r.x + 0.5 && p.x < r.x + r.w - 0.5 && p.y > r.y + 0.5 && p.y < r.y + r.h - 0.5;

describe('walking around the office (officeWalk.ts)', () => {
  const { cells, height, room } = block();
  const plan = must(walkPlan(cells, height));

  it('only exists when the rooms are laid out as a block', () => {
    expect(plan).toBeDefined();
    const list = new Map([...cells].map(([key, r]) => [key, { ...r, x: 0 }]));
    expect(walkPlan(list, height)).toBeUndefined();
  });

  it('draws a person the same height on every storey, a third of a room or so', () => {
    expect(plan.person).toBeCloseTo(room * 0.36, 1);
  });

  it('goes from GIA’s platform to Comercial on foot and by lift, every leg joined to the next', () => {
    const legs = must(plan.route({ row: 1, column: 1 }, { row: 0, column: 0 }));
    expect(legs.map((leg) => leg.kind)).toEqual(['walk', 'walk', 'lift', 'walk', 'walk']);
    for (let i = 1; i < legs.length; i += 1) {
      expect(distance(must(legs[i - 1]).to, must(legs[i]).from)).toBeLessThan(0.01);
    }
    expect(must(legs[0]).from).toEqual(plan.spot({ row: 1, column: 1 }));
    expect(must(legs.at(-1)).to).toEqual(plan.spot({ row: 0, column: 0 }));
    // The lift runs straight up its shaft, on the side of the room she goes to.
    const lift = must(legs[2]);
    expect(lift.shaft).toBe('left');
    expect(lift.from.x).toBe(plan.shafts.left);
    expect(lift.to.x).toBe(plan.shafts.left);
    expect(lift.to.y).toBeLessThan(lift.from.y);
  });

  it('walks straight or straight across: no leg is diagonal', () => {
    const legs = must(plan.route({ row: 1, column: 1 }, { row: 2, column: 2 }));
    for (const leg of legs) {
      expect(leg.from.x === leg.to.x || leg.from.y === leg.to.y).toBe(true);
    }
  });

  it('never crosses a room on the way: she only leaves the room she is in and enters hers', () => {
    const rooms = [...cells.values()];
    const check = (legs: readonly Leg[], from: Rect, to: Rect) => {
      for (const leg of legs.slice(1, -1)) {
        for (let t = 0; t <= 1; t += 0.05) {
          const p = {
            x: leg.from.x + (leg.to.x - leg.from.x) * t,
            y: leg.from.y + (leg.to.y - leg.from.y) * t,
          };
          for (const r of rooms) {
            if (r === from || r === to) continue;
            expect(inside(r, p), `crosses a room at ${p.x},${p.y}`).toBe(false);
          }
        }
      }
    };
    const all = [0, 1, 2].flatMap((row) => [0, 1, 2].map((column) => ({ row, column })));
    for (const from of all) {
      for (const to of all) {
        if (from.row === to.row && from.column === to.column) continue;
        const legs = plan.route(from, to);
        expect(legs).toBeDefined();
        check(
          must(legs),
          must(cells.get(cellKey(from.row, from.column))),
          must(cells.get(cellKey(to.row, to.column))),
        );
      }
    }
  });

  it('stays on her storey for a room beside her: no lift', () => {
    const legs = must(plan.route({ row: 1, column: 1 }, { row: 1, column: 2 }));
    expect(legs.some((leg) => leg.kind === 'lift')).toBe(false);
  });
});

describe('the side GIA shows (GiaInOffice.tsx)', () => {
  const leg = (dx: number, dy: number, kind: Leg['kind'] = 'walk'): Leg => ({
    kind,
    from: { x: 100, y: 100 },
    to: { x: 100 + dx, y: 100 + dy },
  });

  it('faces the way she walks, her back when she steps into a room, her front in a lift', () => {
    expect(viewFor(leg(40, 0))).toBe('profile-right');
    expect(viewFor(leg(-40, 0))).toBe('profile-left');
    expect(viewFor(leg(0, -20))).toBe('back');
    expect(viewFor(leg(0, 20))).toBe('walk-toward');
    expect(viewFor(leg(0, -80, 'lift'))).toBe('front');
  });

  it('says she walks, arrives or returns only while she is on her way', () => {
    const target = { place: { kind: 'home' }, activity: 'idle', coordinating: 0 } as const;
    const out = {
      legs: [leg(0, 20), leg(40, 0), leg(0, -20)],
      to: { kind: 'department', departmentId: 'd', agentId: 'a' },
    } as const;
    expect(activityOf(target, null, 0)).toBe('idle');
    expect(activityOf(target, out, 0)).toBe('walking');
    expect(activityOf(target, out, 2)).toBe('arriving');
    expect(activityOf(target, { ...out, to: { kind: 'home' } }, 0)).toBe('returning');
  });
});
