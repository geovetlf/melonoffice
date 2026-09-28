import type {
  AttentionReason,
  CommercialInsights,
  InsightAmount,
  InsightContact,
  InsightConversation,
  InsightFollowUp,
  InsightOpportunity,
} from '@melonoffice/conversations';
import {
  dateGrid,
  FOLLOW_UP_LIMITS,
  FOLLOW_UP_TYPES,
  INSIGHT_RULES,
} from '@melonoffice/conversations';
import type { GiaLocale } from './catalogue.js';

/**
 * GIA's commercial intelligence (C4): the insights of the organization's contacts,
 * opportunities and conversations, already counted and dated by fixed rules, written for the
 * model as data, and the links an answer may carry. GIA reads, explains and suggests; nothing
 * here writes or sends.
 */

/** Where an answer may take the person, in the app's own Comercial screens. */
export type GiaLink =
  | { readonly kind: 'opportunity'; readonly id: string; readonly label: string }
  | { readonly kind: 'contact'; readonly id: string; readonly label: string | null }
  | { readonly kind: 'conversation'; readonly id: string; readonly label: string | null }
  | { readonly kind: 'follow_up'; readonly id: string; readonly label: string }
  | { readonly kind: 'leads' }
  | { readonly kind: 'customers' }
  | { readonly kind: 'pipeline' }
  | { readonly kind: 'follow_ups' };

/** What GIA says when the person may not read what they asked about. */
export const NO_PERMISSION: Readonly<Record<GiaLocale, string>> = {
  es: 'No tienes permisos para consultar esa información.',
  en: 'You do not have permission to see that information.',
};

/** What GIA says when there are not enough records to answer. */
export const NOT_ENOUGH_DATA: Readonly<Record<GiaLocale, string>> = {
  es: 'Todavía no tengo suficientes datos para responder eso.',
  en: 'I do not have enough data to answer that yet.',
};

/** Every reference the model may name back, and the link it becomes. */
export function commercialLinks(insights: CommercialInsights): ReadonlyMap<string, GiaLink> {
  const links = new Map<string, GiaLink>();
  if (insights.contacts !== null) {
    links.set('leads', { kind: 'leads' });
    links.set('customers', { kind: 'customers' });
  }
  if (insights.opportunities !== null) links.set('pipeline', { kind: 'pipeline' });
  if (insights.followUps !== null) links.set('follow_ups', { kind: 'follow_ups' });
  for (const f of insights.records.followUps) {
    links.set(f.ref, { kind: 'follow_up', id: f.id, label: f.title });
  }
  const contacts = new Map(insights.records.contacts.map((c) => [c.ref, c]));
  for (const o of insights.records.opportunities) {
    links.set(o.ref, { kind: 'opportunity', id: o.id, label: o.title });
  }
  for (const c of insights.records.contacts) {
    links.set(c.ref, { kind: 'contact', id: c.id, label: c.name });
  }
  for (const v of insights.records.conversations) {
    const contact = v.contact === null ? undefined : contacts.get(v.contact);
    links.set(v.ref, { kind: 'conversation', id: v.id, label: contact?.name ?? null });
  }
  return links;
}

/** An amount in its own currency, as the person reads it: `S/ 12,000.00`. */
export function formatAmount(
  amount: { readonly amountMinor: number; readonly currency: string },
  locale: GiaLocale,
): string {
  try {
    const format = new Intl.NumberFormat(locale === 'es' ? 'es-PE' : 'en-US', {
      style: 'currency',
      currency: amount.currency,
    });
    const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
    return format.format(amount.amountMinor / 10 ** digits);
  } catch {
    return `${(amount.amountMinor / 100).toFixed(2)} ${amount.currency}`;
  }
}

const totals = (list: readonly InsightAmount[], locale: GiaLocale) =>
  list.length === 0
    ? 'none'
    : list
        .map(
          (a) =>
            `${formatAmount(a, locale)} (${a.count} ${a.count === 1 ? 'opportunity' : 'opportunities'})`,
        )
        .join('; ');

