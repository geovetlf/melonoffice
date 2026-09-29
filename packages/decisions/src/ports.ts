import type { AIGateway } from '@melonoffice/ai-gateway';
import type { CompanyBrainService } from '@melonoffice/brain';
import type { CommercialInsights, CommercialInsightService } from '@melonoffice/conversations';
import type { SpecialistId } from '@melonoffice/domain';
import type { Forecast } from '@melonoffice/forecasting';
import type { TenantContext } from '@melonoffice/tenancy';

/**
 * What the deciders read, through the services that already exist, always as the person the
 * decision is for: each service checks the tenant and the person's permissions again, so a
 * decision can never rest on data the person may not read. Nothing here writes.
 */
export interface DecisionPorts {
  /** Commercial records and their C4 insights, as the person reads them. */
  readonly commercial?: Pick<CommercialInsightService, 'read'>;
  /** Company Brain, read only: company policies are its `policies` domain. */
  readonly brain?: Pick<CompanyBrainService, 'list'>;
  /** A finished forecast (ADR-0059): a prediction the decision reads, never makes. */
  readonly forecasts?: { get(tenant: TenantContext, id: unknown): Promise<Forecast> };
  /** The organization's active agents, as GIA may name them (ADR-0064). */
  readonly agents?: { active(tenant: TenantContext): Promise<readonly DecisionAgent[]> };
  /** The AI Gateway, for a decider that needs interpretation. Never a provider. */
  readonly gateway?: Pick<AIGateway, 'assist'>;
}

export interface DecisionAgent {
  readonly id: SpecialistId;
  readonly name: string;
  /** The catalogue type of its department. */
  readonly department: string;
  readonly purpose: string | null;
}

/** Context a trusted caller already read as the same person, so it is not read twice. */
export interface DecisionPreload {
  readonly commercial?: CommercialInsights;
}
