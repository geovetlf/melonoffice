import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useRef } from 'react';
import { navigate } from '../../identity/router.js';
import { MELON_MARK } from '../../shell/mark.js';
import { paths } from '../../shell/routes.js';
import { departmentName } from '../departments.js';
import { Icon } from '../icons.js';
import type { DepartmentView } from '../officeClient.js';
import { readyList, useOfficeData } from '../OfficeData.js';
import { isCurrentTask, type AgentWork } from './agentWork.js';
import type { MotorState } from './motor.js';

/**
 * MelonMotor, opened (Home V4): the office's nervous system in words. It lists the work that is
 * really moving: plans handing work from one department to another, and the tasks each
 * department's agents have under way. With nothing moving, it says so.
 */
export function MotorPanel({
  motor,
  work,
  canReadPlans,
  onClose,
}: {
  readonly motor: MotorState;
  readonly work: AgentWork;
  /** `plan.read`: a way to the automations, where the plans are. */
  readonly canReadPlans: boolean;
  readonly onClose: () => void;
}) {
  const intl = useIntl();
  const { departments, specialists } = useOfficeData();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    globalThis.addEventListener('keydown', onKey);
    return () => globalThis.removeEventListener('keydown', onKey);
  }, [onClose]);

  const all = readyList(departments);
  const byType = (type: string): string => {
    const department = all.find((d) => d.typeId === type);
    return department === undefined
      ? intl.formatMessage({ id: 'office.department.unnamed' })
      : departmentName(intl, department);
  };
  const busy = all
    .map((department: DepartmentView) => ({
      department,
      open: readyList(specialists).filter(
        (agent) => agent.departmentId === department.id && isCurrentTask(work.get(agent.id)),
      ).length,
    }))
    .filter((entry) => entry.open > 0);
  const flows = motor.status === 'ready' ? motor.flows : [];

  return (
    <section id="motor-panel" className="motor-panel" role="dialog" aria-labelledby="motor-title">
      <header className="motor-panel__header">
        <img src={MELON_MARK} alt="" width={36} height={36} />
        <div>
          <h2 id="motor-title" ref={heading} tabIndex={-1}>
            <FormattedMessage id="office.motor.name" />
          </h2>
          <p>
            <FormattedMessage id="office.motor.lead" />
          </p>
        </div>
        <button
          type="button"
          className="agent-sheet__close"
          aria-label={intl.formatMessage({ id: 'office.motor.close' })}
          onClick={onClose}
        >
          <Icon name="close" size={18} />
        </button>
      </header>
      <h3 className="motor-panel__title">
        <FormattedMessage id="office.motor.flows" />
      </h3>
      {motor.status === 'loading' ? (
        <p className="panel__empty" role="status">
          <FormattedMessage id="office.motor.loading" />
        </p>
      ) : motor.status === 'error' ? (
        <p className="panel__empty" role="alert">
          <FormattedMessage id="office.motor.error" />
        </p>
      ) : motor.status === 'hidden' ? (
        <p className="panel__empty">
          <FormattedMessage id="office.motor.flowsHidden" />
        </p>
      ) : flows.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="office.motor.noFlows" values={{ count: motor.running }} />
        </p>
      ) : (
        <ul className="motor-panel__list">
          {flows.map((flow, i) => (
            <li key={`${flow.planId}-${i}`}>
              <span className="motor-panel__route">
                {byType(flow.from)}
                <Icon name="send" size={14} />
                {byType(flow.to)}
              </span>
              <span className="motor-panel__meta">{flow.summary}</span>
            </li>
          ))}
        </ul>
      )}
      <h3 className="motor-panel__title">
        <FormattedMessage id="office.motor.work" />
      </h3>
      {busy.length === 0 ? (
        <p className="panel__empty">
          <FormattedMessage id="office.motor.noWork" />
        </p>
      ) : (
        <ul className="motor-panel__list">
          {busy.map(({ department, open }) => (
            <li key={department.id}>
              <span className="motor-panel__route">
                <FormattedMessage id="office.motor.hub" />
                <Icon name="send" size={14} />
                {departmentName(intl, department)}
              </span>
              <span className="motor-panel__meta">
                <FormattedMessage id="office.motor.tasks" values={{ count: open }} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {canReadPlans ? (
        <button type="button" className="panel__link" onClick={() => navigate(paths.automations())}>
          <FormattedMessage id="office.motor.automations" />
        </button>
      ) : null}
    </section>
  );
}
