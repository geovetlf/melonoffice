import { FormattedMessage } from '@melonoffice/i18n';
import { OfficeScene } from '../office/OfficeScene.js';
import { readyList, useOfficeData } from '../office/OfficeData.js';
import { GiaCard, GiaCommandBar, QuickActions } from './gia.js';
import { CreditsUsage, RecentActivity, UpcomingMeetings } from './panels.js';
import type { ApprovalsClient } from '../approvals/approvalsClient.js';
import type { FollowUpsClient } from '../followUps/followUpsClient.js';
import { TodayWork } from './TodayWork.js';

/**
 * The Home (ADR-0040, level 1): the organization's office, seen whole, with GIA at hand and the
 * day's context underneath. The office is the page; the panels complement it.
 */
export function HomePage({
  canReadAIUsage = false,
  followUps,
  approvals,
}: {
  readonly canReadAIUsage?: boolean;
  /** Today's follow-ups, for a person with `follow_up.read`. */
  readonly followUps?: FollowUpsClient | undefined;
  /** Approvals waiting, for a person with `approval.read`. */
  readonly approvals?: ApprovalsClient | undefined;
}) {
  const { specialists, credits } = useOfficeData();
  const active = readyList(specialists).filter((s) => s.status === 'active').length;
  return (
    <div className="home">
      <div className="home__stage">
        <header className="home__hero">
          <p className="home__greeting">
            <FormattedMessage id="home.greeting" />
          </p>
          <h1 className="home__title">
            <FormattedMessage id={active > 0 ? 'home.hero.working' : 'home.hero.ready'} />
          </h1>
          <p className="home__subtitle">
            <FormattedMessage id="home.hero.subtitle" />
          </p>
        </header>
        <div className="home__gia">
          <GiaCard />
        </div>
        <OfficeScene />
      </div>
      <div className="home__command">
        <GiaCommandBar />
        <QuickActions />
      </div>
      <div className="home__panels">
        <TodayWork followUps={followUps} approvals={approvals} />
        <RecentActivity />
        <UpcomingMeetings />
        <CreditsUsage credits={credits} showUsage={canReadAIUsage} />
      </div>
    </div>
  );
}
