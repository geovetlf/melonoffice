/**
 * Design tokens v0: the MelonOffice melon/coral identity on warm neutrals.
 * Green is used only as a status colour, never as a brand colour.
 *
 * `tokens.css` exposes the same values as CSS custom properties; a test keeps
 * both in sync.
 */

export const palette = {
  melon500: '#F2784B',
  melon600: '#D95F32',
  melon700: '#A8431E',
  coral400: '#FF9A6B',
  amber400: '#F5B942',
  cream50: '#FFF8F3',
  sand100: '#F6EDE6',
  sand200: '#E9DCD2',
  stone600: '#6E5A4F',
  charcoal800: '#3A2A24',
  charcoal900: '#241915',
  white: '#FFFFFF',
  statusSuccess: '#2E7D4F',
  statusWarning: '#9A6A00',
  statusDanger: '#B42318',
} as const;

/** Semantic colours used by components. Components never use palette values directly. */
export const color = {
  surface: palette.white,
  surfaceSubtle: palette.cream50,
  surfaceMuted: palette.sand100,
  border: palette.sand200,
  textPrimary: palette.charcoal900,
  textSecondary: palette.stone600,
  textOnAccent: palette.white,
  accent: palette.melon700,
  accentHover: palette.charcoal800,
  accentDecorative: palette.melon500,
  highlight: palette.amber400,
  focusRing: palette.melon700,
  sidebarBackground: palette.charcoal900,
  sidebarText: palette.cream50,
  success: palette.statusSuccess,
  warning: palette.statusWarning,
  danger: palette.statusDanger,
} as const;

export const font = {
  family:
    "system-ui, -apple-system, 'Segoe UI', Roboto, 'Noto Sans', 'Noto Sans CJK SC', 'Noto Sans JP', sans-serif",
  sizeXs: '0.75rem',
  sizeSm: '0.875rem',
  sizeMd: '1rem',
  sizeLg: '1.25rem',
  sizeXl: '1.5rem',
  sizeXxl: '2rem',
  weightRegular: '400',
  weightMedium: '500',
  weightBold: '700',
  lineHeight: '1.5',
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

export const radius = {
  sm: '6px',
  md: '10px',
  lg: '16px',
  pill: '999px',
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
  vars['--mo-min-target-size'] = minTargetSize;
  return vars;
}
