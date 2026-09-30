import type { AgentContextBlock, AgentContextSource } from '@melonoffice/agents';
import type {
  CommercialInsights,
  CommercialInsightService,
  InsightAmount,
} from '@melonoffice/conversations';
import type { TenantContext } from '@melonoffice/tenancy';

const NAME = 'crm_context';

/** An amount in its own currency and minor units, e.g. `1,250.00 PEN`. */
function amountOf(a: InsightAmount): string {
  try {
    const digits =
      new Intl.NumberFormat('en-US', { style: 'currency', currency: a.currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
    const value = new Intl.NumberFormat('en-US', {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(a.amountMinor / 10 ** digits);
    return `${value} ${a.currency}`;
  } catch {
    return `${(a.amountMinor / 100).toFixed(2)} ${a.currency}`;
  }
}

const totals = (amounts: readonly InsightAmount[]): string =>
  amounts.length === 0 ? 'none' : amounts.map(amountOf).join(', ');

/**
 * The customer records as an agent reads them (ADR-0102): counts and totals only, from the C4
 * insights. No names, no titles, no records: an agent that needs a customer is given it by the
 * task, not by the context. Each part is shown only when the agent's configuration lists its
 * permission; the insights service checks the person the task runs for again.
 */
export function crmContextText(
  insights: CommercialInsights,
  agent: {
    readonly contacts: boolean;
    readonly opportunities: boolean;
    readonly followUps: boolean;
  },
): string {
  const lines = [`Today ${insights.today} (time zone ${insights.timeZone}).`];
  const c = agent.contacts ? insights.contacts : null;
  if (c !== null) {
    lines.push(
      `Contacts: ${c.counts.lead} leads, ${c.counts.customer} customers, ${c.counts.inactive} inactive. Leads without a next action: ${c.leadsWithoutNextAction}. Overdue next actions: ${c.overdueNextAction}. Inactive customers: ${c.inactiveCustomers}. New this week: ${c.newThisWeek}.`,
    );
  }
  const o = agent.opportunities ? insights.opportunities : null;
  if (o !== null) {
    lines.push(
      `Opportunities: ${o.counts.open} open, ${o.counts.won} won, ${o.counts.lost} lost. Open value: ${totals(o.openValue)}. Won this month: ${totals(o.wonThisMonth)}. Closing soon: ${o.closingSoon}. Close date passed: ${o.closeDatePassed}. Quiet: ${o.quiet}.`,
    );
  }
  const f = agent.followUps ? insights.followUps : null;
  if (f !== null) {
    lines.push(`Follow-ups open: ${f.open}; overdue ${f.overdue}; today ${f.today}.`);
  }
  if (lines.length === 1) return '(the customer records are not available to this agent)';
  return lines.join('\n');
}

/**
 * The CRM as a Harness context source (ADR-0102): read only when the task is about customers
 * (ADR-0099's context plan), through the existing commercial insights, as the person the task
 * runs for.
 */
export function createCrmContextSource(options: {
  readonly insights: Pick<CommercialInsightService, 'read'>;
}): AgentContextSource {
  const { insights } = options;
  return Object.freeze({
    async read(
      tenant: TenantContext,
      request: Parameters<AgentContextSource['read']>[1],
    ): Promise<readonly AgentContextBlock[]> {
      const permissions = request.configuration.permissions;
      const agent = {
        contacts: permissions.includes('contact.read'),
        opportunities: permissions.includes('opportunity.read'),
        followUps: permissions.includes('follow_up.read'),
      };
      if (!agent.contacts && !agent.opportunities && !agent.followUps) {
        return [{ name: NAME, text: '(this agent may not read the customer records)' }];
      }
      try {
        return [{ name: NAME, text: crmContextText(await insights.read(tenant), agent) }];
      } catch {
        return [{ name: NAME, text: '(the customer records could not be read now)' }];
      }
    },
  });
}
