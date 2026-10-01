import type { ReactNode } from 'react';
import { Spinner } from './Spinner.js';

export type StateKind = 'loading' | 'empty' | 'error' | 'success' | 'warning';

/**
 * What a list or a panel says instead of its content: it is loading, has nothing yet, failed, or
 * finished. An error is announced at once (`alert`); every other state politely (`status`). Its
 * mark is drawn by the stylesheet, so the message's text is only its words.
 */
export function StateMessage({
  kind,
  title,
  children,
  action,
  inline = false,
  className,
}: {
  readonly kind: StateKind;
  readonly title?: ReactNode;
  readonly children?: ReactNode;
  /** One next step, such as a button to retry or to create the first item. */
  readonly action?: ReactNode;
  /** Without its box, inside a panel that already has one. */
  readonly inline?: boolean;
  readonly className?: string;
}) {
  const classes = [
    'mo-state',
    `mo-state--${kind}`,
    inline ? 'mo-state--inline' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="mo-state__icon" aria-hidden="true">
        {kind === 'loading' ? <Spinner /> : null}
      </span>
      <div className="mo-state__body">
        {title === undefined ? null : <p className="mo-state__title">{title}</p>}
        {children === undefined ? null : <p className="mo-state__text">{children}</p>}
        {action}
      </div>
    </div>
  );
}
