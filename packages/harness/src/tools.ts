import type { OrganizationId, SpecialistId, ToolVersion } from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import {
  grantsOf,
  isSpecialistId,
  toolKey,
  type SkillCatalogue,
  type SpecialistRepository,
} from '@melonoffice/specialists';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import type { ToolRegistry } from '@melonoffice/tools';
import type { HarnessTool, ToolAuthorizationClass } from './model.js';

/**
 * How a tool's use is treated (ADR-0099 §18), read from the tool's own declaration in the catalogue
 * (ADR-0026): what it changes, where, at which risk and under which approval policy. The class is
 * what a person should expect; each call is still decided by the Tool Gate.
 */
export function authorizationClassOf(version: ToolVersion): ToolAuthorizationClass {
  if (!version.mutating) return 'informative';
  if (version.approvalPolicy === 'denied' || version.riskLevel === 'critical') {
    return 'irreversible';
  }
  if (version.provider.kind === 'external') return 'external';
  if (version.riskLevel === 'high' || version.approvalPolicy === 'approval_required') {
    return 'sensitive';
  }
  return 'reversible';
}

/** The tools an agent may use for this person. */
export interface HarnessToolDirectory {
  granted(tenant: TenantContext, specialistId: SpecialistId): Promise<readonly ToolVersion[]>;
}

/**
 * An agent's tools as the gate would allow them (ADR-0083): only versions its configuration lists,
 * a skill of its version grants, the registry knows, and whose every permission this person holds.
 * A tool the person may not use is never offered, whatever the agent's skills say.
 */
export function createHarnessToolDirectory(options: {
  readonly specialists: Pick<SpecialistRepository, 'find'>;
  readonly skills: SkillCatalogue;
  readonly registry: Pick<ToolRegistry, 'resolve'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
}): HarnessToolDirectory {
  const { specialists, skills, registry, authorization } = options;
  return Object.freeze({
    async granted(tenant: TenantContext, specialistId: SpecialistId) {
      if (!isResolvedTenant(tenant) || !isSpecialistId(specialistId)) return [];
      const agent = await specialists.find(tenant.organizationId as OrganizationId, specialistId);
      if (agent === undefined) return [];
      const { tools } = grantsOf(agent.configuration.skills, skills);
      return agent.configuration.tools.flatMap((ref) => {
        if (!tools.has(toolKey(ref.id, ref.version))) return [];
        const found = registry.resolve(ref.id, ref.version);
        if (found === undefined) return [];
        const allowed = found.version.permissions.every(
          (p) => authorization.authorize(tenant, p).allowed,
        );
        return allowed ? [found.version] : [];
      });
    },
  });
}

export const harnessToolOf = (version: ToolVersion): HarnessTool =>
  Object.freeze({
    id: version.toolId,
    version: version.version,
    authorization: authorizationClassOf(version),
    approvalRequired: version.approvalPolicy === 'approval_required',
  });
