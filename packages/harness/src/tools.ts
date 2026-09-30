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
import type { HarnessTool, ToolAuthorizationClass, ToolLevel } from './model.js';

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

/**
 * A tool's level (Geovet, 2026-09-30), from its class: a read is `A`, a reversible change inside
 * MelonOffice is `B`, and anything sensitive, outside MelonOffice or irreversible is `C`.
 */
export function toolLevelOf(version: ToolVersion): ToolLevel {
  const kind = authorizationClassOf(version);
  if (kind === 'informative') return 'A';
  if (kind === 'reversible') return 'B';
  return 'C';
}

/**
 * The organization's policy for tool use: the levels that run without a person. Absent: `A` and
 * `B` (Geovet's default); an organization may keep `B` for a person too. `C` is never automatic.
 */
export interface HarnessToolPolicy {
  readonly automatic: readonly ('A' | 'B')[];
}

export const DEFAULT_HARNESS_TOOL_POLICY: HarnessToolPolicy = Object.freeze({
  automatic: Object.freeze(['A', 'B'] as const),
});

export type ToolUseDecision =
  | { readonly decision: 'allow'; readonly level: ToolLevel; readonly reason: 'automatic' }
  | {
      readonly decision: 'approval_required';
      readonly level: ToolLevel;
      readonly reason: 'sensitive_action' | 'tool_policy' | 'organization_policy';
    }
  | {
      readonly decision: 'deny';
      readonly level: ToolLevel;
      readonly reason: 'not_granted' | 'tool_call_limit_reached' | 'tool_denied';
    };

/**
 * Whether an agent may use a tool now (Geovet, 2026-09-30): the agent asks, the Harness decides,
 * never the agent. In order:
 *
 * 1. the tool must be one the agent's skills grant and every permission of which the person holds
 *    (`granted`, from `HarnessToolDirectory`): otherwise denied;
 * 2. the task's tool budget: at its limit, denied;
 * 3. a tool whose own policy denies it, or whose risk is critical: denied;
 * 4. level `C`: a person approves;
 * 5. a tool whose own policy asks for approval: a person approves;
 * 6. a level the organization runs without a person: allowed; otherwise a person approves.
 *
 * It decides; it never runs the tool. An allowed use still goes through the Tool Gate (ADR-0026),
 * which checks the call itself, and an approval is still a person's, bound to the exact call.
 */
export function authorizeToolUse(input: {
  readonly tool: ToolVersion;
  readonly granted: boolean;
  readonly toolCallsUsed: number;
  readonly maxToolCalls: number;
  readonly policy?: HarnessToolPolicy;
}): ToolUseDecision {
  const { tool, granted, toolCallsUsed, maxToolCalls } = input;
  const level = toolLevelOf(tool);
  if (!granted) return Object.freeze({ decision: 'deny', level, reason: 'not_granted' });
  if (toolCallsUsed >= maxToolCalls) {
    return Object.freeze({ decision: 'deny', level, reason: 'tool_call_limit_reached' });
  }
  if (tool.approvalPolicy === 'denied' || tool.riskLevel === 'critical') {
    return Object.freeze({ decision: 'deny', level, reason: 'tool_denied' });
  }
  if (level === 'C') {
    return Object.freeze({ decision: 'approval_required', level, reason: 'sensitive_action' });
  }
  if (tool.approvalPolicy === 'approval_required') {
    return Object.freeze({ decision: 'approval_required', level, reason: 'tool_policy' });
  }
  const automatic = (input.policy ?? DEFAULT_HARNESS_TOOL_POLICY).automatic;
  return automatic.includes(level)
    ? Object.freeze({ decision: 'allow', level, reason: 'automatic' })
    : Object.freeze({ decision: 'approval_required', level, reason: 'organization_policy' });
}

export const harnessToolOf = (version: ToolVersion): HarnessTool =>
  Object.freeze({
    id: version.toolId,
    version: version.version,
    level: toolLevelOf(version),
    authorization: authorizationClassOf(version),
    approvalRequired: version.approvalPolicy === 'approval_required',
  });
