import type {
  AttentionKind,
  CommercialInsights,
  InsightContact,
  InsightFollowUp,
  InsightOpportunity,
} from '@melonoffice/conversations';
import type { Decider, DeciderContext } from '../engine.js';
import {
  DecisionError,
  highest,
  priorityRank,
  ruleRef,
  type DecisionEvidence,
  type DecisionItem,
  type DecisionPriority,
  type DecisionReason,
  type RecommendedAction,
} from '../model.js';

/**
 * What to attend to first (`commercial.priorities`, ADR-0065): the commercial records the person
 * may read, ranked by fixed rules. It reuses the C4 insights (ADR-0057), which already find what
 * needs attention by their own rules (overdue next actions, close dates, quiet high values…) and
 * the C5 follow-ups; this decider only turns each into a decision with a priority, its reasons,
 * the data behind them and the next step. No model is used and nothing is sent or changed.
 */

/** Each rule, versioned: a result names the rules it applied. */
export const COMMERCIAL_RULES = Object.freeze({
  followUpOverdue: { id: 'commercial.follow_up_overdue', version: 1 },
  followUpToday: { id: 'commercial.follow_up_today', version: 1 },
  attention: { id: 'commercial.attention', version: 1 },
});

/**
 * How each C4 attention reason becomes a decision: its outcome, its priority and the next step.
 * A record with several reasons takes its most pressing one.
 */
export const ATTENTION_DECISIONS: Readonly<
  Record<
    AttentionKind,
    { readonly outcome: string; readonly priority: DecisionPriority; readonly next: string }
  >
> = Object.freeze({
  overdue_next_action: { outcome: 'next_action_overdue', priority: 'high', next: 'do_next_action' },
  close_date_passed: { outcome: 'close_date_passed', priority: 'high', next: 'review_opportunity' },
  waiting_reply: { outcome: 'customer_waiting', priority: 'high', next: 'reply_customer' },
  next_action_today: { outcome: 'next_action_due', priority: 'medium', next: 'do_next_action' },
  closing_soon: { outcome: 'closing_soon', priority: 'medium', next: 'review_opportunity' },
  quiet_high_value: {
    outcome: 'high_value_quiet',
    priority: 'medium',
    next: 'reactivate_opportunity',
  },
  lead_without_follow_up: {
    outcome: 'lead_without_follow_up',
    priority: 'low',
    next: 'schedule_follow_up',
  },
  inactive_customer: { outcome: 'customer_inactive', priority: 'low', next: 'reactivate_customer' },
});

export const MAX_PRIORITY_ITEMS = 10;

interface Input {
  readonly limit: number;
}

function parse(raw: unknown): Input {
  if (raw === undefined || raw === null) return { limit: 5 };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new DecisionError('invalid_input');
  const { limit } = raw as Record<string, unknown>;
  if (limit === undefined) return { limit: 5 };
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new DecisionError('invalid_input', 'limit');
  }
  return { limit: Math.min(limit, MAX_PRIORITY_ITEMS) };
}

const reason = (
  rule: { readonly id: string; readonly version: number },
  code: string,
  params: Record<string, string | number> = {},
): DecisionReason => Object.freeze({ code, rule: ruleRef(rule), params: Object.freeze(params) });

const evidence = (
  source: DecisionEvidence['source'],
  ref: DecisionEvidence['ref'],
  fact: string,
  value: DecisionEvidence['value'],
): DecisionEvidence => Object.freeze({ source, ref, fact, value });

function opportunityEvidence(o: InsightOpportunity): DecisionEvidence[] {
  const ref = { type: 'opportunity', id: o.id };
  return [
    evidence('opportunity', ref, 'status', o.status),
    ...(o.value === null
      ? [evidence('opportunity', ref, 'value', null)]
      : [
          evidence('opportunity', ref, 'value_minor', o.value.amountMinor),
          evidence('opportunity', ref, 'currency', o.value.currency),
        ]),
  ];
}

const money = (o: InsightOpportunity | undefined): Record<string, string | number> =>
  o?.value === null || o?.value === undefined
    ? {}
    : { amountMinor: o.value.amountMinor, currency: o.value.currency };

