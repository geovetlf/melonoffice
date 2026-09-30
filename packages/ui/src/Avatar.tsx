export type AvatarSize = 'sm' | 'md' | 'lg';

/** The first letters of the first two words of a name, as an avatar shows them. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toLocaleUpperCase())
    .join('');
}

/** A person's or an agent's initials in a circle. The name beside it says who; this is decoration. */
export function Avatar({
  name,
  size = 'md',
  className,
}: {
  readonly name: string;
  readonly size?: AvatarSize;
  readonly className?: string;
}) {
  const classes = ['mo-avatar', size === 'md' ? undefined : `mo-avatar--${size}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}