const REASONS: Readonly<Record<AttentionReason['kind'], (r: AttentionReason) => string>> = {
  overdue_next_action: (r) => `next action was due ${r.date ?? ''}, ${r.days} days late`,
  next_action_today: () => 'next action is due today',
  close_date_passed: (r) => `expected close date ${r.date ?? ''} passed ${r.days} days ago`,
  closing_soon: (r) =>
    r.days === 0
      ? 'expected to close today'
      : `expected to close in ${r.days} days (${r.date ?? ''})`,
  waiting_reply: (r) =>
    `the contact wrote on ${r.date ?? ''} and has no answer yet (${r.days} days)`,
  quiet_high_value: (r) =>
    `one of the highest open values, with no change for ${r.days} days (since ${r.date ?? ''})`,
  lead_without_follow_up: (r) =>
    `lead with no next action and no open opportunity with one (last activity ${r.date ?? ''})`,
  inactive_customer: (r) => `customer with no activity for ${r.days} days (since ${r.date ?? ''})`,
};

const quoted = (text: string) => `"${text.replace(/"/g, "'")}"`;

function opportunityLine(o: InsightOpportunity, locale: GiaLocale): string {
  return [
    `- ${o.ref} opportunity ${quoted(o.title)}`,
    o.contact === null ? null : `contact ${o.contact}`,
    `stage ${o.stage.name === null ? `${o.stage.id} (template stage)` : quoted(o.stage.name)}`,
    o.status,
    o.value === null ? 'no amount' : formatAmount(o.value, locale),
    `probability ${o.probability}%`,
    `owner ${o.owner}`,
    o.expectedCloseOn === null ? 'no expected close date' : `expected close ${o.expectedCloseOn}`,
    o.nextAction === null
      ? 'no next action'
      : `next action ${quoted(o.nextAction.text)} due ${o.nextAction.dueOn}`,
    o.lostReason === null ? null : `lost reason ${o.lostReason}`,
    o.closedOn === null ? null : `closed ${o.closedOn}`,
    `last change ${o.lastChangeOn}`,
  ]
    .filter((part) => part !== null)
    .join(', ');
}

function contactLine(c: InsightContact): string {
  return [
    `- ${c.ref} ${c.stage} ${c.name === null ? '(no name)' : quoted(c.name)}`,
    `owner ${c.owner}`,
    `source ${c.source}`,
    c.nextAction === null
      ? 'no next action'
      : `next action ${quoted(c.nextAction.text)} due ${c.nextAction.dueOn}`,
    `last activity ${c.lastActivityOn}`,
  ].join(', ');
}

function followUpLine(f: InsightFollowUp): string {
  const when =
    f.when === 'overdue'
      ? `overdue by ${-f.days} days`
      : f.when === 'today'
        ? f.status === 'due'
          ? 'due now'
          : 'today'
        : `in ${f.days} days`;
  return [
    `- ${f.ref} follow-up ${f.type} ${quoted(f.title)}`,
    `${f.date} ${f.time} (${when})`,
    `assigned to ${f.assignee}`,
    f.contact === null ? null : `contact ${f.contact}`,
    f.opportunity === null ? null : `opportunity ${f.opportunity}`,
    f.status === 'failed' ? 'could not be scheduled: needs a new time' : null,
  ]
    .filter((part) => part !== null)
    .join(', ');
}

const conversationLine = (v: InsightConversation) =>
  `- ${v.ref} conversation${v.contact === null ? '' : ` with ${v.contact}`}, waiting for an answer since ${v.waitingSince}`;

