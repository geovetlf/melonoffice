import { useId, type ReactNode } from 'react';
import type { RoomMotif } from './departments.js';
import type { RoomOccupant, SeatPosition } from './workstations.js';

/**
 * A department's room, drawn in SVG (ADR-0040, ADR-0041): a lit back wall with the department's
 * big screen, shelves, lamps, plants and its workstations. Each desk is one of the department's
 * workstations; the person at it is a real agent (ADR-0006), never an extra, and an empty desk
 * shows its empty chair. Nothing drawn says what an agent is doing. Hidden from assistive
 * technology; the room's name, its workstations and its agents are given by the elements around it.
 */

/** Who is at a desk, as the drawing shows it: by record state only. */
export type SeatOccupant = RoomOccupant;

export interface RoomSeat {
  readonly position: SeatPosition;
  readonly occupant: SeatOccupant;
}

export interface RoomArtProps {
  readonly motif: RoomMotif;
  readonly hue: string;
  /** `zone`: a room seen from the Home; `office`: the same room, entered. */
  readonly variant?: 'zone' | 'office';
  /** The department's workstations, where they stand and who is at each (see `seatAgents`). */
  readonly seats?: readonly RoomSeat[];
}

/** The rooms' drawing sizes. Workstation positions are fractions of these. */
export const ROOM_SIZES = {
  zone: { width: 360, height: 200 },
  office: { width: 720, height: 400 },
} as const;

/** How big a desk is drawn, so the widest row still fits its room. */
export function deskScale(seats: readonly RoomSeat[], variant: 'zone' | 'office', row: number) {
  const { width } = ROOM_SIZES[variant];
  const perRow = seats.filter((seat) => seat.position.row === row).length || 1;
  const rows = new Set(seats.map((seat) => seat.position.row)).size || 1;
  const room = variant === 'office' ? 2.1 : 1.1;
  // Back rows are a little smaller: depth.
  const depth = 1 - (rows - 1 - row) * 0.12;
  return Math.min(room, ((width * 0.7) / perRow / 66) * (variant === 'office' ? 1.2 : 1)) * depth;
}

