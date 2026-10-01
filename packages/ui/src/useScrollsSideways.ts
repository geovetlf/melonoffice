import { useEffect, useState } from 'react';

/**
 * Whether a box is narrower than what it holds, so it scrolls sideways. A box that scrolls must be
 * reachable from the keyboard (WCAG 2.1.1): give it `tabIndex={0}` and a name while it does, and
 * no extra tab stop while it does not. Pass the returned callback as the box's `ref`.
 */
export function useScrollsSideways<T extends HTMLElement>(): readonly [
  (node: T | null) => void,
  boolean,
] {
  const [node, setNode] = useState<T | null>(null);
  const [scrolls, setScrolls] = useState(false);

  useEffect(() => {
    if (node === null || typeof ResizeObserver === 'undefined') return;
    const measure = () => setScrolls(node.scrollWidth > node.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // What it holds can grow without the box changing size.
    for (const child of node.children) observer.observe(child);
    measure();
    return () => observer.disconnect();
  }, [node]);

  return [setNode, scrolls] as const;
}
