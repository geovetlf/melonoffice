import type { AgentAutonomy, OrganizationId, SpecialistId, ToolVersion } from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import {
  DEFAULT_AGENT_AUTONOMY,
  grantsOf,
  sensitivityOf,
  stricterAgentAutonomy,
  type SensitiveActionKind,
  type SensitivityRules,
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

/**
 * The tools an agent may use for this person: of its current version, or of the exact `version` an
 * execution runs (ADR-0103), which is the one the Tool Gate checks.
 */
export interface HarnessToolDirectory {
  granted(
    tenant: TenantContext,
    specialistId: SpecialistId,
    version?: number,
  ): Promise<readonly ToolVersion[]>;
}

/**
 * An agent's tools as the gate would allow them (ADR-0083): only versions its configuration lists,
 * a skill of its version grants, the registry knows, and whose every permission this person holds.
 * A tool the person may not use is never offered, whatever the agent's skills say.
 */
export function createHarnessToolDirectory(options: {
  readonly specialists: Pick<SpecialistRepository, 'find' | 'findVersion'>;
  readonly skills: SkillCatalogue;
  readonly registry: Pick<ToolRegistry, 'resolve'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
}): HarnessToolDirectory {
  const { specialists, skills, registry, authorization } = options;
  return Object.freeze({
    async granted(tenant: TenantContext, specialistId: SpecialistId, version?: number) {
      if (!isResolvedTenant(tenant) || !isSpecialistId(specialistId)) return [];
      const organizationId = tenant.organizationId as OrganizationId;
      const agent =
        version === undefined
          ? await specialists.find(organizationId, specialistId)
          : await specialists.findVersion(organizationId, specialistId, version);
      if (agent === undefined) return [];
      // A skill for other departments grants this agent nothing (ADR-0104).
      const { tools } = grantsOf(
        agent.configuration.skills,
        skills,
        agent.configuration.departmentId,
      );
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
  | {
      readonly decision: 'allow';
      readonly level: ToolLevel;
      readonly reason: 'automatic';
      readonly autonomy: AgentAutonomy;
    }
  | {
      readonly decision: 'approval_required';
      readonly level: ToolLevel;
      readonly reason:
        'sensitive_action' | 'tool_policy' | 'organization_policy' | 'agent_autonomy';
      readonly autonomy: AgentAutonomy;
      /** Why the action is sensitive, when that is the reason (ADR-0116 §2). */
      readonly sensitivity?: SensitiveActionKind;
    }
  | {
      readonly decision: 'deny';
      readonly level: ToolLevel;
      readonly reason: 'not_granted' | 'tool_call_limit_reached' | 'tool_denied';
      readonly autonomy: AgentAutonomy;
    };

/** An organization's rules as the decision reads them: its sensitive codes and its maximum level. */
export type ToolUseRules = SensitivityRules & { readonly maxAutonomy: AgentAutonomy };

/**
 * Whether an agent may use a tool now (Geovet, 2026-09-30; AE-4.4, ADR-0116): the agent asks, the
 * Harness decides, never the agent and never the model. In order:
 *
 * 1. the tool must be one the agent's skills grant and every permission of which the person holds
 *    (`granted`, from `HarnessToolDirectory`): otherwise denied;
 * 2. the task's tool budget: at its limit, denied;
 * 3. a tool whose own policy denies it, or whose risk is critical: denied;
 * 4. a sensitive action (level `C`, or one the sensitive-action policy names, MelonOffice's or the
 *    organization's): a person approves, at every level of autonomy;
 * 5. a tool whose own policy asks for approval: a person approves;
 * 6. the agent's level of autonomy, never above the organization's maximum: `propose` proposes
 *    every change (a person approves it), `controlled` makes only low-risk changes by itself, and
 *    `within_policy` makes every change the organization's automatic levels allow. A read (`A`)
 *    runs at every level.
 *
 * Nothing here grants anything: a level of autonomy only ever adds a person's approval.
 */
export function authorizeToolUse(input: {
  readonly tool: ToolVersion;
  readonly granted: boolean;
  readonly toolCallsUsed: number;
  readonly maxToolCalls: number;
  readonly policy?: HarnessToolPolicy;
  /** The agent's own level (its version's). Absent: the default, `controlled`. */
  readonly autonomy?: AgentAutonomy;
  /** The organization's rules. Absent: MelonOffice's defaults. */
  readonly rules?: ToolUseRules;
}): ToolUseDecision {
  const { tool, granted, toolCallsUsed, maxToolCalls, rules } = input;
  const level = toolLevelOf(tool);
  const autonomy = stricterAgentAutonomy(
    input.autonomy ?? DEFAULT_AGENT_AUTONOMY,
    rules?.maxAutonomy ?? 'within_policy',
  );
  const decide = <D extends Omit<ToolUseDecision, 'level' | 'autonomy'>>(d: D) =>
    Object.freeze({ ...d, level, autonomy }) as ToolUseDecision;
  if (!granted) return decide({ decision: 'deny', reason: 'not_granted' });
  if (toolCallsUsed >= maxToolCalls) {
    return decide({ decision: 'deny', reason: 'tool_call_limit_reached' });
  }
  if (tool.approvalPolicy === 'denied' || tool.riskLevel === 'critical') {
    return decide({ decision: 'deny', reason: 'tool_denied' });
  }
  const sensitivity = sensitivityOf(tool, rules);
  if (level === 'C' || sensitivity !== undefined) {
    return decide({
      decision: 'approval_required',
      reason: 'sensitive_action',
      ...(sensitivity === undefined ? {} : { sensitivity }),
    });
  }
  if (tool.approvalPolicy === 'approval_required') {
    return decide({ decision: 'approval_required', reason: 'tool_policy' });
  }
  if (level === 'B') {
    if (autonomy === 'propose') {
      return decide({ decision: 'approval_required', reason: 'agent_autonomy' });
    }
    if (autonomy === 'controlled' && tool.riskLevel !== 'low') {
      return decide({ decision: 'approval_required', reason: 'agent_autonomy' });
    }
  }
  const automatic = (input.policy ?? DEFAULT_HARNESS_TOOL_POLICY).automatic;
  return automatic.includes(level as 'A' | 'B')
    ? decide({ decision: 'allow', reason: 'automatic' })
    : decide({ decision: 'approval_required', reason: 'organization_policy' });
}

export const harnessToolOf = (version: ToolVersion): HarnessTool =>
  Object.freeze({
    id: version.toolId,
    version: version.version,
    level: toolLevelOf(version),
    authorization: authorizationClassOf(version),
    approvalRequired: version.approvalPolicy === 'approval_required',
  });