/** An overdue or due-today follow-up (C5), with the opportunity it is about when it has one. */
function followUpItem(
  f: InsightFollowUp,
  records: CommercialInsights['records'],
): DecisionItem | undefined {
  if (f.when !== 'overdue' && f.when !== 'today') return undefined;
  const opportunity = records.opportunities.find((o) => o.ref === f.opportunity);
  const open = opportunity?.status === 'open' ? opportunity : undefined;
  const overdue = f.when === 'overdue';
  const rule = overdue ? COMMERCIAL_RULES.followUpOverdue : COMMERCIAL_RULES.followUpToday;
  // An overdue follow-up about an open sale comes first: the sale is at stake.
  const priority: DecisionPriority = overdue ? (open === undefined ? 'medium' : 'high') : 'medium';
  const reasons = [
    overdue
      ? reason(rule, 'follow_up_overdue', { days: -f.days, title: f.title })
      : reason(rule, 'follow_up_today', { time: f.time, title: f.title }),
    ...(open === undefined
      ? []
      : [reason(rule, 'open_opportunity', { title: open.title, ...money(open) })]),
  ];
  const ref = { type: 'follow_up', id: f.id };
  return Object.freeze({
    outcome: 'follow_up_required',
    priority,
    subject: Object.freeze({ ...ref, label: f.title }),
    reasons: Object.freeze(reasons),
    evidence: Object.freeze([
      evidence('follow_up', ref, 'due_on', f.date),
      evidence('follow_up', ref, 'days_from_today', f.days),
      evidence('follow_up', ref, 'assignee', f.assignee),
      ...(open === undefined ? [] : opportunityEvidence(open)),
    ]),
    requiredApproval: false,
    recommendedAction: Object.freeze({
      code: 'contact_customer',
      action: null,
      link: ref,
    }) satisfies RecommendedAction,
  });
}

function recordOf(
  ref: string,
  records: CommercialInsights['records'],
):
  | { readonly type: 'opportunity'; readonly record: InsightOpportunity }
  | { readonly type: 'contact'; readonly record: InsightContact }
  | { readonly type: 'conversation'; readonly id: string; readonly label: string | null }
  | undefined {
  const opportunity = records.opportunities.find((o) => o.ref === ref);
  if (opportunity !== undefined) return { type: 'opportunity', record: opportunity };
  const contact = records.contacts.find((c) => c.ref === ref);
  if (contact !== undefined) return { type: 'contact', record: contact };
  const conversation = records.conversations.find((c) => c.ref === ref);
  if (conversation !== undefined) {
    const label = records.contacts.find((c) => c.ref === conversation.contact)?.name ?? null;
    return { type: 'conversation', id: conversation.id, label };
  }
  return undefined;
}

/** A record C4 flagged, as a decision from its most pressing reason. */
function attentionItem(
  item: CommercialInsights['attention'][number],
  records: CommercialInsights['records'],
  canScheduleFollowUp: boolean,
): DecisionItem | undefined {
  const found = recordOf(item.ref, records);
  const first = item.reasons[0];
  if (found === undefined || first === undefined) return undefined;
  const decision = ATTENTION_DECISIONS[first.kind];
  const rule = COMMERCIAL_RULES.attention;
  const subject =
    found.type === 'opportunity'
      ? { type: 'opportunity', id: found.record.id as string, label: found.record.title }
      : found.type === 'contact'
        ? { type: 'contact', id: found.record.id as string, label: found.record.name }
        : { type: 'conversation', id: found.id, label: found.label };
  const ref = { type: subject.type, id: subject.id };
  const extra = found.type === 'opportunity' ? money(found.record) : {};
  const reasons = item.reasons.map((r) =>
    reason(rule, r.kind, {
      days: r.days,
      ...(r.date === null ? {} : { date: r.date }),
      ...extra,
    }),
  );
  const facts: DecisionEvidence[] = item.reasons.map((r) =>
    evidence(found.type, ref, r.kind, r.date ?? r.days),
  );
  if (found.type === 'opportunity') facts.push(...opportunityEvidence(found.record));
  if (found.type === 'contact') facts.push(evidence('contact', ref, 'stage', found.record.stage));
  // A follow-up for a lead can be prepared by GIA when the person may schedule one.
  const action =
    decision.next === 'schedule_follow_up' && canScheduleFollowUp ? 'follow_up.schedule' : null;
  return Object.freeze({
    outcome: decision.outcome,
    priority: decision.priority,
    subject: Object.freeze(subject),
    reasons: Object.freeze(reasons),
    evidence: Object.freeze(facts),
    requiredApproval: false,
    recommendedAction: Object.freeze({ code: decision.next, action, link: ref }),
  });
}

