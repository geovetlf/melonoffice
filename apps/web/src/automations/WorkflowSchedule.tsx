import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { Button, StateMessage } from '@melonoffice/ui';
import { useState, type FormEvent } from 'react';
import type {
  ScheduleOutcome,
  WorkflowRecurrence,
  WorkflowScheduleView,
} from './automationsClient.js';

/**
 * A workflow's schedule on its card (ADR-0185): how it repeats in words, when it runs next in the
 * business's time zone, what the last occurrence did, and the controls for a person holding the
 * three permissions a standing approval needs. The approval is said plainly before it is given.
 */

/** 2026-10-05 is a Monday: only used to name the days, in the reader's language and in UTC. */
const WEEK_START = Date.UTC(2026, 9, 5, 12);
const DAY_MS = 86_400_000;
/** `HH:MM`, as a time input gives it. */
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Monday is 1 … Sunday is 7, as the API counts them. */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

function useDayName(): (day: number) => string {
  const intl = useIntl();
  return (day) =>
    intl.formatDate(new Date(WEEK_START + (day - 1) * DAY_MS), {
      weekday: 'long',
      timeZone: 'UTC',
    });
}

function Recurrence({ recurrence }: { readonly recurrence: WorkflowRecurrence }) {
  const intl = useIntl();
  const dayName = useDayName();
  if (recurrence.frequency === 'daily') {
    return (
      <FormattedMessage
        id="automations.schedule.summary.daily"
        values={{ time: recurrence.time }}
      />
    );
  }
  if (recurrence.frequency === 'weekly') {
    const days = new Intl.ListFormat(intl.locale, { style: 'long', type: 'conjunction' }).format(
      recurrence.weekdays.map(dayName),
    );
    return (
      <FormattedMessage
        id="automations.schedule.summary.weekly"
        values={{ days, time: recurrence.time }}
      />
    );
  }
  return (
    <FormattedMessage
      id="automations.schedule.summary.monthly"
      values={{ day: recurrence.dayOfMonth, time: recurrence.time }}
    />
  );
}

/** What the last occurrence did, in words (ADR-0185): never a code. */
function Outcome({ outcome }: { readonly outcome: ScheduleOutcome }) {
  return <FormattedMessage id={`automations.schedule.outcome.${outcome}`} />;
}

