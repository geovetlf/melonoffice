import { flushSync } from 'react-dom';
import { navigate } from '../identity/router.js';

/**
 * Entering a room (ADR-0040): the room the person chose grows into the whole office, with the
 * browser's view transitions. Only transform and opacity animate, it takes a fraction of a
 * second, and navigation never waits for it. Without support, or when the person asked for
 * reduced motion, it is a plain navigation.
 */

interface ViewTransitionDocument {
  startViewTransition?: (update: () => void) => unknown;
}

export function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/** The name both the room on the Home and the entered office carry, so one becomes the other. */
export const ROOM_TRANSITION = 'mo-room';

export function navigateInto(path: string, room?: HTMLElement | null): void {
  const doc = globalThis.document as (Document & ViewTransitionDocument) | undefined;
  if (doc?.startViewTransition === undefined || prefersReducedMotion()) {
    navigate(path);
    return;
  }
  if (room) room.style.viewTransitionName = ROOM_TRANSITION;
  doc.startViewTransition(() => {
    if (room) room.style.viewTransitionName = '';
    flushSync(() => navigate(path));
  });
}