/** The ranked decisions over what the person may read; pure, for any caller that has insights. */
export function commercialPriorities(
  insights: CommercialInsights,
  options: { readonly limit: number; readonly canScheduleFollowUp: boolean },
): readonly DecisionItem[] {
  const { records } = insights;
  const items: DecisionItem[] = [];
  for (const f of records.followUps) {
    const item = followUpItem(f, records);
    if (item !== undefined) items.push(item);
  }
  for (const a of insights.attention) {
    const item = attentionItem(a, records, options.canScheduleFollowUp);
    if (item !== undefined) items.push(item);
  }
  const days = (item: DecisionItem) =>
    Math.max(0, ...item.evidence.map((e) => (e.fact === 'days_from_today' ? -Number(e.value) : 0)));
  // Stable: the C4 order within one priority, overdue follow-ups by how late they are.
  return Object.freeze(
    items
      .map((item, index) => ({ item, index }))
      .sort(
        (a, b) =>
          priorityRank(a.item.priority) - priorityRank(b.item.priority) ||
          days(b.item) - days(a.item) ||
          a.index - b.index,
      )
      .map(({ item }) => item)
      .slice(0, options.limit),
  );
}

export const commercialPrioritiesDecider = Object.freeze<Decider<Input>>({
  type: 'commercial.priorities',
  version: 1,
  category: 'priority',
  permissions: ['decision.evaluate'],
  requires: [],
  usesAI: false,
  parse,
  async decide(context: DeciderContext, input: Input) {
    const { tenant, ports, preload } = context;
    const insights =
      preload.commercial ??
      (ports.commercial === undefined ? undefined : await ports.commercial.read(tenant));
    const rules = Object.values(COMMERCIAL_RULES).map(ruleRef);
    if (insights === undefined) {
      return {
        outcome: 'insufficient_context',
        priority: null,
        reasons: [reason(COMMERCIAL_RULES.attention, 'commercial_not_available')],
        evidence: [],
        requiredApproval: false,
        recommendedAction: null,
        warnings: ['commercial_not_available'],
        rules,
        sourceContext: { sources: [], withheld: [] },
      };
    }
    const withheld = [
      ...(insights.contacts === null ? ['contacts'] : []),
      ...(insights.opportunities === null ? ['opportunities'] : []),
      ...(insights.conversations === null ? ['conversations'] : []),
      ...(insights.followUps === null ? ['follow_ups'] : []),
    ];
    const canScheduleFollowUp =
      context.actions.evaluateAction(tenant, 'follow_up.schedule').outcome !== 'unavailable';
    const items = commercialPriorities(insights, { limit: input.limit, canScheduleFollowUp });
    const partial =
      insights.contacts?.partial === true ||
      insights.opportunities?.partial === true ||
      insights.followUps?.partial === true;
    const nothingReadable = withheld.length === 4;
    const first = items[0];
    return {
      outcome: nothingReadable
        ? 'insufficient_context'
        : items.length === 0
          ? 'nothing_pending'
          : 'attention_needed',
      priority: highest(items.map((i) => i.priority)),
      reasons: nothingReadable
        ? [reason(COMMERCIAL_RULES.attention, 'no_commercial_permission')]
        : [
            reason(COMMERCIAL_RULES.attention, 'items_found', {
              count: items.length,
              high: items.filter((i) => i.priority === 'high').length,
            }),
          ],
      evidence: [],
      items,
      requiredApproval: false,
      recommendedAction: first?.recommendedAction ?? null,
      constraints: partial ? ['lists_partial'] : [],
      warnings: withheld.length > 0 && !nothingReadable ? ['some_records_withheld'] : [],
      rules,
      sourceContext: { sources: ['commercial'], withheld },
    };
  },
});
