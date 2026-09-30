import type { ButtonHTMLAttributes } from 'react';
import { Spinner } from './Spinner.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  /** `md` is the target size (44 px); `sm` (32 px) is for dense rows inside a panel. */
  readonly size?: ButtonSize;
  /** The action is under way: the button says so (`aria-busy`), shows a spinner and waits. */
  readonly loading?: boolean;
  /** A square button holding only an icon; it needs an `aria-label`. */
  readonly iconOnly?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  iconOnly = false,
  type = 'button',
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'mo-button',
    `mo-button--${variant}`,
    size === 'sm' ? 'mo-button--sm' : undefined,
    iconOnly ? 'mo-button--icon' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled === true || loading}
      aria-busy={loading ? true : undefined}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  );
}
