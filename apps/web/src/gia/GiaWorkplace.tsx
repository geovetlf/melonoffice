import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityList,
  PeriodPicker,
  useActivity,
  type ActivityState,
} from '../activity/ActivityFeed.js';
import type { ActivityPeriod } from '../activity/activityClient.js';
import { OfficeBreadcrumb } from '../office/DepartmentOffice.js';
import { Icon } from '../office/icons.js';
import { GiaAvatar } from './GiaAvatar.js';

/**
 * GIA's Workplace (ADR-0050): GIA's own office, entered from the Home like a department's. It
 * shows GIA, her desk, her state, what she can do, what she has done and room for what comes.
 * Everything comes from real data or says that it does not exist yet: nothing is simulated.
 */

/** What GIA can do in phase 1 (decisions of 2026-09-28). None is connected until the chat is. */
export const GIA_CAPABILITIES = ['answer', 'activity', 'navigate', 'route'] as const;

/** What GIA never does in phase 1, said plainly so no one expects it. */
export const GIA_LIMITS = ['send', 'change', 'pay', 'publish'] as const;

/** GIA's own history: what the audit trail recorded GIA doing, and nothing else. */
export function giaOnly(state: ActivityState): ActivityState {
  if (state.status !== 'ready') return state;
  const items = state.page.items.filter(
    (item) => item.actor === 'gia' || item.action.startsWith('gia.'),
  );
  return { ...state, page: { ...state.page, items } };
}

export function GiaWorkplace() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const [period, setPeriod] = useState<ActivityPeriod>('week');
  const activity = useActivity(period);
  return (
    <article className="dept-office gia-workplace">
      <OfficeBreadcrumb trail={[{ label: <FormattedMessage id="gia.name" /> }]} />
      <header className="dept-office__header gia-workplace__header">
        <GiaAvatar size={72} decorative />
        <div>
          <h1 ref={heading} tabIndex={-1} className="dept-office__title">
            <FormattedMessage id="gia.name" />
          </h1>
          <p className="dept-office__summary">
            <FormattedMessage id="gia.role" />
          </p>
        </div>
      </header>

      <GiaDesk />

      <div className="dept-office__grid">
        <section className="dept-office__section" aria-labelledby="gia-state">
          <h2 id="gia-state">
            <FormattedMessage id="gia.workplace.state.title" />
          </h2>
          <p className="gia-state">
            <span className="gia-state__dot" aria-hidden="true" />
            <FormattedMessage id="gia.workplace.state.preparing" />
          </p>
          <p className="panel__empty">
            <FormattedMessage id="gia.workplace.state.source" />
          </p>
        </section>

        <section className="dept-office__section" aria-labelledby="gia-capabilities">
          <h2 id="gia-capabilities">
            <FormattedMessage id="gia.workplace.capabilities.title" />
          </h2>
          <ul className="coming">
            {GIA_CAPABILITIES.map((capability) => (
              <li key={capability} className="coming__item">
                <FormattedMessage id={`gia.capability.${capability}`} />
                <span className="coming__soon">
                  <FormattedMessage id="common.soon" />
                </span>
              </li>
            ))}
          </ul>
          <h3 className="gia-workplace__subtitle">
            <FormattedMessage id="gia.workplace.limits.title" />
          </h3>
          <ul className="gia-limits">
            {GIA_LIMITS.map((limit) => (
              <li key={limit}>
                <FormattedMessage id={`gia.limit.${limit}`} />
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="dept-office__grid">
        <section className="dept-office__section" aria-labelledby="gia-history">
          <h2 id="gia-history">
            <FormattedMessage id="gia.workplace.history.title" />
          </h2>
          {activity.status === 'hidden' ? null : (
            <PeriodPicker period={period} onChange={setPeriod} labelId="activity.period.label" />
          )}
          <GiaHistory state={giaOnly(activity)} />
        </section>

        <section className="dept-office__section" aria-labelledby="gia-actions">
          <h2 id="gia-actions">
            <FormattedMessage id="gia.workplace.actions.title" />
          </h2>
          <p className="panel__empty">
            <FormattedMessage id="gia.workplace.actions.body" />
          </p>
        </section>
      </div>
    </article>
  );
}

/** GIA's history: her own entries, or a plain statement that there are none yet. */
function GiaHistory({ state }: { readonly state: ActivityState }) {
  if (state.status === 'ready' && state.page.items.length === 0) {
    return (
      <p className="panel__empty">
        <FormattedMessage id="gia.workplace.history.empty" />
      </p>
    );
  }
  return <ActivityList state={state} />;
}

/**
 * GIA's desk, drawn: GIA at her desk with a screen, a lamp and a plant. It is decoration only
 * (hidden from screen readers); the screen shows MelonOffice's mark, never invented work.
 */
function GiaDesk() {
  const intl = useIntl();
  return (
    <figure className="gia-desk" aria-label={intl.formatMessage({ id: 'gia.workplace.desk' })}>
      <svg className="gia-desk__art" viewBox="0 0 480 220" aria-hidden="true" focusable="false">
        {/* Floor and wall line. */}
        <rect x="0" y="176" width="480" height="44" rx="8" fill="rgb(255 226 206 / 0.06)" />
        {/* Plant. */}
        <rect x="40" y="130" width="34" height="46" rx="6" fill="#8a3442" />
        <path d="M57 130 C40 110 44 90 57 80 C70 90 74 110 57 130 Z" fill="#c9a24a" />
        <path d="M57 128 C36 120 30 104 34 94 C48 98 56 110 57 128 Z" fill="#b8893a" />
        <path d="M57 128 C78 120 84 104 80 94 C66 98 58 110 57 128 Z" fill="#b8893a" />
        {/* Desk. */}
        <rect x="120" y="140" width="300" height="12" rx="4" fill="#6b4a3a" />
        <rect x="136" y="152" width="10" height="24" fill="#5a3d30" />
        <rect x="394" y="152" width="10" height="24" fill="#5a3d30" />
        {/* Screen with the MelonOffice mark only. */}
        <rect
          x="286"
          y="72"
          width="110"
          height="64"
          rx="8"
          fill="#241915"
          stroke="#f5b942"
          strokeOpacity="0.5"
        />
        <circle cx="341" cy="104" r="12" fill="#f2784b" opacity="0.8" />
        <rect x="334" y="136" width="14" height="6" fill="#3a2a22" />
        {/* Lamp. */}
        <path
          d="M412 140 L412 96 L392 84"
          fill="none"
          stroke="#d9c2b3"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path d="M378 78 L404 76 L398 92 Z" fill="#f5b942" />
        {/* Mug. */}
        <rect x="258" y="124" width="16" height="16" rx="3" fill="#fff1e6" />
      </svg>
      <div className="gia-desk__gia">
        <GiaAvatar size={112} decorative className="gia-desk__avatar" />
      </div>
      <figcaption className="gia-desk__caption">
        <Icon name="gia" size={16} />
        <FormattedMessage id="gia.workplace.desk" />
      </figcaption>
    </figure>
  );
}
