import { useId, type ReactNode } from 'react';
import { useScrollsSideways } from './useScrollsSideways.js';

/**
 * A table of figures. Where there is room it shows whole; where there is not, it scrolls sideways
 * inside its own box and never widens the page. While it scrolls, the box takes keyboard focus so
 * it can be scrolled without a pointer, and is a group named like the table: a group, not a
 * region, so it never repeats the landmark of the section that holds it. Mark number cells with `mo-table__num`.
 */
export function DataTable({
  caption,
  label,
  children,
  className,
}: {
  /** A visible caption; or `label`, a name for readers only. */
  readonly caption?: ReactNode;
  readonly label?: string;
  /** The table's `thead` and `tbody`. */
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const [box, scrolls] = useScrollsSideways<HTMLDivElement>();
  const captionId = useId();

  return (
    <div
      ref={box}
      className={className === undefined ? 'mo-table-scroll' : `mo-table-scroll ${className}`}
      // A box that scrolls must be reachable from the keyboard (WCAG 2.1.1); it is only while it does.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? 'group' : undefined}
      aria-label={scrolls && caption === undefined ? label : undefined}
      aria-labelledby={scrolls && caption !== undefined ? captionId : undefined}
    >
      <table className="mo-table" aria-label={caption === undefined ? label : undefined}>
        {caption === undefined ? null : (
          <caption id={captionId} className="mo-table__caption">
            {caption}
          </caption>
        )}
        {children}
      </table>
    </div>
  );
}
