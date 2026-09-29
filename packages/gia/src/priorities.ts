import type { CommercialInsights } from '@melonoffice/conversations';
import type { DecisionItem, DecisionPriority, DecisionResult } from '@melonoffice/decisions';
import type { GiaLocale } from './catalogue.js';
import { formatAmount, type GiaLink } from './commercial.js';

/**
 * What to attend to first, as the Decision Engine ranks it (ADR-0065). GIA does not rank: the
 * engine's `commercial.priorities` decision, over the same insights she reads, gives the order,
 * the reasons and the next step, by fixed rules. She explains it in her words; the app shows each
 * item as a card with its reason, its data, its link and whether it needs approval.
 */

export const GIA_PRIORITY_LIMIT = 5;

/** One item as the app shows it: never an id the engine did not give. */
export interface GiaPriority {
  readonly priority: DecisionPriority | null;
  readonly outcome: string;
  /** Why, as the rule's codes and the values it compared (days, amounts). */
  readonly reasons: readonly {
    readonly code: string;
    readonly params: Readonly<Record<string, string | number>>;
  }[];
  /** The record it is about, where the person sees it. */
  readonly link: GiaLink | null;
  /** The next step: a code the app words, and a catalogue action GIA may prepare, if any. */
  readonly recommendedAction: { readonly code: string; readonly action: string | null } | null;
  readonly requiredApproval: boolean;
}

export interface GiaPriorities {
  /** The audited decision these come from. */
  readonly decisionId: string;
  readonly items: readonly GiaPriority[];
}

function linkOf(item: DecisionItem): GiaLink | null {
  const { type, id, label } = item.subject;
  switch (type) {
    case 'follow_up':
      return { kind: 'follow_up', id, label: label ?? '' };
    case 'opportunity':
      return { kind: 'opportunity', id, label: label ?? '' };
    case 'contact':
      return { kind: 'contact', id, label };
    case 'conversation':
      return { kind: 'conversation', id, label };
    default:
      return null;
  }
}

export function prioritiesOf(result: DecisionResult): GiaPriorities {
  return Object.freeze({
    decisionId: result.id,
    items: Object.freeze(
      result.items.map((item) =>
        Object.freeze({
          priority: item.priority,
          outcome: item.outcome,
          reasons: item.reasons.map((r) => ({ code: r.code, params: r.params })),
          link: linkOf(item),
          recommendedAction:
            item.recommendedAction === null
              ? null
              : { code: item.recommendedAction.code, action: item.recommendedAction.action },
          requiredApproval: item.requiredApproval,
        }),
      ),
    ),
  });
}

/** The reference the model already knows the record by, from the commercial context. */
function refOf(item: DecisionItem, insights: CommercialInsights): string | undefined {
  const { type, id } = item.subject;
  const { records } = insights;
  const found =
    type === 'follow_up'
      ? records.followUps.find((f) => f.id === id)
      : type === 'opportunity'
        ? records.opportunities.find((o) => o.id === id)
        : type === 'contact'
          ? records.contacts.find((c) => c.id === id)
          : type === 'conversation'
            ? records.conversations.find((c) => c.id === id)
            : undefined;
  return found?.ref;
}

/** The ranking for the model, by reference: order, priority, why and the next step. */
export function prioritiesBlock(
  result: DecisionResult,
  insights: CommercialInsights,
  locale: GiaLocale,
): string {
  if (result.items.length === 0) return '(nothing needs attention now)';
  return result.items
    .map((item, index) => {
      const ref = refOf(item, insights) ?? item.subject.type;
      const why = item.reasons
        .map((r) => {
          const { amountMinor, currency, ...rest } = r.params;
          const values = Object.entries(rest).map(([k, v]) => `${k} ${String(v)}`);
          if (typeof amountMinor === 'number' && typeof currency === 'string') {
            values.push(`value ${formatAmount({ amountMinor, currency }, locale)}`);
          }
          return values.length === 0 ? r.code : `${r.code} (${values.join(', ')})`;
        })
        .join('; ');
      const next = item.recommendedAction?.code ?? 'none';
      const approval = item.requiredApproval ? ', requires approval' : '';
      return `${String(index + 1)}. ${ref} [${item.priority ?? 'none'}${approval}] ${item.outcome}: ${why}; next: ${next}`;
    })
    .join('\n');
}

export const PRIORITY_RULES: readonly string[] = [
  "<priorities> is what needs attention now, in the order the company's decision rules give it, with each reason and next step. When the person asks what to attend to first or what is pending, follow that order and those reasons: never reorder it, drop its most pressing item, or rank by your own judgement.",
  'Set priorities to true only when your answer is about that list; the app then shows each item with its reason and link. Otherwise set it to false.',
];
