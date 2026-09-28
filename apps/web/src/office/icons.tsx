import type { SVGProps } from 'react';

/**
 * The app's line icons, drawn inline (no icon library is an approved dependency). Decorative:
 * every icon sits next to a visible or accessible name, so it is hidden from assistive technology.
 */

const PATHS = {
  home: 'M3 11.5 12 4l9 7.5M5.5 9.5V20h13V9.5M10 20v-5.5h4V20',
  gia: 'M12 3.5l1.9 4.9 4.9 1.9-4.9 1.9L12 17.1l-1.9-4.9-4.9-1.9 4.9-1.9zM18.5 15.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
  council:
    'M12 4v16M5 20h14M7 8h10M4.5 14 7 8l2.5 6a2.5 2.5 0 0 1-5 0zM14.5 14 17 8l2.5 6a2.5 2.5 0 0 1-5 0z',
  departments: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  projects: 'M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z',
  documents: 'M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20zM14 3.5V8h4M9.5 12.5h6M9.5 16h6',
  calendar: 'M4.5 6.5h15v13h-15zM4.5 10.5h15M8.5 4v4M15.5 4v4',
  communications: 'M4.5 5.5h15v10h-9l-4 3.5v-3.5h-2z',
  automations:
    'M6 7a2 2 0 1 0 0-.01M18 17a2 2 0 1 0 0-.01M8 7h5a3 3 0 0 1 3 3v5M16 7l3-3M19 7l-3-3',
  reports: 'M4.5 20h15M7 16.5V11M11 16.5V6.5M15 16.5v-4M19 16.5V9',
  apps: 'M5 5h5v5H5zM14 5h5v5h-5zM5 14h5v5H5zM16.5 14v5M14 16.5h5',
  settings:
    'M12 8.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7zM12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8',
  search: 'M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12zM15 15l5 5',
  bell: 'M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 2h-14zM10 20.5h4',
  chevron: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  back: 'M15 6l-6 6 6 6',
  paperclip:
    'M16.5 8.5 9.8 15.2a2 2 0 0 1-2.8-2.8L14 5.4a3.5 3.5 0 0 1 5 5l-7.4 7.4a5 5 0 0 1-7-7L11 4.4',
  mic: 'M12 3.5a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0V6A2.5 2.5 0 0 1 12 3.5zM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5V20',
  send: 'M5 12h13M13 6l6 6-6 6',
  document: 'M7 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10A.5.5 0 0 1 7 20zM14 3.5V8h4',
  file: 'M6 4h8l4 4v12H6zM9.5 13h5M12 10.5v5',
  mail: 'M4 6.5h16v11H4zM4 7l8 6 8-6',
  video: 'M4 7h11v10H4zM15 10.5l5-3v9l-5-3z',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  crown: 'M4 17.5h16M5 15.5 4 7l4.5 3.5L12 5l3.5 5.5L20 7l-1 8.5z',
  cog: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M6 18l1.8-1.8M16.2 7.8 18 6',
  growth: 'M4.5 20h15M7 16v-3M11 16V9.5M15 16v-5M19 16V6M6.5 9.5 11 5.5l3.5 3 4.5-4',
  megaphone: 'M4.5 10v4h3l7 4V6l-7 4zM7.5 14l1.5 5h2.5l-1-4.5M18 9.5a3 3 0 0 1 0 5',
  play: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM10 8.5v7l6-3.5z',
  research: 'M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12zM15 15l5 5M8 10.5h5M10.5 8v5',
  coins:
    'M9 7.5c3 0 5-1 5-2s-2-2-5-2-5 1-5 2 2 2 5 2zM4 5.5v4c0 1 2 2 5 2s5-1 5-2v-4M10 14.5c0 1 2 2 5 2s5-1 5-2-2-2-5-2-5 1-5 2zM10 14.5v4c0 1 2 2 5 2s5-1 5-2v-4',
  building: 'M5 20.5V4.5h9v16M14 9.5h5v11M3.5 20.5h17M8 8h3M8 11.5h3M8 15h3',
  credits:
    'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM14.5 9a2.5 2 0 0 0-2.5-1.5c-1.5 0-2.5.8-2.5 2 0 2.8 5 1.5 5 4.2 0 1.2-1 2-2.5 2A2.5 2 0 0 1 9.5 15M12 6v1.5M12 16.5V18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  pause: 'M9 6.5v11M15 6.5v11',
  alert: 'M12 4 21 19.5H3zM12 10v4.5M12 17h.01',
  clock: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 7.5V12l3 2',
  hourglass: 'M7 4h10M7 20h10M8 4c0 5 8 5 8 8s-8 3-8 8M16 4c0 5-8 5-8 8',
  spinner: 'M12 4a8 8 0 1 1-8 8',
  moon: 'M18.5 14.5A7 7 0 0 1 9.5 5.5a7 7 0 1 0 9 9z',
  seat: 'M7 4.5h10v7H7zM5.5 11.5h13v3h-13zM7.5 14.5V20M16.5 14.5V20',
  user: 'M12 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM4.5 20a7.5 7.5 0 0 1 15 0',
  signOut: 'M14 4.5H6v15h8M10.5 12H20M16.5 8l4 4-4 4',
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  readonly name: IconName;
  readonly size?: number;
}

export function Icon({ name, size = 20, className, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={['mo-icon', className].filter(Boolean).join(' ')}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
