import type { AgentState } from '../departments.js';

/**
 * A workstation of the Home's building (Home V4), drawn: an oak desk with its monitor, a chair
 * and, when someone sits there, a person. A real agent carries a small light in its state's
 * colour and its monitor follows its state (lit and moving while it works, dim when available,
 * dark when paused or offline). An ambient figure (ADR-0042) is decoration: no light, a dim
 * monitor and nothing that says it is working. Hidden from assistive technology: the agent's
 * button around it gives its name and state.
 */

export type DeskOccupant =
  { readonly kind: 'agent'; readonly state: AgentState } | { readonly kind: 'ambient' } | null;

const PEOPLE = [
  { hair: '#2b1a14', shirt: '#f4efe9', skin: '#e0b08c', style: 'short' },
  { hair: '#6b3f25', shirt: '#2f3b4c', skin: '#f1c7a5', style: 'long' },
  { hair: '#1c1512', shirt: '#c9643f', skin: '#a8714f', style: 'bun' },
  { hair: '#a4683c', shirt: '#6f7f8f', skin: '#f3cfb3', style: 'short' },
  { hair: '#3a2419', shirt: '#e8b04a', skin: '#c58a64', style: 'long' },
  { hair: '#15100e', shirt: '#8a4f3a', skin: '#8e5b3e', style: 'short' },
] as const;

export function Workstation({
  occupant,
  look,
}: {
  readonly occupant: DeskOccupant;
  readonly look: number;
}) {
  const person = PEOPLE[look % PEOPLE.length] ?? PEOPLE[0];
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
  return (
    <svg
      className={`desk${occupant === null ? '' : ` desk--${occupant.kind}`}`}
      viewBox="-44 -66 88 80"
      aria-hidden="true"
      focusable="false"
    >
      {/* Shadow on the floor. */}
      <ellipse cx="0" cy="12" rx="40" ry="4.5" className="desk__shadow" />
      {/* Chair back. */}
      <rect x="-12" y="-40" width="24" height="30" rx="7" fill="#8c6a52" />
      <rect x="-10" y="-38" width="20" height="10" rx="5" fill="#a07d63" />
      {occupant === null ? null : (
        <g className={`desk__person${faded ? ' desk__person--faded' : ''}`}>
          <g className="desk__breath">
            <path d="M-14 -6 Q-15.5 -24 -8 -27 L8 -27 Q15.5 -24 14 -6 Z" fill={person.shirt} />
            <path d="M-8 -27 L0 -21 L8 -27" stroke="#00000022" strokeWidth="1.2" fill="none" />
            <rect x="-2.6" y="-32" width="5.2" height="6" fill={person.skin} />
            {person.style === 'long' ? (
              <path d="M-8.5 -38 Q-9.5 -24 -6 -24 L6 -24 Q9.5 -24 8.5 -38 Z" fill={person.hair} />
            ) : null}
            <ellipse cx="0" cy="-38" rx="7" ry="7.8" fill={person.skin} />
            <path
              d="M-7.4 -38.5 Q-7.6 -47.5 0 -47.5 Q7.6 -47.5 7.4 -38.5 Q4 -43 0 -42.6 Q-4.5 -43 -7.4 -38.5Z"
              fill={person.hair}
            />
            {person.style === 'bun' ? (
              <circle cx="0" cy="-48.5" r="3.6" fill={person.hair} />
            ) : null}
            <circle cx="-2.4" cy="-37.5" r="0.8" fill="#3a2419" />
            <circle cx="2.4" cy="-37.5" r="0.8" fill="#3a2419" />
            {/* Hands on the desk. */}
            <circle cx="-9" cy="-5.5" r="2.4" fill={person.skin} />
            <circle cx="9" cy="-5.5" r="2.4" fill={person.skin} />
          </g>
        </g>
      )}
      {/* Monitor, on the desk's left, turned to the room. */}
      <g className={`desk__monitor desk__monitor--${screen}`}>
        <rect x="-38" y="-30" width="30" height="20" rx="2" fill="#2a2426" />
        <rect x="-36.5" y="-28.5" width="27" height="17" rx="1" className="desk__screen" />
        {screen === 'working' ? (
          <g className="desk__lines">
            <rect x="-34" y="-26" width="16" height="2" rx="1" />
            <rect x="-34" y="-22" width="20" height="2" rx="1" />
            <rect x="-34" y="-18" width="12" height="2" rx="1" />
          </g>
        ) : null}
        <rect x="-24.5" y="-10" width="3" height="4" fill="#2a2426" />
        <rect x="-29" y="-6.5" width="12" height="1.6" rx="0.8" fill="#2a2426" />
      </g>
      {/* Desk top, front and legs. */}
      <path d="M-42 -5 H42 L39 0 H-39 Z" fill="#d9ad7c" />
      <rect x="-39" y="0" width="78" height="4" fill="#a8764c" />
      <rect x="-36" y="4" width="3" height="9" fill="#7c5434" />
      <rect x="33" y="4" width="3" height="9" fill="#7c5434" />
      {/* Keyboard and a mug. */}
      <rect x="-6" y="-4.3" width="14" height="2" rx="0.6" fill="#efe6dc" />
      <rect x="22" y="-9" width="5" height="5" rx="1" fill="#f7f1ea" />
      {state === undefined ? null : (
        <circle cx="0" cy="-57" r="4.6" className={`desk__light desk__light--${state}`} />
      )}
    </svg>
  );
}
