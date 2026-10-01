import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Zoom and pan for the office's picture (`OfficeStage`), with no library: the picture and every
 * layer over it sit in one "world" that is moved and scaled as one, so a desk stays on its desk
 * at any zoom.
 *
 * - The world covers the frame (it is the picture's size at the frame's scale): on a computer the
 *   whole office shows; on a phone the frame is taller, the sides go past it and can be dragged in.
 * - The wheel zooms where the pointer is: always where the Home fits the window (it does not
 *   scroll there), else with Ctrl (a trackpad's pinch) or once zoomed in, so the page still scrolls.
 * - Two fingers pinch; one finger or the mouse drags once there is somewhere to go. A drag never
 *   counts as a click on a desk.
 * - The buttons (`zoomIn`, `zoomOut`, `reset`) do the same from the keyboard, and whatever the
 *   keyboard reaches in the office (a desk) is brought into view.
 * - Nothing glides: every change is applied at once, so reduced motion has nothing to stop.
 */

/** The Home fits the window here (home.css): the page does not scroll, the wheel can zoom. */
const FITS = '(min-width: 64rem) and (min-height: 36rem)';
/** How far a press may move and still be a click. */
const SLOP = 6;
/** How much a button press zooms. */
const STEP = 1.5;

interface Controls {
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly reset: () => void;
}

export function useStageZoom(aspect: number, maxZoom: number) {
  /** The frame the office is seen through, and the world in it that zooms and pans. */
  const frame = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const controls = useRef<Controls | null>(null);

  useLayoutEffect(() => {
    const element = frame.current;
    const inner = world.current;
    if (element === null || inner === null) return undefined;

    /** The scale (1 = the picture covering the frame) and the world's corner in the frame. */
    let view = { s: 1, x: 0, y: 0 };
    let size = { fw: 0, fh: 0, aw: 0, ah: 0 };
    /** True after a drag or a pinch, until the click that ends it is swallowed. */
    let moved = false;

    const apply = () => {
      inner.style.transform = `translate(${view.x.toFixed(1)}px, ${view.y.toFixed(1)}px) scale(${view.s.toFixed(4)})`;
      setScale(Math.round(view.s * 100) / 100);
    };
    /** Keeps the world over the whole frame (or centred, on an axis where it is smaller). */
    const set = (next: { s: number; x: number; y: number }) => {
      const w = size.aw * next.s;
      const h = size.ah * next.s;
      view = {
        s: next.s,
        x: w >= size.fw ? Math.min(0, Math.max(size.fw - w, next.x)) : (size.fw - w) / 2,
        y: h >= size.fh ? Math.min(0, Math.max(size.fh - h, next.y)) : (size.fh - h) / 2,
      };
      apply();
    };
    /** Zooms by `factor` keeping the frame's point (`px`, `py`) where it is. */
    const zoomAt = (factor: number, px: number, py: number) => {
      const next = Math.min(maxZoom, Math.max(1, view.s * factor));
      const k = next / view.s;
      set({ s: next, x: px - (px - view.x) * k, y: py - (py - view.y) * k });
    };

    // The world's size follows the frame's: the picture covering it, at its own shape.
    const layout = () => {
      const fw = element.clientWidth;
      const fh = element.clientHeight;
      if (fw === 0 || fh === 0 || (fw === size.fw && fh === size.fh)) return;
      const aw = Math.max(fw, fh * aspect);
      size = { fw, fh, aw, ah: aw / aspect };
      inner.style.width = `${size.aw}px`;
      inner.style.height = `${size.ah}px`;
      set({ s: view.s, x: (fw - size.aw * view.s) / 2, y: (fh - size.ah * view.s) / 2 });
    };
    layout();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(layout) : undefined;
    observer?.observe(element);

    const local = (x: number, y: number) => {
      const box = element.getBoundingClientRect();
      return { px: x - box.left, py: y - box.top };
    };

    const wheel = (event: WheelEvent) => {
      const fits = globalThis.matchMedia?.(FITS).matches === true;
      if (!event.ctrlKey && !fits && view.s <= 1) return;
      event.preventDefault();
      const { px, py } = local(event.clientX, event.clientY);
      zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), px, py);
    };

    const pointers = new Map<number, { x: number; y: number }>();
    let start: { x: number; y: number; vx: number; vy: number } | undefined;
    let pinch: { d: number; s: number } | undefined;
    const spread = () => {
      const [a, b] = [...pointers.values()];
      return a === undefined || b === undefined
        ? undefined
        : { d: Math.hypot(b.x - a.x, b.y - a.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    };

    const down = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      moved = false;
      start = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
      const two = spread();
      if (two !== undefined) pinch = { d: two.d, s: view.s };
    };

    const move = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const two = spread();
      if (two !== undefined && pinch !== undefined && pinch.d > 0) {
        moved = true;
        const { px, py } = local(two.mx, two.my);
        zoomAt((pinch.s * (two.d / pinch.d)) / view.s, px, py);
        return;
      }
      if (start === undefined) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (!moved && Math.hypot(dx, dy) < SLOP) return;
      // Only where there is somewhere to go: a page scroll stays a page scroll.
      if (size.aw * view.s <= size.fw + 0.5 && size.ah * view.s <= size.fh + 0.5) return;
      if (!moved) element.setPointerCapture?.(event.pointerId);
      moved = true;
      set({ s: view.s, x: start.vx + dx, y: start.vy + dy });
    };

    const up = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
      if (pointers.size < 2) pinch = undefined;
      const [rest] = [...pointers.values()];
      // One finger left after a pinch drags from where it is.
      start = rest === undefined ? undefined : { x: rest.x, y: rest.y, vx: view.x, vy: view.y };
    };

    const click = (event: MouseEvent) => {
      if (!moved) return;
      moved = false;
      event.preventDefault();
      event.stopPropagation();
    };

    // Whatever the keyboard reaches in the office is brought into view.
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || !inner.contains(event.target)) return;
      const box = element.getBoundingClientRect();
      const at = event.target.getBoundingClientRect();
      const margin = 8;
      let { x, y } = view;
      if (at.left < box.left + margin) x += box.left + margin - at.left;
      else if (at.right > box.right - margin) x -= at.right - (box.right - margin);
      if (at.top < box.top + margin) y += box.top + margin - at.top;
      else if (at.bottom > box.bottom - margin) y -= at.bottom - (box.bottom - margin);
      if (x !== view.x || y !== view.y) set({ s: view.s, x, y });
    };

    const centre = () => ({ px: size.fw / 2, py: size.fh / 2 });
    controls.current = {
      zoomIn: () => {
        const { px, py } = centre();
        zoomAt(STEP, px, py);
      },
      zoomOut: () => {
        const { px, py } = centre();
        zoomAt(1 / STEP, px, py);
      },
      reset: () => set({ s: 1, x: (size.fw - size.aw) / 2, y: (size.fh - size.ah) / 2 }),
    };

    element.addEventListener('wheel', wheel, { passive: false });
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', up);
    element.addEventListener('click', click, true);
    element.addEventListener('focusin', focus);
    return () => {
      observer?.disconnect();
      controls.current = null;
      element.removeEventListener('wheel', wheel);
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', up);
      element.removeEventListener('click', click, true);
      element.removeEventListener('focusin', focus);
    };
  }, [aspect, maxZoom]);

  return {
    frame,
    world,
    scale,
    zoomIn: () => controls.current?.zoomIn(),
    zoomOut: () => controls.current?.zoomOut(),
    reset: () => controls.current?.reset(),
  };
}
