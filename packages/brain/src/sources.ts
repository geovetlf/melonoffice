import type {
  BusinessProfile,
  ChannelConnection,
  KnowledgeSourceType,
  OrganizationId,
} from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import { BrainError } from './errors.js';
import type { CompanyBrainService, IngestResult, TrustedSource } from './service.js';

/**
 * The sources that feed Company Brain today (ADR-0051). Each turns what an existing part of
 * MelonOffice already holds into facts, with its provenance; none keeps a copy of its own.
 */

/** The business profile (ADR-0048): what the owner typed, so confirmed facts from a person. */
export function profileKnowledge(profile: BusinessProfile): {
  readonly source: TrustedSource;
  readonly facts: readonly Record<string, unknown>[];
} {
  const text = (text: string) => ({ type: 'text', text });
  const facts: Record<string, unknown>[] = [
    { domain: 'identity', key: 'business_type', value: text(profile.businessType) },
    { domain: 'identity', key: 'country', value: text(profile.country) },
    { domain: 'identity', key: 'city', value: text(profile.city) },
    { domain: 'identity', key: 'time_zone', value: text(profile.timeZone) },
    { domain: 'finance', key: 'currency', value: text(profile.currency) },
  ];
  if (profile.employees !== undefined) {
    facts.push({ domain: 'team', key: 'size', value: text(profile.employees) });
  }
  if (profile.salesChannels !== undefined && profile.salesChannels.length > 0) {
    facts.push({
      domain: 'business_model',
      key: 'sales_channels',
      value: { type: 'list', items: [...profile.salesChannels] },
    });
  }
  if (profile.offering !== undefined) {
    facts.push({ domain: 'business_model', key: 'offering', value: text(profile.offering) });
  }
  if (profile.needs !== undefined) {
    facts.push({ domain: 'goals', key: 'needs', value: text(profile.needs) });
  }
  return {
    source: {
      type: 'user',
      id: 'business_profile',
      reference: `business_profile:${profile.organizationId}@${profile.revision}`,
    },
    facts,
  };
}

/** The organization's name, chosen by its owner when creating it. */
export function organizationKnowledge(organization: {
  readonly id: OrganizationId;
  readonly name: string;
}) {
  return {
    source: {
      type: 'user',
      id: 'organization',
      reference: `organization:${organization.id}`,
    } as TrustedSource,
    facts: [
      {
        domain: 'identity',
        key: 'commercial_name',
        value: { type: 'text', text: organization.name },
      },
    ],
  };
}

/**
 * What MelonOffice itself knows about how the company works, computed from its own records
 * (`calculated`): the departments in use, how many agents work, and the connected channels.
 */
export function operationalKnowledge(input: {
  readonly departments: readonly string[];
  readonly activeAgents: number;
  readonly channels: readonly Pick<ChannelConnection, 'channel' | 'status' | 'category'>[];
}): { readonly source: TrustedSource; readonly facts: readonly Record<string, unknown>[] } {
  const facts: Record<string, unknown>[] = [
    { domain: 'team', key: 'agents', value: { type: 'number', number: input.activeAgents } },
  ];
  if (input.departments.length > 0) {
    facts.push({
      domain: 'team',
      key: 'departments',
      value: { type: 'list', items: [...input.departments] },
    });
  }
  const connected = [
    ...new Set(input.channels.filter((c) => c.status === 'connected').map((c) => c.channel)),
  ].sort();
  facts.push(
    connected.length === 0
      ? {
          domain: 'integrations',
          key: 'connected_channels',
          value: { type: 'boolean', value: false },
        }
      : {
          domain: 'integrations',
          key: 'connected_channels',
          value: { type: 'list', items: connected },
        },
  );
  return { source: { type: 'system', id: 'melonoffice' }, facts };
}

/**
 * How many leads, customers and inactive contacts the organization has (C1, ADR-0053),
 * `calculated` from its own contacts. Only totals: Company Brain is the business's knowledge,
 * never a list of people.
 */
