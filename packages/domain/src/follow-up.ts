import type { ContactId } from './conversation.js';
import type { Brand, IsoTimestamp, OrganizationId, UserId } from './ids.js';
import type { OpportunityId } from './opportunity.js';

/**
 * Commercial follow-ups (C5, ADR-0058): something a member must do about a contact or an
 * opportunity at a set time, in the business's time zone. When its time comes, the scheduler
 * marks it due and the office's activity shows it to the assignee. It never sends anything to the
 * contact: a MESSAGE follow-up is a reminder to write, not a message.
 */

export type FollowUpId = Brand<string, 'FollowUpId'>;

export type FollowUpStatus = 'scheduled' | 'due' | 'completed' | 'cancelled' | 'failed';

export type FollowUpType = 'follow_up' | 'call' | 'message' | 'review' | 'check_in';

/**
 * Who proposed it: a person (`manual`, level A) or GIA with the person's confirmation (`gia`,
 * level B). `rule` is reserved for automatic rules (level C), which are not enabled.
 */
export type FollowUpSource = 'manual' | 'gia' | 'rule';

/** Why a follow-up was cancelled: a person, or its record had ended when its time came. */
export type FollowUpCancelReason = 'person' | 'opportunity_closed' | 'contact_archived';

/** Why it failed: its task could not be queued, or the queue gave up retrying it. */
export type FollowUpFailure = 'not_scheduled' | 'retries_exhausted';

/** One earlier time, kept when a follow-up is rescheduled or reopened. */
export interface FollowUpReschedule {
  readonly from: IsoTimestamp;
  readonly to: IsoTimestamp;
  readonly status: FollowUpStatus;
  readonly at: IsoTimestamp;
  readonly by: UserId;
}

export interface FollowUp {
  readonly id: FollowUpId;
  readonly organizationId: OrganizationId;
  readonly contactId: ContactId;
  readonly opportunityId?: OpportunityId;
  /** The member who must do it: the responsible person of the record, unless one is chosen. */
  readonly assignedTo: UserId;
  readonly type: FollowUpType;
  readonly title: string;
  readonly description?: string;
  /** The instant it is due, in UTC. */
  readonly scheduledAt: IsoTimestamp;
  /** The time zone it was scheduled in: its local date and time are read in this zone. */
  readonly timeZone: string;
  readonly status: FollowUpStatus;
  readonly source: FollowUpSource;
  /**
   * Which scheduling this is: it grows with every reschedule, and a scheduler task carries it, so
   * a task for an earlier time finds a different number and does nothing.
   */
  readonly schedule: number;
  readonly history: readonly FollowUpReschedule[];
  readonly dueAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  readonly completedBy?: UserId;
  readonly cancelledAt?: IsoTimestamp;
  readonly cancelledBy?: UserId;
  readonly cancelReason?: FollowUpCancelReason;
  readonly failure?: FollowUpFailure;
  readonly failedAt?: IsoTimestamp;
  /** Codes only, never personal data: today, the automation level it came from. */
  readonly metadata: { readonly automation: 'manual' | 'suggested' };
  readonly revision: number;
  readonly createdBy: UserId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * A record's next action (C1 contacts, C2 opportunities). With `followUpId`, it is the record's
 * earliest open follow-up, kept in step by the follow-ups themselves (ADR-0058): it changes only
 * through them. Without, it is a note a person wrote.
 */
export interface NextAction {
  readonly text: string;
  readonly dueOn: string;
  readonly followUpId?: FollowUpId;
}
