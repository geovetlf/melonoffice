import type { ReactNode } from 'react';

/**
 * The top of every page but the Home: its one `h1`, a short line of what the page is for, and the
 * page's own actions. On a phone the actions move under the title.
 */
export function PageHeader({
  title,
  titleId,
  eyebrow,
  description,
  leading,
  meta,
  actions,
  className,
}: {
  readonly title: ReactNode;
  /** An id for the heading, when the page or a region is labelled by it. */
  readonly titleId?: string;
  /** Where the page sits, such as "Settings", above the title. */
  readonly eyebrow?: ReactNode;
  readonly description?: ReactNode;
  /** A mark before the title, such as a department's icon. */
  readonly leading?: ReactNode;
  /** A line of facts under the description, such as counts and badges. */
  readonly meta?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header className={className === undefined ? 'mo-page-header' : `mo-page-header ${className}`}>
      {leading === undefined ? null : <div className="mo-page-header__leading">{leading}</div>}
      <div className="mo-page-header__text">
        {eyebrow === undefined ? null : <p className="mo-page-header__eyebrow">{eyebrow}</p>}
        <h1 id={titleId} className="mo-page-header__title">
          {title}
        </h1>
        {description === undefined ? null : (
          <p className="mo-page-header__description">{description}</p>
        )}
        {meta === undefined ? null : <div className="mo-page-header__meta">{meta}</div>}
      </div>
      {actions === undefined || actions === null || actions === false ? null : (
        <div className="mo-page-header__actions">{actions}</div>
      )}
    </header>
  );
}
