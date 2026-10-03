import { FormattedMessage, useIntl } from '@melonoffice/i18n';
import { PageHeader, PeriodPicker, StateMessage } from '@melonoffice/ui';
import { useEffect, useState } from 'react';
import {
  ACTIVITY_PERIODS,
  ActivityList,
  useActivity,
  type ActivityState,
} from '../activity/ActivityFeed.js';
import type { ActivityPeriod } from '../activity/activityClient.js';
import { OfficeBreadcrumb } from '../office/DepartmentOffice.js';
import { GiaAvatar } from './GiaAvatar.js';
import { GiaPortrait } from './character.js';
import { openedWith } from '../shell/routes.js';
import { GiaConversation, TeamResult, useGiaChat } from './GiaChat.js';

/**
 * GIA's Workplace (ADR-0050): GIA's own office, entered from the Home like a department's. It
 * shows GIA, her desk, her state, her chat (ADR-0052), what she can do, what she has done and
 * room for what comes. Everything comes from real data or says that it does not exist yet:
 * nothing is simulated.
 */

/** What GIA does in phase 1 (decisions of 2026-09-28), through her chat. */
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
  const intl = useIntl();
  // Keyboard users land on the page's title: the PageHeader's h1, found by its id.
  useEffect(() => {
    const title = document.getElementById('gia-workplace-title');
    if (title === null) return;
    title.tabIndex = -1;
    title.focus();
  }, []);
  const [period, setPeriod] = useState<ActivityPeriod>('week');
  const activity = useActivity(period);
  const chat = useGiaChat();
  // Opened from a plan's "result available" notice (ADR-0119).
  const [planId] = useState(() => openedWith('plan'));
  return (
    <article className="mo-page gia-workplace">
      <OfficeBreadcrumb trail={[{ label: <FormattedMessage id="gia.name" /> }]} />
      <PageHeader
        className="gia-workplace__header"
        titleId="gia-workplace-title"
        leading={<GiaAvatar size={72} decorative />}
        title={<FormattedMessage id="gia.name" />}
        description={<FormattedMessage id="gia.role" />}
      />

      {planId === undefined ? null : <TeamResult planId={planId} />}

      {/* Talking to GIA: her portrait from the chest up beside the conversation. */}
      <section className="mo-panel mo-page-section gia-workplace__chat" aria-labelledby="gia-chat">
        <GiaPortrait className="gia-workplace__portrait" />
        <div className="gia-workplace__talk">
          <h2 id="gia-chat" className="mo-section-title">
            <FormattedMessage id="gia.chat.title" />
          </h2>
          <GiaConversation />
        </div>
      </section>

      <div className="gia-workplace__grid">
        <section className="mo-panel mo-page-section" aria-labelledby="gia-state">
          <h2 id="gia-state" className="mo-section-title">
            <FormattedMessage id="gia.workplace.state.title" />
          </h2>
          <p className={`gia-state${chat.available ? ' gia-state--ready' : ''}`}>
            <span className="gia-state__dot" aria-hidden="true" />
            <FormattedMessage
              id={chat.available ? 'gia.workplace.state.ready' : 'gia.chat.unavailable'}
            />
          </p>
          <p className="mo-hint">
            <FormattedMessage id="gia.workplace.state.source" />
          </p>
        </section>

        <section className="mo-panel mo-page-section" aria-labelledby="gia-capabilities">
          <h2 id="gia-capabilities" className="mo-section-title">
            <FormattedMessage id="gia.workplace.capabilities.title" />
          </h2>
          <ul className="mo-list">
            {GIA_CAPABILITIES.map((capability) => (
              <li key={capability} className="mo-list-item gia-workplace__capability">
                <FormattedMessage id={`gia.capability.${capability}`} />
              </li>
            ))}
          </ul>
          <h3 className="mo-subsection-title">
            <FormattedMessage id="gia.workplace.limits.title" />
          </h3>
          <ul className="gia-limits">
            {GIA_LIMITS.map((limit) => (
              <li key={limit}>
                <FormattedMessage id={`gia.limit.${limit}`} />
              </li>
            ))}
          </ul>
          <p className="mo-hint">
            <FormattedMessage id="gia.limit.proposals" />
          </p>
        </section>
      </div>

      <div className="gia-workplace__grid">
        <section className="mo-panel mo-page-section" aria-labelledby="gia-history">
          <h2 id="gia-history" className="mo-section-title">
            <FormattedMessage id="gia.workplace.history.title" />
          </h2>
          {activity.status === 'hidden' ? null : (
            <PeriodPicker
              label={intl.formatMessage({ id: 'activity.period.label' })}
              options={ACTIVITY_PERIODS}
              value={period}
              onChange={setPeriod}
              renderOption={(p) => <FormattedMessage id={`activity.period.${p}`} />}
              className="gia-workplace__period"
            />
          )}
          <GiaHistory state={giaOnly(activity)} />
        </section>

        <section className="mo-panel mo-page-section" aria-labelledby="gia-actions">
          <h2 id="gia-actions" className="mo-section-title">
            <FormattedMessage id="gia.workplace.actions.title" />
          </h2>
          <StateMessage kind="empty">
            <FormattedMessage id="gia.workplace.actions.body" />
          </StateMessage>
        </section>
      </div>
    </article>
  );
}

/** GIA's history: her own entries, or a plain statement that there are none yet. */
function GiaHistory({ state }: { readonly state: ActivityState }) {
  if (state.status === 'ready' && state.page.items.length === 0) {
    return (
      <StateMessage kind="empty">
        <FormattedMessage id="gia.workplace.history.empty" />
      </StateMessage>
    );
  }
  return <ActivityList state={state} />;
}
