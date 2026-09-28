/**
 * EXAMPLE DATA, and only that (ADR-0040). Tasks and meetings have no API yet (activity is real since ADR-0049), so the
 * Home shows these examples to present the layout, always under an "Example" badge. Nothing here
 * is read from, or written to, the organization. Each panel takes its items as props: when a real
 * source exists, it replaces these without changing the Home.
 */

export interface TaskItem {
  readonly id: string;
  /** A catalogue message for the task's title. Real tasks will carry their own text. */
  readonly titleKey: string;
  /** The department's catalogue type, named through the catalogue (D-17). */
  readonly departmentTypeId: string;
  /** Local time of day, `HH:MM`. */
  readonly at: string;
}

export interface MeetingItem {
  readonly id: string;
  readonly titleKey: string;
  readonly departmentTypeId: string;
  readonly at: string;
}

export const SAMPLE_TASKS: readonly TaskItem[] = [
  { id: 't1', titleKey: 'home.sample.task.proposal', departmentTypeId: 'marketing', at: '10:00' },
  { id: 't2', titleKey: 'home.sample.task.supplier', departmentTypeId: 'operations', at: '11:30' },
  { id: 't3', titleKey: 'home.sample.task.statements', departmentTypeId: 'finance', at: '15:00' },
  { id: 't4', titleKey: 'home.sample.task.report', departmentTypeId: 'leadership', at: '17:00' },
];

export const SAMPLE_MEETINGS: readonly MeetingItem[] = [
  {
    id: 'm1',
    titleKey: 'home.sample.meeting.campaign',
    departmentTypeId: 'marketing',
    at: '10:00',
  },
  {
    id: 'm2',
    titleKey: 'home.sample.meeting.supplier',
    departmentTypeId: 'operations',
    at: '11:30',
  },
  { id: 'm3', titleKey: 'home.sample.meeting.finance', departmentTypeId: 'finance', at: '15:00' },
  {
    id: 'm4',
    titleKey: 'home.sample.meeting.planning',
    departmentTypeId: 'leadership',
    at: '17:00',
  },
];