/** The insights as the model reads them. Titles and names are the business's own data. */
export function commercialContext(
  insights: CommercialInsights | undefined,
  locale: GiaLocale,
): string {
  if (insights === undefined) return '(commercial records could not be read now)';
  const i = insights;
  const lines: string[] = [
    `Time zone ${i.timeZone}. Today ${i.today}; this week from ${i.weekStart}; this month from ${i.monthStart}.`,
    `Business currency: ${i.currency ?? 'not known'}.`,
    `Rules: closing soon = expected close within ${INSIGHT_RULES.closingSoonDays} days; quiet = no change for ${INSIGHT_RULES.quietOpportunityDays}+ days; inactive customer = no activity for ${INSIGHT_RULES.inactiveCustomerDays}+ days; active lead = activity within ${INSIGHT_RULES.activeLeadDays} days; highest values = top ${INSIGHT_RULES.topValues} open per currency.`,
  ];
  const c = i.contacts;
  lines.push(
    c === null
      ? 'Contacts, leads and customers: the person may NOT read them.'
      : `Contacts: ${c.counts.lead} leads, ${c.counts.customer} customers, ${c.counts.inactive} inactive. Leads without a next action: ${c.leadsWithoutNextAction}. Contacts with an overdue next action: ${c.overdueNextAction}. Customers inactive ${INSIGHT_RULES.inactiveCustomerDays}+ days: ${c.inactiveCustomers}. New today: ${c.newToday}; this week: ${c.newThisWeek}.${c.partial ? ' (Only the latest contacts were analysed; counts are complete.)' : ''}`,
  );
  const o = i.opportunities;
  if (o === null) {
    lines.push('Opportunities, pipeline and sales: the person may NOT read them.');
  } else {
    lines.push(
      `Opportunities: ${o.counts.open} open, ${o.counts.won} won, ${o.counts.lost} lost.`,
      `Open value (pipeline): ${totals(o.openValue, locale)}; open without an amount: ${o.openWithoutValue}.`,
      `Sold (won value): all time ${totals(o.wonValue, locale)}; this month ${totals(o.wonThisMonth, locale)}; this week ${totals(o.wonThisWeek, locale)}.`,
      `Closing soon: ${o.closingSoon}. Expected close date passed: ${o.closeDatePassed}. Overdue next action: ${o.overdueNextAction}. Quiet: ${o.quiet}.`,
      `Created today: ${o.createdToday}; this week: ${o.createdThisWeek}. Won today: ${o.wonToday}. Lost this week: ${o.lostThisWeek}.`,
      `Lost reasons: ${
        Object.entries(o.lostReasons)
          .map(([reason, count]) => `${reason} ${count}`)
          .join(', ') || 'none'
      }.`,
      'By stage:',
      ...o.stages.map(
        (s) =>
          `- ${s.name === null ? `${s.id} (template stage)` : quoted(s.name)} [${s.kind}]: ${s.count}, ${totals(s.value, locale)}`,
      ),
    );
    if (o.partial)
      lines.push('(Only the latest opportunities were analysed; counts are complete.)');
  }
  lines.push(
    i.conversations === null
      ? 'Conversations: the person may NOT read them.'
      : `Conversations waiting for an answer: ${i.conversations.waitingReply}.`,
  );
  const f = i.followUps;
  lines.push(
    f === null
      ? 'Follow-ups: the person may NOT read them.'
      : `Follow-ups open: ${f.open}; overdue ${f.overdue}; today ${f.today}; next ${FOLLOW_UP_LIMITS.upcomingDays} days ${f.upcoming}. Assigned to the person: overdue ${f.mine.overdue}, today ${f.mine.today}.${f.partial ? ' (Only the latest follow-ups were read.)' : ''}`,
  );
  if (f !== null) {
    lines.push(
      `Follow-ups listed (overdue, today and coming, soonest first): ${f.listed.join(', ') || 'none'}`,
    );
  }
  lines.push('Attention (most pressing first):');
  lines.push(
    ...(i.attention.length === 0
      ? ['(nothing)']
      : i.attention.map(
          (a) => `- ${a.ref}: ${a.reasons.map((r) => REASONS[r.kind](r)).join('; ')}`,
        )),
  );
  const list = (name: string, refs: readonly string[]) =>
    `${name}: ${refs.length === 0 ? 'none' : refs.join(', ')}`;
  lines.push(
    'Lists:',
    list('- highest open values', i.lists.highestValue),
    list('- closing soon', i.lists.closingSoon),
    list('- active leads', i.lists.activeLeads),
    list('- inactive customers', i.lists.inactiveCustomers),
    list('- quiet opportunities', i.lists.quiet),
    list('- latest wins', i.lists.recentWins),
    list('- named in the message', i.lists.mentioned),
    'Records:',
    ...i.records.opportunities.map((r) => opportunityLine(r, locale)),
    ...i.records.contacts.map(contactLine),
    ...i.records.conversations.map(conversationLine),
    ...i.records.followUps.map(followUpLine),
    'Dates (for a follow-up date, pick one of these; never compute one):',
    ...dateGrid(i.today).map(
      (d, n) => `- ${d.date} ${d.weekday}${n === 0 ? ' (today)' : n === 1 ? ' (tomorrow)' : ''}`,
    ),
  );
  return lines.join('\n');
}