export function customerKnowledge(counts: {
  readonly lead: number;
  readonly customer: number;
  readonly inactive: number;
}): { readonly source: TrustedSource; readonly facts: readonly Record<string, unknown>[] } {
  const fact = (key: string, number: number) => ({
    domain: 'customers',
    key,
    value: { type: 'number', number },
  });
  return {
    source: { type: 'system', id: 'melonoffice' },
    facts: [
      fact('leads_count', counts.lead),
      fact('customers_count', counts.customer),
      fact('inactive_contacts_count', counts.inactive),
    ],
  };
}

/**
 * Where the sales pipeline stands (C2, ADR-0054), `calculated` from the organization's
 * opportunities: how many are open, won and lost, and the open value in the business's currency
 * (only when the currency is known). Totals only: never an opportunity, a contact or an amount of
 * one sale.
 */
export function pipelineKnowledge(summary: {
  readonly currency: string | null;
  readonly open: { readonly count: number; readonly valueMinor: number };
  readonly won: number;
  readonly lost: number;
}): { readonly source: TrustedSource; readonly facts: readonly Record<string, unknown>[] } {
  const count = (key: string, number: number) => ({
    domain: 'commercial',
    key,
    value: { type: 'number', number },
  });
  const facts: Record<string, unknown>[] = [
    count('open_opportunities_count', summary.open.count),
    count('won_opportunities_count', summary.won),
    count('lost_opportunities_count', summary.lost),
  ];
  if (summary.currency !== null) {
    facts.push({
      domain: 'commercial',
      key: 'open_pipeline_value',
      value: { type: 'money', amountMinor: summary.open.valueMinor, currency: summary.currency },
    });
  }
  return { source: { type: 'system', id: 'melonoffice' }, facts };
}

/**
 * How the organization's follow-ups stand (C5, ADR-0058), `calculated`: how many are open and
 * how many of those are overdue. Totals only: never a follow-up, its title, time or contact.
 */
export function followUpKnowledge(counts: { readonly open: number; readonly overdue: number }): {
  readonly source: TrustedSource;
  readonly facts: readonly Record<string, unknown>[];
} {
  const count = (key: string, number: number) => ({
    domain: 'commercial',
    key,
    value: { type: 'number', number },
  });
  return {
    source: { type: 'system', id: 'melonoffice' },
    facts: [
      count('open_follow_ups_count', counts.open),
      count('overdue_follow_ups_count', counts.overdue),
    ],
  };
}

/**
 * Facts an integration brings (a CRM, a store, a channel), through the Integration Engine's own
 * connection: Company Brain never talks to an outside system itself. The connection must be the
 * organization's and connected; a CRM's facts are `crm`, any other's `integration`, both
 * `imported`, never confirmed.
 */
export async function ingestFromConnection(
  brain: Pick<CompanyBrainService, 'ingest'>,
  connections: { list(tenant: TenantContext): Promise<readonly ChannelConnection[]> },
  tenant: TenantContext,
  connectionId: string,
  facts: readonly unknown[],
): Promise<IngestResult> {
  const connection = (await connections.list(tenant)).find((c) => c.id === connectionId);
  if (connection === undefined || connection.organizationId !== tenant.organizationId) {
    throw new BrainError('not_found');
  }
  if (connection.status !== 'connected') throw new BrainError('invalid_knowledge', 'connection');
  const type: KnowledgeSourceType = connection.category === 'crm' ? 'crm' : 'integration';
  return brain.ingest(tenant, { type, id: connection.id, reference: connection.provider }, facts);
}

/**
 * A result an agent, a workflow or an analysis produced (for example, "Combo Familiar grew 18%
 * during the campaign"). Analyses are `calculated`; an agent's or a workflow's conclusions are
 * proposals a person confirms.
 */
export function recordResult(
  brain: Pick<CompanyBrainService, 'ingest'>,
  tenant: TenantContext,
  source: {
    readonly type: 'analytics' | 'agent' | 'workflow';
    readonly id: string;
    readonly reference?: string;
  },
  facts: readonly unknown[],
): Promise<IngestResult> {
  return brain.ingest(tenant, source, facts);
}
