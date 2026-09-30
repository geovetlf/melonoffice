/**
 * Design tokens v1: MelonOffice's melon on cool porcelain, the materials of the office's rooms.
 * There is one set of tokens for the whole app; screens build on these and never define their
 * own palette. Green is used only as a status colour, never as a brand colour.
 *
 * `tokens.css` exposes the same values as CSS custom properties; a test keeps both in sync. The
 * accent, its hover and soft tints, the expressive melon and the focus ring follow a white-label
 * brand's colour at run time (`applyBrand` in the web app); nothing else does.
 */

export const palette = {
  porcelain: '#F3F5F8',
  porcelain50: '#F8F9FB',
  mist200: '#E9EDF2',
  mist300: '#DCE1E8',
  slate500: '#7D8696',
  graphite600: '#556072',
  ink900: '#18202E',
  white: '#FFFFFF',
  /** The functional melon: text, buttons and controls (WCAG AA on every surface). */
  melon700: '#C0451D',
  /** The expressive melon: GIA, glows and pulses. Never small text. */
  melon400: '#FF8A5C',
  amber400: '#F5B942',
  statusSuccess: '#2E7D4F',
  statusWarning: '#8A5F00',
  statusDanger: '#B42318',
  stateAvailable: '#2E8A5A',
  stateWaiting: '#B87708',
  stateAttention: '#C9302C',
  statePaused: '#6F7888',
  stateOffline: '#848D9C',
} as const;

/** Semantic colours used by components. Components never use palette values directly. */
export const color = {
  background: palette.porcelain,
  surface: palette.white,
  surfaceElevated: palette.white,
  surfaceSubtle: palette.porcelain50,
  surfaceMuted: palette.mist200,
  /** Glass over the office's art: panels and plates that sit on a room. */
  surfaceGlass: 'rgb(255 255 255 / 0.94)',
  border: palette.mist300,
  /** Outlines that identify a control on their own (WCAG non-text contrast). */
  borderStrong: palette.slate500,
  hover: 'rgb(24 32 46 / 0.05)',
  textPrimary: palette.ink900,
  textSecondary: palette.graphite600,
  textOnAccent: palette.white,
  accent: palette.melon700,
  accentHover: 'color-mix(in srgb, var(--mo-color-accent) 84%, #000000)',
  accentSoft: 'color-mix(in srgb, var(--mo-color-accent) 12%, transparent)',
  accentExpressive: palette.melon400,
  highlight: palette.amber400,
  focusRing: palette.melon700,
  success: palette.statusSuccess,
  warning: palette.statusWarning,
  danger: palette.statusDanger,
  /** An agent's state (ADR-0096): a light beside its name, always with a word. */
  stateWorking: palette.melon700,
  stateAvailable: palette.stateAvailable,
  stateWaiting: palette.stateWaiting,
  stateAttention: palette.stateAttention,
  statePaused: palette.statePaused,
  stateOffline: palette.stateOffline,
} as const;

/**
 * Type: Instrument Sans (ADR-0107), one family for the whole app. Its space is narrow (0.2 em), so
 * `wordSpacing` restores a 0.25 em space for running text; headlines tighten slightly and uppercase
 * labels open by one amount everywhere. `sizeXxs` is the smallest text the app sets.
 */
export const font = {
  family:
    "'Instrument Sans Variable', system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans JP', sans-serif",
  sizeXxs: '0.6875rem',
  sizeXs: '0.75rem',
  sizeSm: '0.875rem',
  sizeMd: '1rem',
  sizeLg: '1.25rem',
  sizeXl: '1.5rem',
  sizeXxl: '2rem',
  weightRegular: '400',
  weightMedium: '500',
  weightSemibold: '600',
  weightBold: '700',
  lineHeight: '1.5',
  lineHeightTight: '1.2',
  wordSpacing: '0.05em',
  trackingTight: '-0.01em',
  trackingWide: '0.08em',
} as const;

export const space = {
  1: '0.25rem',
  2: '0.5rem',
  3: '0.75rem',
  4: '1rem',
  6: '1.5rem',
  8: '2rem',
  12: '3rem',
} as const;

/** Corners by hierarchy: controls are small, panels medium, rooms and sheets large. */
export const radius = {
  sm: '6px',
  md: '10px',
  lg: '16px',
  xl: '20px',
  pill: '999px',
} as const;

/** Elevation, tinted with the ink colour: a resting panel, a raised card, an overlay. */
export const shadow = {
  sm: '0 1px 2px rgb(24 32 46 / 0.06)',
  md: '0 1px 2px rgb(24 32 46 / 0.05), 0 8px 24px rgb(24 32 46 / 0.07)',
  lg: '0 2px 6px rgb(24 32 46 / 0.06), 0 18px 48px rgb(24 32 46 / 0.14)',
} as const;

/** Motion answers a person or shows real work; these keep it short and consistent. */
export const motion = {
  durationFast: '120ms',
  durationBase: '200ms',
  durationSlow: '400ms',
  easeStandard: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** Minimum interactive target size (WCAG 2.2 target size, and touch). */
export const minTargetSize = '44px';

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/** Flat map of CSS custom property name → value, derived from the tokens above. */
export function cssVariables(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(color)) vars[`--mo-color-${kebab(name)}`] = value;
  for (const [name, value] of Object.entries(font)) vars[`--mo-font-${kebab(name)}`] = value;
  for (const [name, value] of Object.entries(space)) vars[`--mo-space-${name}`] = value;
  for (const [name, value] of Object.entries(radius)) vars[`--mo-radius-${name}`] = value;
  for (const [name, value] of Object.entries(shadow)) vars[`--mo-shadow-${name}`] = value;
  for (const [name, value] of Object.entries(motion)) vars[`--mo-motion-${kebab(name)}`] = value;
  vars['--mo-min-target-size'] = minTargetSize;
  return vars;
}