/** GIA's rules for commercial questions. */
export function commercialRules(locale: GiaLocale): readonly string[] {
  return [
    'For sales, leads, customers, opportunities, the pipeline, conversations waiting and what to attend to, answer only from <commercial_context>. Its counts, totals, dates and lists are already calculated: use them exactly; never recalculate, estimate, score or forecast.',
    'Amounts are per currency. Never add, compare or convert amounts in different currencies: show each in its own currency, as written.',
    `If <commercial_context> says the person may NOT read the part asked about, answer exactly "${NO_PERMISSION[locale]}" and give nothing from it, not even counts.`,
    `If there are no records for what is asked, say "${NOT_ENOUGH_DATA[locale]}" and, in one line, what they can register in Comercial.`,
    'When asked what to attend to (today, first, pending), list the Attention items in their order: name each record, say why in plain words from its reason (for example "la próxima acción venció hace 3 días", "cierra en 4 días"), with its amount when it has one.',
    'Template stages appear as ids (like quote or trial_order): say them in natural words in the answer language.',
    'Adapt your words to the kind of business in <company_context> (a restaurant has orders, a clinic patients) without changing any figure.',
    'You never create, change, move, assign, win, lose, close or price a lead, customer, opportunity, stage or owner, and never send messages or call. Suggest what the person can do in Comercial, in proposedAction.',
    'links: up to 4 references from <commercial_context> (like o_a, c_b, v_a) or leads, customers, pipeline, for what your answer names; the app shows them as links. Never write references, ids or web addresses in answer.',
    'Ask at most one question, only when neither <company_context> nor <commercial_context> answers it.',
  ];
}

/**
 * GIA's rules for follow-ups (C5): she lists them, and proposes one only when asked; the person
 * confirms it in the app. `canSchedule` says whether this person may schedule follow-ups.
 */
export function followUpRules(canSchedule: boolean): readonly string[] {
  return [
    "When asked what to do today or what is pending, start with the follow-ups due today and overdue from <commercial_context> (with their time and who they are assigned to, the person's own first), then the Attention items.",
    canSchedule
      ? `followUp: only when the person asks you to remind them of, schedule or follow up something about a contact or opportunity in <commercial_context> (usually one "named in the message"), propose it: record is its reference (the opportunity when the person talks about that sale), type one of ${FOLLOW_UP_TYPES.join(', ')}, title a short imperative like "Llamar a Juan" in the answer language, date one of the Dates the person said (null when they said no day). Otherwise followUp is null.`
      : 'followUp is always null: this person may not schedule follow-ups. If asked, say they cannot schedule them.',
    'Never say a follow-up is created, scheduled or saved: you only prepare it, and the app asks the person to confirm it. Never state a time the person did not write; the app asks for it.',
    'If two contacts named in the message match, set followUp to null and ask which one.',
  ];
}