/** The schedule's line on a workflow's card, with the controls it allows. */
export function ScheduleLine({
  schedule,
  workflowVersion,
  canManage,
  busy,
  onChange,
  onSwitchOff,
}: {
  /** null: the workflow never repeated. */
  readonly schedule: WorkflowScheduleView | null;
  readonly workflowVersion: number;
  /** `workflow.manage`, `plan.create` and `approval.approve`: the standing approval's three. */
  readonly canManage: boolean;
  readonly busy: boolean;
  readonly onChange: () => void;
  readonly onSwitchOff: () => void;
}) {
  const intl = useIntl();
  const on = schedule !== null && schedule.status === 'on';
  const at = (iso: string, zone: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short', timeZone: zone });
  return (
    <>
      <span className="mo-list-item__meta">
        {schedule === null || !on ? (
          <FormattedMessage
            id={schedule === null ? 'automations.schedule.none' : 'automations.schedule.off'}
          />
        ) : (
          <>
            <Recurrence recurrence={schedule.recurrence} />
            {schedule.nextRunAt === null ? null : (
              <>
                {' '}
                <FormattedMessage
                  id="automations.schedule.next"
                  values={{
                    at: at(schedule.nextRunAt, schedule.timeZone),
                    zone: schedule.timeZone,
                  }}
                />
              </>
            )}
            {schedule.last === null ? null : (
              <>
                {' '}
                <FormattedMessage
                  id="automations.schedule.last"
                  values={{
                    at: at(schedule.last.at, schedule.timeZone),
                    outcome: <Outcome outcome={schedule.last.outcome} />,
                  }}
                />
              </>
            )}
          </>
        )}
      </span>
      {on && schedule.workflowVersion !== workflowVersion ? (
        <StateMessage kind="warning">
          <FormattedMessage
            id="automations.schedule.stale"
            values={{ version: schedule.workflowVersion }}
          />
        </StateMessage>
      ) : null}
      {canManage ? (
        <span className="mo-list-item__actions">
          <Button size="sm" variant="secondary" disabled={busy} onClick={onChange}>
            <FormattedMessage
              id={on ? 'automations.schedule.change' : 'automations.schedule.set'}
            />
          </Button>
          {on ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={onSwitchOff}>
              <FormattedMessage id="automations.schedule.off.action" />
            </Button>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/** Sets a workflow's schedule: how often, at what time, and the standing approval it gives. */
export function ScheduleForm({
  initial,
  workflowVersion,
  busy,
  error,
  onSave,
  onCancel,
}: {
  /** The schedule's current recurrence, to start from; absent for a new one. */
  readonly initial?: WorkflowRecurrence | undefined;
  readonly workflowVersion: number;
  readonly busy: boolean;
  /** A message id for the last save's refusal. */
  readonly error?: string | undefined;
  readonly onSave: (recurrence: WorkflowRecurrence) => void;
  readonly onCancel: () => void;
}) {
  const intl = useIntl();
  const dayName = useDayName();
  const [frequency, setFrequency] = useState<WorkflowRecurrence['frequency']>(
    initial?.frequency ?? 'daily',
  );
  const [time, setTime] = useState(initial?.time ?? '09:00');
  const [weekdays, setWeekdays] = useState<readonly number[]>(
    initial?.frequency === 'weekly' ? initial.weekdays : [1],
  );
  const [dayOfMonth, setDayOfMonth] = useState(
    initial?.frequency === 'monthly' ? initial.dayOfMonth : 1,
  );
  const ready = TIME.test(time) && (frequency !== 'weekly' || weekdays.length > 0);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || busy) return;
    if (frequency === 'daily') onSave({ frequency, time });
    else if (frequency === 'weekly') {
      onSave({ frequency, time, weekdays: [...weekdays].sort((a, b) => a - b) });
    } else onSave({ frequency, time, dayOfMonth });
  }

  return (
    <form className="automations__schedule-form" onSubmit={submit}>
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="automations.schedule.frequency" />
        </span>
        <select
          value={frequency}
          onChange={(e) => setFrequency(e.target.value as WorkflowRecurrence['frequency'])}
        >
          <option value="daily">
            {intl.formatMessage({ id: 'automations.schedule.frequency.daily' })}
          </option>
          <option value="weekly">
            {intl.formatMessage({ id: 'automations.schedule.frequency.weekly' })}
          </option>
          <option value="monthly">
            {intl.formatMessage({ id: 'automations.schedule.frequency.monthly' })}
          </option>
        </select>
      </label>
      <label className="mo-field">
        <span className="mo-label">
          <FormattedMessage id="automations.schedule.time" />
        </span>
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} required />
      </label>
      {frequency === 'weekly' ? (
        <fieldset className="automations__days">
          <legend className="mo-label">
            <FormattedMessage id="automations.schedule.weekdays" />
          </legend>
          {WEEKDAYS.map((day) => (
            <label key={day} className="automations__day">
              <input
                type="checkbox"
                checked={weekdays.includes(day)}
                onChange={(e) =>
                  setWeekdays(
                    e.target.checked ? [...weekdays, day] : weekdays.filter((d) => d !== day),
                  )
                }
              />
              {dayName(day)}
            </label>
          ))}
        </fieldset>
      ) : null}
      {frequency === 'monthly' ? (
        <label className="mo-field">
          <span className="mo-label">
            <FormattedMessage id="automations.schedule.dayOfMonth" />
          </span>
          <select value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value))}>
            {Array.from({ length: 28 }, (_, i) => i + 1).map((day) => (
              <option key={day} value={day}>
                {day}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <p className="automations__meta">
        <FormattedMessage id="automations.schedule.consent" values={{ version: workflowVersion }} />
      </p>
      {error === undefined ? null : (
        <StateMessage kind="error">
          <FormattedMessage id={error} />
        </StateMessage>
      )}
      <div className="mo-form__actions">
        <Button type="submit" size="sm" loading={busy} disabled={!ready || busy}>
          <FormattedMessage id="automations.schedule.save" />
        </Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onCancel}>
          <FormattedMessage id="automations.schedule.cancel" />
        </Button>
      </div>
    </form>
  );
}
