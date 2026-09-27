import type { useIntl } from '@melonoffice/i18n';
import type { IconName } from './icons.js';
import type { DepartmentView, SpecialistView } from './officeClient.js';

/**
 * How a department looks in the office (ADR-0040): presentation only. Which departments exist,
 * and their names, come from the organization's departments (the D-11 catalogue, ADR-0025). A
 * type the app does not know yet still gets an office, with the default look.
 */

/** What the room's big screen shows. */
export type RoomMotif =
  'map' | 'dashboard' | 'growth' | 'social' | 'video' | 'network' | 'finance' | 'generic';

export interface DepartmentLook {
  readonly icon: IconName;
  readonly motif: RoomMotif;
  /** The room's light: warm tones only (green is not the brand color). */
  readonly hue: string;
  /** Headquarters sit on the top floor of the Home. */
  readonly headquarters?: boolean;
}

const LOOKS: Readonly<Record<string, DepartmentLook>> = {
  leadership: { icon: 'crown', motif: 'map', hue: '#f2784b', headquarters: true },
  operations: { icon: 'cog', motif: 'dashboard', hue: '#ff9a62' },
  sales: { icon: 'growth', motif: 'growth', hue: '#f5b942' },
  marketing: { icon: 'megaphone', motif: 'social', hue: '#ff7f6e' },
  design_video: { icon: 'play', motif: 'video', hue: '#f0665a' },
  research: { icon: 'research', motif: 'network', hue: '#ffb27a' },
  finance: { icon: 'coins', motif: 'finance', hue: '#e8a33d' },
};

export const DEFAULT_LOOK: DepartmentLook = { icon: 'building', motif: 'generic', hue: '#f2a07b' };

export const lookOf = (department: Pick<DepartmentView, 'typeId'>): DepartmentLook =>
  (department.typeId === null ? undefined : LOOKS[department.typeId]) ?? DEFAULT_LOOK;

type IntlShape = ReturnType<typeof useIntl>;

/** The department's place in a path: its catalogue type (`design_video` → `design-video`). */
export function officeSlug(department: Pick<DepartmentView, 'id' | 'typeId'>): string {
  if (department.typeId !== null) return department.typeId.replaceAll('_', '-');
  const own = department.id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `custom-${own}`.slice(0, 64);
}

export const findBySlug = (departments: readonly DepartmentView[], slug: string) =>
  departments.find((department) => officeSlug(department) === slug);

/**
 * A department's name: its catalogue message (D-17) or, for a custom one, its own name. `label` is
 * how the office names a room: the short name, except headquarters, which keep their full name
 * (Consejo y Dirección is one room).
 */
export function departmentName(
  intl: IntlShape,
  department: DepartmentView,
  form: 'name' | 'short' | 'label' = 'label',
): string {
  const short = form === 'short' || (form === 'label' && lookOf(department).headquarters !== true);
  const key = short ? (department.shortNameKey ?? department.nameKey) : department.nameKey;
  if (key !== null && intl.messages[key] !== undefined) return intl.formatMessage({ id: key });
  return department.name ?? intl.formatMessage({ id: 'office.department.unnamed' });
}

/** The departments shown in the office: every one but archived, headquarters first. */
export function officeDepartments(departments: readonly DepartmentView[]): {
  readonly headquarters: readonly DepartmentView[];
  readonly floor: readonly DepartmentView[];
} {
  const shown = departments.filter((department) => department.status !== 'archived');
  return {
    headquarters: shown.filter((department) => lookOf(department).headquarters === true),
    floor: shown.filter((department) => lookOf(department).headquarters !== true),
  };
}

/**
 * What the Home can say about a department's agents, from their records. Specialists are records,
 * not running AI (D-28): nothing yet reports what one is doing, so an active one is `available`.
 * The other states (ADR-0040) are ready for when the runtime reports them.
 */
export type AgentState =
  'working' | 'waiting' | 'processing' | 'available' | 'attention' | 'paused';

export const AGENT_STATES: readonly AgentState[] = [
  'working',
  'waiting',
  'processing',
  'available',
  'attention',
  'paused',
];

export interface DepartmentAgents {
  readonly active: number;
  readonly paused: number;
  /** The state the room shows, if it has any agent at all. */
  readonly state: AgentState | undefined;
}

export function agentsOf(
  department: Pick<DepartmentView, 'id'>,
  specialists: readonly SpecialistView[],
): DepartmentAgents {
  const own = specialists.filter((specialist) => specialist.departmentId === department.id);
  const active = own.filter((specialist) => specialist.status === 'active').length;
  const paused = own.filter((specialist) => specialist.status === 'paused').length;
  const state = active > 0 ? 'available' : paused > 0 ? 'paused' : undefined;
  return { active, paused, state };
}