export function RoomArt({ motif, hue, variant = 'zone', seats = [] }: RoomArtProps) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const { width: w, height: h } = ROOM_SIZES[variant];
  const wall = `wall-${id}`;
  const glow = `glow-${id}`;
  const floor = `floor-${id}`;
  const screenW = variant === 'office' ? 168 : 120;
  const screenH = variant === 'office' ? 78 : 56;
  const screenCount = variant === 'office' ? 3 : 1;
  const gap = 22;
  const firstScreen = (w - screenCount * screenW - (screenCount - 1) * gap) / 2;
  const screens = Array.from({ length: screenCount }, (_, i) => firstScreen + i * (screenW + gap));
  const lamps = variant === 'office' ? [0.2, 0.4, 0.6, 0.8] : [0.28, 0.72];
  // Back rows first, so the front rows are drawn over them.
  const ordered = seats
    .map((seat, i) => ({ seat, i }))
    .sort((a, b) => a.seat.position.row - b.seat.position.row);
  return (
    <svg
      className={`room room--${variant}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio={variant === 'office' ? 'xMidYMid meet' : 'xMidYMid slice'}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={wall} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={hue} stopOpacity="0.55" />
          <stop offset="0.55" stopColor="#5a2c1d" stopOpacity="0.95" />
          <stop offset="1" stopColor="#2b1711" />
        </linearGradient>
        <radialGradient id={glow} cx="0.5" cy="0.25" r="0.7">
          <stop offset="0" stopColor={hue} stopOpacity="0.55" />
          <stop offset="1" stopColor={hue} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={floor} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#7a4330" />
          <stop offset="1" stopColor="#3a2019" />
        </linearGradient>
      </defs>
      {/* Back wall, arched like the reference's pods, and the warm light of the room. */}
      <path
        d={`M0 ${h * 0.62} V${h * 0.2} Q0 6 ${w * 0.12} 6 H${w * 0.88} Q${w} 6 ${w} ${h * 0.2} V${h * 0.62} Z`}
        fill={`url(#${wall})`}
      />
      <rect width={w} height={h * 0.7} fill={`url(#${glow})`} />
      <path
        d={`M${w * 0.1} 14 H${w * 0.9}`}
        stroke={hue}
        strokeWidth="3"
        strokeLinecap="round"
        className="room__light"
      />
      {lamps.map((f) => (
        <g key={f} className="room__lamp">
          <line x1={w * f} y1="16" x2={w * f} y2={h * 0.1} stroke="#1c110d" strokeWidth="1" />
          <circle cx={w * f} cy={h * 0.1 + 3} r="9" fill="#ffd08a" opacity="0.18" />
          <path
            d={`M${w * f - 5} ${h * 0.1 + 3} Q${w * f} ${h * 0.1 - 4} ${w * f + 5} ${h * 0.1 + 3} Z`}
            fill="#ffd08a"
          />
        </g>
      ))}
      <Shelf x={10} y={h * 0.22} height={h * 0.36} hue={hue} />
      <Shelf x={w - 46} y={h * 0.22} height={h * 0.36} hue={hue} />
      {screens.map((x, i) => (
        <g key={x} transform={`translate(${x} ${h * 0.14})`}>
          <rect
            width={screenW}
            height={screenH}
            rx="5"
            fill="#221410"
            stroke={hue}
            strokeOpacity="0.8"
            strokeWidth="1.5"
          />
          <g className="room__screen" style={{ animationDelay: `${i * 1.3}s` }}>
            <Motif motif={motif} hue={hue} width={screenW} height={screenH} />
          </g>
        </g>
      ))}
      {/* Floor. */}
      <path d={`M0 ${h * 0.62} H${w} V${h} H0 Z`} fill={`url(#${floor})`} />
      <ellipse cx={w / 2} cy={h * 0.64} rx={w * 0.46} ry={h * 0.05} fill={hue} opacity="0.18" />
      {ordered.map(({ seat, i }) => (
        <Desk
          key={i}
          x={seat.position.x * w}
          y={seat.position.y * h}
          hue={hue}
          look={i}
          occupant={seat.occupant}
          scale={deskScale(seats, variant, seat.position.row)}
        />
      ))}
      <Plant x={18} y={h - 4} scale={variant === 'office' ? 1.4 : 1} />
      <Plant x={w - 18} y={h - 4} scale={variant === 'office' ? 1.4 : 1} />
    </svg>
  );
}

function Shelf({ x, y, height, hue }: { x: number; y: number; height: number; hue: string }) {
  const rows = [0.3, 0.62, 0.94].map((r) => y + height * r);
  return (
    <g opacity="0.85">
      <rect x={x} y={y} width="36" height={height} rx="3" fill="#3b2019" />
      {rows.map((ry, i) => (
        <g key={ry}>
          <rect x={x + 2} y={ry} width="32" height="2" fill="#6b3a2a" />
          {[0, 1, 2, 3].map((b) => (
            <rect
              key={b}
              x={x + 4 + b * 7}
              y={ry - 9 + ((b + i) % 2)}
              width="5"
              height={8 - ((b + i) % 2)}
              rx="1"
              fill={b % 2 === 0 ? hue : '#f3d6c2'}
              opacity={b % 2 === 0 ? 0.8 : 0.55}
            />
          ))}
        </g>
      ))}
    </g>
  );
}

/** A few looks for the people drawn at the desks, so a room does not look cloned. */
const PEOPLE = [
  { hair: '#3a2019', shirt: '#2f2a3a', skin: '#f1c7a8' },
  { hair: '#8a4b2a', shirt: '#f4e3d6', skin: '#e0a98a' },
  { hair: '#1d1310', shirt: '#6b3a2a', skin: '#c98d6b' },
  { hair: '#d9a066', shirt: '#3b2a4a', skin: '#f3d0b5' },
  { hair: '#2b1a14', shirt: '#9a4a32', skin: '#b87a5a' },
] as const;

function Desk({
  x,
  y,
  hue,
  look,
  occupant,
  scale,
}: {
  x: number;
  y: number;
  hue: string;
  look: number;
  occupant: SeatOccupant;
  scale: number;
}) {
  return (
    <g
      transform={`translate(${x} ${y}) scale(${scale})`}
      className={occupant === null ? 'room__desk room__desk--free' : 'room__desk'}
    >
      {occupant === null ? (
        // A free workstation: its empty chair, waiting.
        <g className="room__chair" opacity="0.8">
          <rect
            x="-11"
            y="-28"
            width="22"
            height="22"
            rx="5"
            fill="#4a2a20"
            stroke={hue}
            strokeOpacity="0.55"
          />
          <rect x="-12" y="-9" width="24" height="5" rx="2" fill="#3b2019" />
        </g>
      ) : (
        <VisualWorker look={look} occupant={occupant} hue={hue} />
      )}
      {/* Monitor: lit when someone sits at it. It shows no content: nobody is shown working. */}
      <rect
        x="-10"
        y="-17"
        width="20"
        height="12"
        rx="1.5"
        fill="#1c110d"
        stroke={hue}
        strokeWidth="0.8"
      />
      <rect
        x="-8.5"
        y="-15.5"
        width="17"
        height="9"
        rx="1"
        fill={hue}
        opacity={occupant === 'present' ? 0.45 : occupant === 'ambient' ? 0.3 : 0.12}
      />
      <rect x="-1.5" y="-5" width="3" height="3" fill="#1c110d" />
      {/* Desk, with its keyboard. */}
      <path d="M-30 -2 H30 L26 4 H-26 Z" fill="#f4e3d6" />
      <rect x="-7" y="-2.8" width="14" height="1.8" rx="0.6" fill="#d8c1b1" />
      <rect x="-24" y="4" width="3" height="12" fill="#c9ad9b" />
      <rect x="21" y="4" width="3" height="12" fill="#c9ad9b" />
    </g>
  );
}

/**
 * A person seated at a desk, facing the room over the monitor, hands on the desk (ADR-0042). The
 * same figure draws a real agent and an ambient one: an ambient figure is decoration, drawn a
 * little softer and with no presence light; a real agent carries the department's light above,
 * and fades when paused or offline. It never types, clicks or writes: its only motion is the
 * room's slow breathing, and only when motion is welcome.
 */
export function VisualWorker({
  look,
  occupant,
  hue,
}: {
  readonly look: number;
  readonly occupant: Exclude<SeatOccupant, null>;
  readonly hue: string;
}) {
  const person = PEOPLE[look % PEOPLE.length] ?? PEOPLE[0];
  const opacity =
    occupant === 'paused' ? 0.55 : occupant === 'offline' ? 0.32 : occupant === 'ambient' ? 0.9 : 1;
  return (
    <g
      className={`room__worker room__worker--${occupant === 'ambient' ? 'ambient' : 'agent'}`}
      opacity={opacity}
    >
      {/* Chair back. */}
      <rect x="-13" y="-30" width="26" height="26" rx="6" fill="#2d1914" />
      <g className="room__breath">
        {/* Torso and shoulders. */}
        <path d="M-13 -5 Q-14.5 -21 -8 -23.5 L8 -23.5 Q14.5 -21 13 -5 Z" fill={person.shirt} />
        {/* Arms reaching to the desk, hands resting beside the monitor. */}
        <path
          d="M-11 -20 Q-16.5 -12 -12.5 -3.5 M11 -20 Q16.5 -12 12.5 -3.5"
          stroke={person.shirt}
          strokeWidth="4.2"
          strokeLinecap="round"
          fill="none"
        />
        <circle cx="-12" cy="-3" r="2" fill={person.skin} />
        <circle cx="12" cy="-3" r="2" fill={person.skin} />
        {/* Neck, head and hair. */}
        <rect x="-2.3" y="-28" width="4.6" height="5" fill={person.skin} />
        <circle cx="0" cy="-33.5" r="6.6" fill={person.skin} />
        <path
          d="M-6.8 -33.5 Q-6.6 -41.8 0 -41.8 Q6.6 -41.8 6.8 -33.5 Q3.8 -37.6 0 -37.6 Q-3.8 -37.6 -6.8 -33.5Z"
          fill={person.hair}
        />
      </g>
      {occupant === 'ambient' ? null : (
        // A real agent's presence light, in the department's color.
        <circle cx="0" cy="-47" r="2.2" fill={hue} className="room__presence" />
      )}
    </g>
  );
}

function Plant({ x, y, scale }: { x: number; y: number; scale: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`}>
      <ellipse cx="-6" cy="-24" rx="5" ry="12" fill="#5f7a4c" transform="rotate(-25 -6 -24)" />
      <ellipse cx="6" cy="-26" rx="5" ry="13" fill="#6f8b5a" transform="rotate(20 6 -26)" />
      <ellipse cx="0" cy="-30" rx="4.5" ry="13" fill="#57714a" />
      <path d="M-8 -12 H8 L6 0 H-6 Z" fill="#e9d5c6" />
    </g>
  );
}

/** What the big screen shows: a sign of the department's work, drawn, not data. */
function Motif({
  motif,
  hue,
  width: w,
  height: h,
}: {
  motif: RoomMotif;
  hue: string;
  width: number;
  height: number;
}): ReactNode {
  const soft = '#ffd9c2';
  const pad = 8;
  switch (motif) {
    case 'map':
      return (
        <g opacity="0.9">
          <path
            d={`M${w * 0.12} ${h * 0.45} q${w * 0.08} -${h * 0.25} ${w * 0.2} -${h * 0.1} t${w * 0.1} ${h * 0.25} q-${w * 0.12} ${h * 0.2} -${w * 0.3} -${h * 0.15}Z`}
            fill={hue}
            opacity="0.5"
          />
          <path
            d={`M${w * 0.5} ${h * 0.3} q${w * 0.15} -${h * 0.12} ${w * 0.35} ${h * 0.05} q-${w * 0.05} ${h * 0.35} -${w * 0.2} ${h * 0.4} q-${w * 0.1} -${h * 0.1} -${w * 0.15} -${h * 0.45}Z`}
            fill={hue}
            opacity="0.5"
          />
          {[0.25, 0.42, 0.62, 0.78].map((fx, i) => (
            <circle key={fx} cx={w * fx} cy={h * (0.35 + (i % 2) * 0.2)} r="2.2" fill={soft} />
          ))}
        </g>
      );
    case 'dashboard':
      return (
        <g>
          {[0, 1, 2, 3].map((i) => {
            const cw = (w - pad * 3) / 2;
            const ch = (h - pad * 3) / 2;
            const x = pad + (i % 2) * (cw + pad);
            const y = pad + Math.floor(i / 2) * (ch + pad);
            return (
              <g key={i}>
                <rect x={x} y={y} width={cw} height={ch} rx="2" fill={hue} opacity="0.18" />
                {[0, 1, 2, 3].map((b) => (
                  <rect
                    key={b}
                    x={x + 4 + b * (cw / 5)}
                    y={y + ch - 3 - (((b + i) % 3) + 1) * (ch / 5)}
                    width={cw / 8}
                    height={(((b + i) % 3) + 1) * (ch / 5)}
                    fill={b % 2 === 0 ? hue : soft}
                    opacity="0.85"
                  />
                ))}
              </g>
            );
          })}
        </g>
      );
    case 'growth':
      return (
        <g>
          {[0.25, 0.4, 0.55, 0.75, 0.9].map((f, i) => (
            <rect
              key={f}
              x={pad + i * ((w - pad * 2) / 5) + 2}
              y={h - pad - (h - pad * 2) * f}
              width={(w - pad * 2) / 5 - 6}
              height={(h - pad * 2) * f}
              rx="1.5"
              fill={hue}
              opacity={0.45 + i * 0.1}
            />
          ))}
          <path
            d={`M${pad} ${h * 0.75} L${w * 0.35} ${h * 0.55} L${w * 0.55} ${h * 0.6} L${w - pad} ${h * 0.18}`}
            stroke={soft}
            strokeWidth="1.8"
            fill="none"
          />
        </g>
      );
    case 'social':
      return (
        <g>
          {[0, 1, 2].map((i) => {
            const cw = (w - pad * 4) / 3;
            const x = pad + i * (cw + pad);
            return (
              <g key={i}>
                <rect
                  x={x}
                  y={pad}
                  width={cw}
                  height={h - pad * 2}
                  rx="3"
                  fill={soft}
                  opacity="0.15"
                />
                <rect
                  x={x + 3}
                  y={pad + 3}
                  width={cw - 6}
                  height={(h - pad * 2) * 0.5}
                  rx="2"
                  fill={hue}
                  opacity="0.7"
                />
                <rect
                  x={x + 3}
                  y={pad + (h - pad * 2) * 0.62}
                  width={cw * 0.7}
                  height="3"
                  fill={soft}
                  opacity="0.7"
                />
                <circle cx={x + cw - 7} cy={h - pad - 6} r="2.5" fill={hue} />
              </g>
            );
          })}
        </g>
      );
    case 'video':
      return (
        <g>
          <rect
            x={pad}
            y={pad}
            width={w - pad * 2}
            height={h * 0.52}
            rx="2"
            fill={hue}
            opacity="0.3"
          />
          <path
            d={`M${w / 2 - 6} ${pad + h * 0.12} L${w / 2 + 8} ${pad + h * 0.26} L${w / 2 - 6} ${pad + h * 0.4} Z`}
            fill={soft}
          />
          {[0, 1, 2, 3].map((i) => (
            <rect
              key={i}
              x={pad + i * ((w - pad * 2) / 4) + 1}
              y={h * 0.72}
              width={(w - pad * 2) / 4 - 3}
              height={h * 0.14}
              rx="1.5"
              fill={i % 2 === 0 ? hue : soft}
              opacity="0.7"
            />
          ))}
        </g>
      );
    case 'network': {
      const nodes = [
        [0.15, 0.3],
        [0.35, 0.7],
        [0.5, 0.35],
        [0.7, 0.65],
        [0.85, 0.3],
      ] as const;
      return (
        <g>
          {nodes.slice(1).map(([fx, fy], i) => {
            const [px, py] = nodes[i] ?? nodes[0];
            return (
              <line
                key={fx}
                x1={w * px}
                y1={h * py}
                x2={w * fx}
                y2={h * fy}
                stroke={hue}
                strokeWidth="1.2"
                opacity="0.8"
              />
            );
          })}
          <line
            x1={w * 0.5}
            y1={h * 0.35}
            x2={w * 0.85}
            y2={h * 0.3}
            stroke={hue}
            strokeWidth="1.2"
            opacity="0.8"
          />
          {nodes.map(([fx, fy], i) => (
            <circle
              key={fx}
              cx={w * fx}
              cy={h * fy}
              r={i === 2 ? 5 : 3.5}
              fill={i === 2 ? soft : hue}
            />
          ))}
        </g>
      );
    }
    case 'finance':
      return (
        <g>
          <circle cx={w * 0.27} cy={h / 2} r={h * 0.32} fill={soft} opacity="0.25" />
          <path
            d={`M${w * 0.27} ${h / 2} V${h / 2 - h * 0.32} A${h * 0.32} ${h * 0.32} 0 0 1 ${w * 0.27 + h * 0.3} ${h / 2 + h * 0.1} Z`}
            fill={hue}
          />
          {[0, 1, 2].map((i) => (
            <rect
              key={i}
              x={w * 0.55}
              y={h * (0.25 + i * 0.2)}
              width={w * (0.35 - i * 0.08)}
              height={h * 0.1}
              rx="1.5"
              fill={i === 0 ? hue : soft}
              opacity="0.75"
            />
          ))}
        </g>
      );
    default:
      return (
        <g>
          {[0.25, 0.45, 0.65].map((f) => (
            <rect
              key={f}
              x={pad}
              y={h * f}
              width={(w - pad * 2) * (1.2 - f)}
              height="4"
              rx="2"
              fill={soft}
              opacity="0.6"
            />
          ))}
        </g>
      );
  }
}
