import type {
  Contact,
  ContactId,
  ContactSourceKind,
  ContactStage,
  Conversation,
  ConversationId,
  LostReason,
  Opportunity,
  OpportunityId,
  OpportunityStatus,
  OrganizationId,
  Pipeline,
  UserId,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import type { CustomerService } from './customers.js';
import { ConversationError } from './errors.js';
import type { OpportunityService } from './opportunities.js';
import type { ConversationRepository } from './repository.js';

/**
 * Commercial insights (C4): what GIA reads to answer how sales are going and what to attend to.
 * Everything here is counted and dated from the C1 contacts, the C2 opportunities and the
 * conversations, read through their own services as the person asking; nothing is scored,
 * forecast or written. Each rule is fixed and named, so GIA can say why an item is listed.
 *
 * Amounts are never added across currencies: every total is per currency.
 */

export const INSIGHT_RULES = Object.freeze({
  /** An open opportunity whose expected close date is within these days is closing soon. */
  closingSoonDays: 7,
  /** An open opportunity with no change for these days is quiet. */
  quietOpportunityDays: 14,
  /** A customer with no change, message or opportunity change for these days is inactive. */
  inactiveCustomerDays: 60,
  /** A lead with activity within these days is active. */
  activeLeadDays: 3,
  /** The highest open values listed, per currency, and in all. */
  topValues: 3,
  highestListed: 6,
  /** Items in each list. */
  listed: 5,
  /** Items in "what to attend to". */
  attention: 10,
});

export type InsightOwner = 'you' | 'member' | 'none';

/** A total in one currency, in minor units, with how many opportunities it adds. */
export interface InsightAmount {
  readonly currency: string;
  readonly amountMinor: number;
  readonly count: number;
}

export interface InsightContact {
  /** A short reference (`c_a`), the only way GIA names it back. */
  readonly ref: string;
  readonly id: ContactId;
  readonly name: string | null;
  readonly stage: ContactStage;
  readonly owner: InsightOwner;
  readonly source: ContactSourceKind;
  readonly nextAction: { readonly text: string; readonly dueOn: string } | null;
  /** The latest day anything happened with it, in the business's time zone. */
  readonly lastActivityOn: string;
}

export interface InsightOpportunity {
  readonly ref: string;
  readonly id: OpportunityId;
  readonly title: string;
  /** Its contact's reference, when the person may read contacts. */
  readonly contact: string | null;
  /** A name a person gave the stage, or the template stage's id. */
  readonly stage: { readonly id: string; readonly name: string | null };
  readonly status: OpportunityStatus;
  readonly value: { readonly amountMinor: number; readonly currency: string } | null;
  readonly probability: number;
  readonly owner: InsightOwner;
  readonly expectedCloseOn: string | null;
  readonly nextAction: { readonly text: string; readonly dueOn: string } | null;
  readonly lostReason: LostReason | null;
  readonly lastChangeOn: string;
  readonly closedOn: string | null;
}

export interface InsightConversation {
  readonly ref: string;
  readonly id: ConversationId;
  readonly contact: string | null;
  readonly waitingSince: string;
}

/** Why an item needs attention: a fixed rule, with its date and days. */
export type AttentionKind =
  | 'overdue_next_action'
  | 'next_action_today'
  | 'close_date_passed'
  | 'closing_soon'
  | 'waiting_reply'
  | 'quiet_high_value'
  | 'lead_without_follow_up'
  | 'inactive_customer';

/** The order in which reasons are attended to. */
export const ATTENTION_ORDER: readonly AttentionKind[] = [
  'overdue_next_action',
  'next_action_today',
  'close_date_passed',
  'closing_soon',
  'waiting_reply',
  'quiet_high_value',
  'lead_without_follow_up',
  'inactive_customer',
];

export interface AttentionReason {
  readonly kind: AttentionKind;
  /** The date the rule looked at (due, close or last activity), when it has one. */
  readonly date: string | null;
  /** Days overdue, days left, or days without activity. */
  readonly days: number;
}

export interface AttentionItem {
  readonly ref: string;
  readonly reasons: readonly AttentionReason[];
}

export interface StageInsight {
  readonly id: string;
  readonly name: string | null;
  readonly kind: 'open' | 'won' | 'lost';
  readonly count: number;
  readonly value: readonly InsightAmount[];
}

export interface CommercialInsights {
  readonly timeZone: string;
  readonly today: string;
  /** Monday of this week and the first of this month, in the business's time zone. */
  readonly weekStart: string;
  readonly monthStart: string;
  /** The business's currency, from Company Brain, when known. */
  readonly currency: string | null;
  /** Null when the person may not read contacts. */
  readonly contacts: {
    readonly counts: Readonly<Record<ContactStage, number>>;
    readonly leadsWithoutNextAction: number;
    readonly overdueNextAction: number;
    readonly inactiveCustomers: number;
    readonly newToday: number;
    readonly newThisWeek: number;
    /** More contacts than one read returns: the lists are of the latest ones. */
    readonly partial: boolean;
  } | null;
  /** Null when the person may not read opportunities. */
  readonly opportunities: {
    readonly counts: Readonly<Record<OpportunityStatus, number>>;
    readonly openValue: readonly InsightAmount[];
    readonly openWithoutValue: number;
    readonly wonValue: readonly InsightAmount[];
    readonly wonThisMonth: readonly InsightAmount[];
    readonly wonThisWeek: readonly InsightAmount[];
    readonly stages: readonly StageInsight[];
    readonly closingSoon: number;
    readonly closeDatePassed: number;
    readonly overdueNextAction: number;
    readonly quiet: number;
    readonly lostReasons: Readonly<Partial<Record<LostReason, number>>>;
    readonly createdToday: number;
    readonly createdThisWeek: number;
    readonly wonToday: number;
    readonly lostThisWeek: number;
    readonly partial: boolean;
  } | null;
  /** Null when the person may not read conversations. */
  readonly conversations: { readonly waitingReply: number } | null;
  readonly attention: readonly AttentionItem[];
  readonly lists: {
    readonly highestValue: readonly string[];
    readonly closingSoon: readonly string[];
    readonly activeLeads: readonly string[];
    readonly inactiveCustomers: readonly string[];
    readonly quiet: readonly string[];
    readonly recentWins: readonly string[];
  };
  /** Every contact, opportunity and conversation a reference above names. */
  readonly records: {
    readonly contacts: readonly InsightContact[];
    readonly opportunities: readonly InsightOpportunity[];
    readonly conversations: readonly InsightConversation[];
  };
}

/** The date of an instant in a time zone, as `YYYY-MM-DD`. */
export function dateIn(timeZone: string, at: Date | string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(typeof at === 'string' ? new Date(at) : at);
}

/** A reference's letters, as the AI Gateway's closed codes allow: 1 → `a`, 27 → `aa`. */
function letters(n: number): string {
  let out = '';
  for (let k = n; k > 0; k = Math.floor((k - 1) / 26)) {
    out = String.fromCodePoint(97 + ((k - 1) % 26)) + out;
  }
  return out;
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const daysFrom = (from: string, to: string) => dayNumber(to) - dayNumber(from);
const plusDays = (date: string, days: number) =>
  new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function add(totals: Map<string, { amountMinor: number; count: number }>, o: Opportunity): void {
  if (o.value === undefined) return;
  const total = totals.get(o.value.currency) ?? { amountMinor: 0, count: 0 };
  total.amountMinor += o.value.amountMinor;
  total.count += 1;
  totals.set(o.value.currency, total);
}

const amounts = (totals: Map<string, { amountMinor: number; count: number }>) =>
  Object.freeze(
    [...totals]
      .map(([currency, t]) => Object.freeze({ currency, ...t }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
  );

function totalOf(list: readonly Opportunity[]): readonly InsightAmount[] {
  const totals = new Map<string, { amountMinor: number; count: number }>();
  for (const o of list) add(totals, o);
  return amounts(totals);
}

export interface InsightInput {
  readonly timeZone: string;
  readonly now: Date;
  readonly viewer: UserId;
  readonly currency: string | undefined;
  /** Undefined when the person may not read contacts. */
  readonly contacts?: {
    readonly items: readonly Contact[];
    readonly counts: Readonly<Record<ContactStage, number>>;
    readonly partial: boolean;
  };
  readonly opportunities?: {
    readonly items: readonly Opportunity[];
    readonly counts: Readonly<Record<OpportunityStatus, number>>;
    readonly pipeline: Pipeline;
    readonly partial: boolean;
  };
  readonly conversations?: readonly Conversation[];
}

/** The insights of one organization's records, by the fixed rules above. Pure: no reads. */
export function commercialInsights(input: InsightInput): CommercialInsights {
  const { timeZone, viewer } = input;
  const R = INSIGHT_RULES;
  const today = dateIn(timeZone, input.now);
  const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
  const weekStart = plusDays(today, -((weekday + 6) % 7));
  const monthStart = `${today.slice(0, 8)}01`;
  const on = (at: string) => dateIn(timeZone, at);
  const ownerOf = (id: UserId | undefined): InsightOwner =>
    id === undefined ? 'none' : id === viewer ? 'you' : 'member';

  const contacts = input.contacts?.items ?? [];
  const opportunities = input.opportunities?.items ?? [];
  const conversations = input.conversations ?? [];
  const contactById = new Map(contacts.map((c) => [c.id as string, c]));

  // The latest day anything happened with each contact: its own change, its conversations'
  // last message, its opportunities' last change (each only as the person may read it).
  const lastActivity = new Map<string, string>();
  const touch = (contactId: string, at: string) => {
    const day = on(at);
    const current = lastActivity.get(contactId);
    if (current === undefined || current < day) lastActivity.set(contactId, day);
  };
  for (const c of contacts) touch(c.id, c.updatedAt);
  for (const v of conversations) touch(v.contactId, v.lastMessageAt);
  for (const o of opportunities) touch(o.contactId, o.updatedAt);

  // References are given only to what a list or an attention item names.
  const contactRefs = new Map<string, InsightContact>();
  const opportunityRefs = new Map<string, InsightOpportunity>();
  const conversationRefs = new Map<string, InsightConversation>();
  const contactRef = (c: Contact): string => {
    const known = contactRefs.get(c.id);
    if (known !== undefined) return known.ref;
    const ref = `c_${letters(contactRefs.size + 1)}`;
    const commercial = c.commercial;
    contactRefs.set(
      c.id,
      Object.freeze({
        ref,
        id: c.id,
        name: c.displayName ?? null,
        stage: commercial?.stage ?? 'lead',
        owner: ownerOf(commercial?.ownerId),
        source: commercial?.source.kind ?? 'manual',
        nextAction: commercial?.nextAction ?? null,
        lastActivityOn: lastActivity.get(c.id) ?? on(c.updatedAt),
      }),
    );
    return ref;
  };
  const stages = input.opportunities?.pipeline.stages ?? [];
  const opportunityRef = (o: Opportunity): string => {
    const known = opportunityRefs.get(o.id);
    if (known !== undefined) return known.ref;
    const ref = `o_${letters(opportunityRefs.size + 1)}`;
    const contact = contactById.get(o.contactId);
    const stage = stages.find((s) => s.id === o.stageId);
    opportunityRefs.set(
      o.id,
      Object.freeze({
        ref,
        id: o.id,
        title: o.title,
        contact: contact === undefined ? null : contactRef(contact),
        stage: { id: o.stageId, name: stage?.name ?? null },
        status: o.status,
        value: o.value === undefined ? null : { ...o.value },
        probability: o.probability,
        owner: ownerOf(o.ownerId),
        expectedCloseOn: o.expectedCloseOn ?? null,
        nextAction: o.nextAction ?? null,
        lostReason: o.lostReason ?? null,
        lastChangeOn: on(o.updatedAt),
        closedOn: o.closedAt === undefined ? null : on(o.closedAt),
      }),
    );
    return ref;
  };
  const conversationRef = (v: Conversation, since: string): string => {
    const known = conversationRefs.get(v.id);
    if (known !== undefined) return known.ref;
    const ref = `v_${letters(conversationRefs.size + 1)}`;
    const contact = contactById.get(v.contactId);
    conversationRefs.set(
      v.id,
      Object.freeze({
        ref,
        id: v.id,
        contact: contact === undefined ? null : contactRef(contact),
        waitingSince: since,
      }),
    );
    return ref;
  };

  // What needs attention: every reason of every record, then the most pressing first.
  type Pending = { readonly key: string; readonly make: () => string; reasons: AttentionReason[] };
  const pending = new Map<string, Pending>();
  const flag = (key: string, make: () => string, reason: AttentionReason) => {
    const entry = pending.get(key) ?? { key, make, reasons: [] };
    entry.reasons.push(Object.freeze(reason));
    pending.set(key, entry);
  };

  const open = opportunities.filter((o) => o.status === 'open');
  // The highest open values, per currency: amounts are compared only within one currency.
  const byCurrency = new Map<string, Opportunity[]>();
  for (const o of open) {
    if (o.value === undefined) continue;
    const list = byCurrency.get(o.value.currency) ?? [];
    list.push(o);
    byCurrency.set(o.value.currency, list);
  }
  const highest: Opportunity[] = [];
  for (const [, list] of [...byCurrency].sort(([a], [b]) => a.localeCompare(b))) {
    highest.push(
      ...list
        .toSorted((a, b) => (b.value?.amountMinor ?? 0) - (a.value?.amountMinor ?? 0))
        .slice(0, R.topValues),
    );
  }
  highest.splice(R.highestListed);
  const highIds = new Set(highest.map((o) => o.id as string));

  let closingSoon = 0;
  let closeDatePassed = 0;
  let overdueOpportunities = 0;
  let quiet = 0;
  const closingSoonList: Opportunity[] = [];
  const quietList: Opportunity[] = [];
  for (const o of open) {
    const make = () => opportunityRef(o);
    const key = `o:${o.id}`;
    if (o.nextAction !== undefined) {
      const late = daysFrom(o.nextAction.dueOn, today);
      if (late > 0) {
        overdueOpportunities += 1;
        flag(key, make, { kind: 'overdue_next_action', date: o.nextAction.dueOn, days: late });
      } else if (late === 0) {
        flag(key, make, { kind: 'next_action_today', date: o.nextAction.dueOn, days: 0 });
      }
    }
    if (o.expectedCloseOn !== undefined) {
      const left = daysFrom(today, o.expectedCloseOn);
      if (left < 0) {
        closeDatePassed += 1;
        flag(key, make, { kind: 'close_date_passed', date: o.expectedCloseOn, days: -left });
      } else if (left <= R.closingSoonDays) {
        closingSoon += 1;
        closingSoonList.push(o);
        flag(key, make, { kind: 'closing_soon', date: o.expectedCloseOn, days: left });
      }
    }
    const still = daysFrom(on(o.updatedAt), today);
    if (still >= R.quietOpportunityDays) {
      quiet += 1;
      quietList.push(o);
      if (highIds.has(o.id)) {
        flag(key, make, { kind: 'quiet_high_value', date: on(o.updatedAt), days: still });
      }
    }
  }

  // Leads and customers: a next action that is due, a lead nobody follows up, a quiet customer.
  const followed = new Set(
    open.filter((o) => o.nextAction !== undefined).map((o) => o.contactId as string),
  );
  let leadsWithoutNextAction = 0;
  let overdueContacts = 0;
  let inactiveCustomers = 0;
  const activeLeads: Contact[] = [];
  const inactiveList: Contact[] = [];
  const marked = contacts.filter((c) => c.status !== 'archived' && c.commercial !== undefined);
  for (const c of marked) {
    const commercial = c.commercial;
    if (commercial === undefined) continue;
    const make = () => contactRef(c);
    const key = `c:${c.id}`;
    const last = lastActivity.get(c.id) ?? on(c.updatedAt);
    const since = daysFrom(last, today);
    if (commercial.nextAction !== undefined && commercial.stage !== 'inactive') {
      const late = daysFrom(commercial.nextAction.dueOn, today);
      if (late > 0) {
        overdueContacts += 1;
        flag(key, make, {
          kind: 'overdue_next_action',
          date: commercial.nextAction.dueOn,
          days: late,
        });
      } else if (late === 0) {
        flag(key, make, { kind: 'next_action_today', date: commercial.nextAction.dueOn, days: 0 });
      }
    }
    if (commercial.stage === 'lead') {
      if (commercial.nextAction === undefined && !followed.has(c.id)) {
        leadsWithoutNextAction += 1;
        flag(key, make, { kind: 'lead_without_follow_up', date: last, days: since });
      }
      if (since <= R.activeLeadDays) activeLeads.push(c);
    } else if (commercial.stage === 'customer' && since >= R.inactiveCustomerDays) {
      inactiveCustomers += 1;
      inactiveList.push(c);
      flag(key, make, { kind: 'inactive_customer', date: last, days: since });
    } else if (commercial.stage === 'inactive') {
      inactiveList.push(c);
    }
  }

  // Conversations whose last message is the contact's and has no answer yet.
  let waitingReply = 0;
  if (input.conversations !== undefined) {
    for (const v of conversations) {
      if (v.status === 'closed' || v.lastInboundAt === undefined) continue;
      if (v.lastOutboundAt !== undefined && v.lastOutboundAt >= v.lastInboundAt) continue;
      waitingReply += 1;
      const since = on(v.lastInboundAt);
      flag(`v:${v.id}`, () => conversationRef(v, since), {
        kind: 'waiting_reply',
        date: since,
        days: daysFrom(since, today),
      });
    }
  }

  const rank = (r: AttentionReason) => ATTENTION_ORDER.indexOf(r.kind);
  const attention = [...pending.values()]
    .map((p) => ({ ...p, reasons: p.reasons.toSorted((a, b) => rank(a) - rank(b)) }))
    .sort((a, b) => {
      const [ra, rb] = [a.reasons[0], b.reasons[0]];
      if (ra === undefined || rb === undefined) return 0;
      if (rank(ra) !== rank(rb)) return rank(ra) - rank(rb);
      // Within one rule: the longest overdue or quiet first, the nearest close date first.
      return ra.kind === 'closing_soon' ? ra.days - rb.days : rb.days - ra.days;
    })
    .slice(0, R.attention)
    .map((p) => Object.freeze({ ref: p.make(), reasons: Object.freeze(p.reasons) }));

  const byValue = (a: Opportunity, b: Opportunity) =>
    (b.value?.amountMinor ?? 0) - (a.value?.amountMinor ?? 0);
  const lists = Object.freeze({
    highestValue: Object.freeze(highest.map(opportunityRef)),
    closingSoon: Object.freeze(
      closingSoonList
        .toSorted((a, b) => ((a.expectedCloseOn ?? '') < (b.expectedCloseOn ?? '') ? -1 : 1))
        .slice(0, R.listed)
        .map(opportunityRef),
    ),
    activeLeads: Object.freeze(
      activeLeads
        .toSorted((a, b) =>
          (lastActivity.get(b.id) ?? '') < (lastActivity.get(a.id) ?? '') ? -1 : 1,
        )
        .slice(0, R.listed)
        .map(contactRef),
    ),
    inactiveCustomers: Object.freeze(inactiveList.slice(0, R.listed).map(contactRef)),
    quiet: Object.freeze(quietList.toSorted(byValue).slice(0, R.listed).map(opportunityRef)),
    recentWins: Object.freeze(
      opportunities
        .filter((o) => o.status === 'won' && o.closedAt !== undefined)
        .toSorted((a, b) => ((a.closedAt ?? '') < (b.closedAt ?? '') ? 1 : -1))
        .slice(0, R.listed)
        .map(opportunityRef),
    ),
  });

  const closedIn = (o: Opportunity, from: string) =>
    o.closedAt !== undefined && on(o.closedAt) >= from;
  const won = opportunities.filter((o) => o.status === 'won');
  const lostReasons: Partial<Record<LostReason, number>> = {};
  for (const o of opportunities) {
    if (o.status === 'lost' && o.lostReason !== undefined) {
      lostReasons[o.lostReason] = (lostReasons[o.lostReason] ?? 0) + 1;
    }
  }
  const stageInsights = stages.map((s) => {
    const at = opportunities.filter((o) => o.stageId === s.id);
    return Object.freeze({
      id: s.id,
      name: s.name ?? null,
      kind: s.kind,
      count: at.length,
      value: totalOf(at),
    });
  });

  return Object.freeze({
    timeZone,
    today,
    weekStart,
    monthStart,
    currency: input.currency ?? null,
    contacts:
      input.contacts === undefined
        ? null
        : Object.freeze({
            counts: input.contacts.counts,
            leadsWithoutNextAction,
            overdueNextAction: overdueContacts,
            inactiveCustomers,
            newToday: marked.filter((c) => on(c.createdAt) === today).length,
            newThisWeek: marked.filter((c) => on(c.createdAt) >= weekStart).length,
            partial: input.contacts.partial,
          }),
    opportunities:
      input.opportunities === undefined
        ? null
        : Object.freeze({
            counts: input.opportunities.counts,
            openValue: totalOf(open),
            openWithoutValue: open.filter((o) => o.value === undefined).length,
            wonValue: totalOf(won),
            wonThisMonth: totalOf(won.filter((o) => closedIn(o, monthStart))),
            wonThisWeek: totalOf(won.filter((o) => closedIn(o, weekStart))),
            stages: Object.freeze(stageInsights),
            closingSoon,
            closeDatePassed,
            overdueNextAction: overdueOpportunities,
            quiet,
            lostReasons: Object.freeze(lostReasons),
            createdToday: opportunities.filter((o) => on(o.createdAt) === today).length,
            createdThisWeek: opportunities.filter((o) => on(o.createdAt) >= weekStart).length,
            wonToday: won.filter((o) => closedIn(o, today)).length,
            lostThisWeek: opportunities.filter((o) => o.status === 'lost' && closedIn(o, weekStart))
              .length,
            partial: input.opportunities.partial,
          }),
    conversations: input.conversations === undefined ? null : Object.freeze({ waitingReply }),
    attention: Object.freeze(attention),
    lists,
    records: Object.freeze({
      contacts: Object.freeze([...contactRefs.values()]),
      opportunities: Object.freeze([...opportunityRefs.values()]),
      conversations: Object.freeze([...conversationRefs.values()]),
    }),
  });
}

export interface CommercialInsightService {
  /**
   * What the person may read of the organization's commercial records, analysed. Each part
   * needs its own permission (`contact.read`, `opportunity.read`, `conversation.read`); a part
   * the person may not read is null, and nothing from it reaches another part.
   */
  read(tenant: TenantContext): Promise<CommercialInsights>;
}

export interface CommercialInsightOptions {
  readonly customers: Pick<CustomerService, 'list'>;
  readonly opportunities: Pick<OpportunityService, 'list' | 'pipeline'>;
  readonly conversations: Pick<ConversationRepository, 'listConversations'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** The business's time zone (its profile): "today" and "this week" are its own. */
  readonly timeZone: (organizationId: OrganizationId) => Promise<string>;
  /** The business's currency, from Company Brain. */
  readonly currency: (organizationId: OrganizationId) => Promise<string | undefined>;
  readonly now?: () => Date;
}

export function createCommercialInsights(
  options: CommercialInsightOptions,
): CommercialInsightService {
  const {
    customers,
    opportunities,
    conversations,
    authorization,
    now = () => new Date(),
  } = options;
  return Object.freeze({
    async read(tenant: TenantContext) {
      if (!isResolvedTenant(tenant)) throw new ConversationError('unresolved_tenant');
      const organizationId = tenant.organizationId;
      const may = (permission: Parameters<AuthorizationService['authorize']>[1]) =>
        authorization.authorize(tenant, permission).allowed;
      const [contactList, opportunityList, pipeline, threads, zone, currency] = await Promise.all([
        may('contact.read') ? customers.list(tenant) : undefined,
        may('opportunity.read') ? opportunities.list(tenant) : undefined,
        may('opportunity.read') ? opportunities.pipeline(tenant) : undefined,
        may('conversation.read') ? conversations.listConversations(organizationId) : undefined,
        options.timeZone(organizationId),
        options.currency(organizationId),
      ]);
      const own = <T extends { readonly organizationId: OrganizationId }>(list: readonly T[]) =>
        list.filter((item) => item.organizationId === organizationId);
      return commercialInsights({
        timeZone: isTimeZone(zone) ? zone : 'UTC',
        now: now(),
        viewer: tenant.userId,
        currency,
        ...(contactList === undefined
          ? {}
          : {
              contacts: {
                items: own(contactList.items),
                counts: contactList.counts,
                partial: contactList.hasMore,
              },
            }),
        ...(opportunityList === undefined || pipeline === undefined
          ? {}
          : {
              opportunities: {
                items: own(opportunityList.items),
                counts: {
                  open: opportunityList.summary.open.count,
                  won: opportunityList.summary.won,
                  lost: opportunityList.summary.lost,
                },
                pipeline: pipeline.pipeline,
                partial: opportunityList.hasMore,
              },
            }),
        ...(threads === undefined ? {} : { conversations: own(threads) }),
      });
    },
  });
}
