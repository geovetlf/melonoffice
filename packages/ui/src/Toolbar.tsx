import type { ReactNode } from 'react';

/**
 * The filter bar above a list: a search field, chips and a period, in one row that wraps. With a
 * label it is a named group; its chips scroll inside the bar on a phone, never the page.
 */
export function Toolbar({
  label,
  children,
  className,
}: {
  readonly label?: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      className={className === undefined ? 'mo-toolbar' : `mo-toolbar ${className}`}
      role={label === undefined ? undefined : 'group'}
      aria-label={label}
    >
      {children}
    </div>
  );
}
