/** An agent's state (ADR-0096), in the words the office uses. */
export type AgentState = 'working' | 'available' | 'waiting' | 'attention' | 'paused' | 'offline';

/**
 * A light for an agent's state. Each state has its own shape as well as its colour (working has a
 * halo, waiting is a ring, attention a diamond, paused a square, offline smaller), so it never
 * rests on colour alone. It is decoration next to the state's words, unless given a `label`.
 */
export function StatusDot({
  state,
  label,
  className,
}: {
  readonly state: AgentState;
  readonly label?: string;
  readonly className?: string;
}) {
  const classes = ['mo-dot', `mo-dot--${state}`, className].filter(Boolean).join(' ');
  return label === undefined ? (
    <span className={classes} aria-hidden="true" />
  ) : (
    <span className={classes} role="img" aria-label={label} />
  );
}
