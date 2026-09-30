import type { HTMLAttributes } from 'react';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone?: BadgeTone;
  /** A hairline badge with no fill, for labels such as "Soon". */
  readonly outline?: boolean;
  /** A number on its own (a count of what waits), in the accent. */
  readonly count?: boolean;
}

/** A short label that qualifies what it sits next to: a status, a kind, a count. */
export function Badge({
  tone = 'neutral',
  outline = false,
  count = false,
  className,
  ...rest
}: BadgeProps) {
  const classes = [
    'mo-badge',
    tone === 'neutral' ? undefined : `mo-badge--${tone}`,
    outline ? 'mo-badge--outline' : undefined,
    count ? 'mo-badge--count' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <span className={classes} {...rest} />;
}
