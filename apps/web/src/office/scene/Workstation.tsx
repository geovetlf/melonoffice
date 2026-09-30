import type { AgentState } from '../departments.js';

/**
 * A workstation of the Home's office, drawn from baked 3D art (`./art/desk-*`, made by
 * `scripts/office-art/bake.mjs`) seen from behind at the room's angle, in two layers: the desk
 * with its monitor showing the department's kind of work and the chair, then the person when
 * someone sits there. A real agent carries a small light in its state's colour and its monitor
 * follows its state (lit and moving while it works, lit when available, on standby when paused
 * or offline). An ambient figure (ADR-0042) is decoration: no light, a dimmed monitor and nothing
 * that says it is working. Hidden from assistive technology: the agent's button around it gives
 * its name and state.
 */

export type DeskOccupant =
  { readonly kind: 'agent'; readonly state: AgentState } | { readonly kind: 'ambient' } | null;

const ART = import.meta.glob<string>('./art/desk-*@2x.webp', { eager: true, import: 'default' });
const art = (name: string): string | undefined => ART[`./art/desk-${name}@2x.webp`];

/** How many people the art has. */
const PEOPLE = 6;

/**
 * The monitor's screen in the art, as the matrix that maps a unit square onto it (printed by
 * the bake as SCREEN_CORNERS: top left, top right, bottom right, bottom left).
 */
const SCREEN = 'matrix(33.47 0 0 16.69 -27.26 -72.84)';

export function Workstation({
  occupant,
  look,
  motif = 'generic',
}: {
  readonly occupant: DeskOccupant;
  readonly look: number;
  readonly motif?: string;
}) {
  const state = occupant?.kind === 'agent' ? occupant.state : undefined;
  const screen =
    occupant === null
      ? 'off'
      : occupant.kind === 'ambient'
        ? 'dim'
        : state === 'paused' || state === 'offline'
          ? 'off'
          : state === 'working'
            ? 'working'
            : 'on';
  const faded = state === 'paused' || state === 'offline';
  const layer = (href: string | undefined, className?: string) =>
    href === undefined ? null : (
      <image
        href={href}
        x="-50"
        y="-80"
        width="100"
        height="100"
        className={className}
        preserveAspectRatio="xMidYMid meet"
      />
    );
  return (
    <svg
      className={`desk${occupant === null ? '' : ` desk--${occupant.kind}`}`}
      viewBox="-50 -80 100 100"
      aria-hidden="true"
      focusable="false"
    >
      {layer(art(motif) ?? art('generic'))}
      <g className={`desk__monitor desk__monitor--${screen}`} transform={SCREEN}>
        <rect width="1" height="1" className="desk__screen" />
        {screen === 'working' ? (
          <g className="desk__lines">
            <rect x="0.1" y="0.2" width="0.5" height="0.1" />
            <rect x="0.1" y="0.44" width="0.7" height="0.1" />
            <rect x="0.1" y="0.68" width="0.4" height="0.1" />
          </g>
        ) : null}
      </g>
      {occupant === null ? null : (
        <g className={`desk__person${faded ? ' desk__person--faded' : ''}`}>
          {layer(art(`person-${look % PEOPLE}`), 'desk__breath')}
        </g>
      )}
      {state === undefined ? null : (
        <circle cx="16" cy="-66" r="4.2" className={`desk__light desk__light--${state}`} />
      )}
    </svg>
  );
}
