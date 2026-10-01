import { useEffect, useEffectEvent, useRef, useState, type CSSProperties } from 'react';
import { GiaFigure, type GiaView } from '../../gia/character.js';
import { samePlace, type GiaActivity, type GiaPlace, type GiaTarget } from '../../gia/presence.js';
import { distance, PERSON_HEIGHT, type Leg, type PlanRoom, type WalkPlan } from './officeWalk.js';

/**
 * GIA in the Home's office: where the records put her (`gia/presence.ts`) and, when that changes
 * while the office is on screen, her walk there along the office's walkways and lifts
 * (`officeWalk.ts`). While she stands somewhere she is drawn inside that room, among its desks
 * and under its signs; while she walks she is drawn over the office, on the walkways.
 *
 * She walks only when her place really changes. With reduced motion, on a phone (where the rooms
 * are a list) or before the office is laid out, she is simply in the new place.
 */

export interface GiaWalk {
  readonly legs: readonly Leg[];
  readonly to: GiaPlace;
}

/** How fast she goes, in her own heights per second: on foot, and standing in a lift. */
const PACE = { walk: 2.2, lift: 1.5 } as const;

export function useGiaWalk(
  target: GiaTarget,
  plan: WalkPlan | undefined,
  roomOf: (place: GiaPlace) => PlanRoom | undefined,
  reduced: boolean,
) {
  const [settled, setSettled] = useState<GiaPlace>(target.place);
  const [walk, setWalk] = useState<GiaWalk | null>(null);
  // When the records move her, she sets off (React's adjust-on-change pattern, during render). A
  // walk under way ends first; then she sets off again if the records moved her meanwhile.
  if (walk === null && !samePlace(settled, target.place)) {
    const from = roomOf(settled);
    const to = roomOf(target.place);
    const legs =
      reduced || plan === undefined || from === undefined || to === undefined
        ? undefined
        : plan.route(from, to);
    if (legs === undefined || legs.length === 0) setSettled(target.place);
    else setWalk({ legs, to: target.place });
  }
  const arrive = () => {
    if (walk === null) return;
    setSettled(walk.to);
    setWalk(null);
  };
  return { settled: walk === null ? settled : null, walk, arrive };
}

/** What she is doing now, her walk included. */
export function activityOf(target: GiaTarget, walk: GiaWalk | null, leg: number): GiaActivity {
  if (walk === null) return target.activity;
  if (walk.to.kind === 'home') return 'returning';
  return leg >= walk.legs.length - 1 ? 'arriving' : 'walking';
}

/** The side she shows on a stretch of her walk. */
export function viewFor(leg: Leg): GiaView {
  if (leg.kind === 'lift') return 'front';
  const dx = leg.to.x - leg.from.x;
  const dy = leg.to.y - leg.from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'profile-right' : 'profile-left';
  return dy < 0 ? 'back' : 'walk-toward';
}

/** The side she shows where she stands, by what she does there. */
export function viewAt(activity: GiaActivity, home: boolean): GiaView {
  if (home) return 'front';
  return activity === 'working' ? 'three-quarter' : 'front';
}

/**
 * GIA on her way, over the office: she follows her legs one after the other, at a person's
 * pace, the lift's cabin carrying her between storeys. `lift` finds a shaft's cabin.
 */
export function GiaWalker({
  walk,
  person,
  lift,
  onLeg,
  onArrive,
}: {
  readonly walk: GiaWalk;
  /** Her height, in the office's pixels. */
  readonly person: number;
  readonly lift: (shaft: 'left' | 'right') => HTMLElement | null;
  readonly onLeg: (leg: number) => void;
  readonly onArrive: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<GiaView>(() => {
    const first = walk.legs[0];
    return first === undefined ? 'front' : viewFor(first);
  });
  // The latest callbacks, so a re-render never restarts her walk.
  const done = useEffectEvent(onArrive);
  const step = useEffectEvent(onLeg);
  useEffect(() => {
    const element = body.current;
    if (element === null) return undefined;
    let live = true;
    const running: Animation[] = [];
    const go = async () => {
      for (const [i, leg] of walk.legs.entries()) {
        if (!live) return;
        setView(viewFor(leg));
        step(i);
        const duration = Math.max(
          240,
          (distance(leg.from, leg.to) / (person * PACE[leg.kind])) * 1000,
        );
        const timing: KeyframeAnimationOptions = {
          duration,
          easing: leg.kind === 'lift' ? 'ease-in-out' : 'linear',
          fill: 'forwards',
        };
        const moving = element.animate(
          [{ transform: at(leg.from) }, { transform: at(leg.to) }],
          timing,
        );
        running.push(moving);
        const cabin = leg.shaft === undefined ? null : lift(leg.shaft);
        if (cabin !== null) {
          running.push(
            cabin.animate(
              [
                { transform: 'translateY(0)' },
                { transform: `translateY(${leg.to.y - leg.from.y}px)` },
              ],
              timing,
            ),
          );
        }
        await moving.finished;
      }
      if (live) done();
    };
    go().catch(() => {
      // Cancelled: the office went away mid-walk.
    });
    return () => {
      live = false;
      for (const animation of running) animation.cancel();
    };
  }, [walk, person, lift]);
  const first = walk.legs[0];
  return (
    <div
      ref={body}
      className="gia-walker"
      aria-hidden="true"
      data-moving=""
      style={{ transform: first === undefined ? undefined : at(first.from) }}
    >
      <GiaFigure view={view} height={`${person}px`} eager />
    </div>
  );
}

const at = (point: { readonly x: number; readonly y: number }) =>
  `translate(${point.x.toFixed(1)}px, ${point.y.toFixed(1)}px)`;

/**
 * GIA standing in a room, drawn inside it: at a point of the room's picture, at a person's height
 * in it, whatever the room's shape (the picture covers the room).
 */
export function GiaHere({
  point,
  aspect,
  view,
}: {
  readonly point: readonly [number, number];
  /** The room's picture's width over its height. */
  readonly aspect: number;
  readonly view: GiaView;
}) {
  return (
    <span
      className="b-gia-here"
      aria-hidden="true"
      style={
        {
          '--gx': point[0],
          '--gy': point[1],
          '--aspect': aspect,
          '--person': PERSON_HEIGHT,
        } as CSSProperties
      }
    >
      <GiaFigure view={view} height="var(--gia-height)" className="b-gia-here__figure" eager />
    </span>
  );
}
