import type { ElementType, ReactNode } from 'react';

/**
 * One record in a list, on a card: its title, a line of facts, badges, what else it says, and its
 * actions, which move under it on a phone. Put it in a `mo-list`.
 */
export function ListItem({
  title,
  titleAs: Title = 'p',
  meta,
  badges,
  actions,
  children,
  as: Item = 'li',
  className,
  id,
  'aria-label': label,
}: {
  readonly title: ReactNode;
  /** The title's element, such as `h3` where the list sits under an `h2`. */
  readonly titleAs?: ElementType;
  readonly meta?: ReactNode;
  readonly badges?: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly as?: ElementType;
  readonly className?: string;
  readonly id?: string;
  /** A name for the record when its title alone does not say which it is. */
  readonly 'aria-label'?: string;
}) {
  return (
    <Item
      id={id}
      aria-label={label}
      className={className === undefined ? 'mo-list-item' : `mo-list-item ${className}`}
    >
      <div className="mo-list-item__main">
        <div className="mo-list-item__heading">
          <Title className="mo-list-item__title">{title}</Title>
          {badges}
        </div>
        {meta === undefined ? null : <p className="mo-list-item__meta">{meta}</p>}
        {children}
      </div>
      {actions === undefined || actions === null || actions === false ? null : (
        <div className="mo-list-item__actions">{actions}</div>
      )}
    </Item>
  );
}
