import type { ToolVersion } from '@melonoffice/domain';
import { sensitivityOf, SENSITIVE_ACTIONS } from '@melonoffice/specialists';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import { AGENT_ACTION_CHECKS, evaluateAgentAction, type AgentActionFacts } from './evaluation.js';
import { authorizeToolUse, type ToolUseRules } from './tools.js';

/**
 * Autonomy and the sensitive-action policy (AE-4.4, ADR-0116): a level of autonomy only ever adds
 * a person's approval, a sensitive action always waits on one, and the first check that fails
 * stops the action.
 */

const registry = createToolRegistry(TOOL_CATALOGUE);
const real = (id: string, version: number): ToolVersion => {
  const found = registry.resolve(id, version);
  if (found === undefined) throw new Error(`no tool ${id}@${version}`);
  return found.version;
};
// A reversible change inside MelonOffice, low risk: the handoff, as the catalogue declares it.
const LOW = real('conversation_handoff', 1);
const MEDIUM: ToolVersion = { ...LOW, riskLevel: 'medium' };
const READ: ToolVersion = { ...LOW, mutating: false };

const NO_RULES: ToolUseRules = {
  sensitiveCategories: [],
  sensitiveActions: [],
  sensitiveTools: [],
  maxAutonomy: 'within_policy',
};

const decide = (
  tool: ToolVersion,
  autonomy?: 'propose' | 'controlled' | 'within_policy',
  rules?: Partial<ToolUseRules>,
) =>
  authorizeToolUse({
    tool,
    granted: true,
    toolCallsUsed: 0,
    maxToolCalls: 5,
    ...(autonomy === undefined ? {} : { autonomy }),
    ...(rules === undefined ? {} : { rules: { ...NO_RULES, ...rules } }),
  });

describe('levels of autonomy (AE-4.4)', () => {
  it('runs a read at every level', () => {
    for (const level of ['propose', 'controlled', 'within_policy'] as const) {
      expect(decide(READ, level)).toMatchObject({ decision: 'allow', level: 'A', autonomy: level });
    }
  });

  it('propose: every change waits on a person', () => {
    expect(decide(LOW, 'propose')).toEqual({
      decision: 'approval_required',
      level: 'B',
      reason: 'agent_autonomy',
      autonomy: 'propose',
    });
    expect(decide(MEDIUM, 'propose')).toMatchObject({ reason: 'agent_autonomy' });
  });

  it('controlled, the default: low-risk changes by itself, the rest waits on a person', () => {
    expect(decide(LOW)).toMatchObject({ decision: 'allow', autonomy: 'controlled' });
    expect(decide(MEDIUM)).toMatchObject({
      decision: 'approval_required',
      reason: 'agent_autonomy',
      autonomy: 'controlled',
    });
  });

  it('within_policy: every change the organization lets run by itself', () => {
    expect(decide(MEDIUM, 'within_policy')).toMatchObject({ decision: 'allow' });
    // The organization keeps changes for a person: its automatic levels still apply.
    expect(
      authorizeToolUse({
        tool: MEDIUM,
        granted: true,
        toolCallsUsed: 0,
        maxToolCalls: 5,
        autonomy: 'within_policy',
        policy: { automatic: ['A'] },
      }),
    ).toMatchObject({ decision: 'approval_required', reason: 'organization_policy' });
  });

  it("never goes past the organization's maximum", () => {
    expect(decide(LOW, 'within_policy', { maxAutonomy: 'propose' })).toMatchObject({
      decision: 'approval_required',
      reason: 'agent_autonomy',
      autonomy: 'propose',
    });
    expect(decide(MEDIUM, 'within_policy', { maxAutonomy: 'controlled' })).toMatchObject({
      reason: 'agent_autonomy',
      autonomy: 'controlled',
    });
    // A maximum above the agent's own level never raises it.
    expect(decide(MEDIUM, 'propose', { maxAutonomy: 'within_policy' })).toMatchObject({
      autonomy: 'propose',
    });
  });

  it('never allows what is denied, at any level', () => {
    const critical: ToolVersion = { ...LOW, riskLevel: 'critical' };
    const denied: ToolVersion = { ...LOW, approvalPolicy: 'denied' };
    for (const tool of [critical, denied]) {
      expect(decide(tool, 'within_policy')).toMatchObject({
        decision: 'deny',
        reason: 'tool_denied',
      });
    }
    expect(
      authorizeToolUse({
        tool: LOW,
        granted: false,
        toolCallsUsed: 0,
        maxToolCalls: 5,
        autonomy: 'within_policy',
      }),
    ).toMatchObject({ decision: 'deny', reason: 'not_granted' });
  });
});

describe('the sensitive-action policy (AE-4.4)', () => {
  it('names why an action is sensitive, from what the tool declares', () => {
    expect(sensitivityOf(READ)).toBeUndefined();
    expect(sensitivityOf(LOW)).toBeUndefined();
    expect(sensitivityOf({ ...LOW, category: 'finance' })).toBe('financial');
    expect(sensitivityOf({ ...LOW, category: 'purchasing' })).toBe('purchase');
    expect(sensitivityOf({ ...LOW, action: 'delete' })).toBe('deletion');
    expect(sensitivityOf({ ...LOW, action: 'grant' })).toBe('permission_change');
    expect(sensitivityOf({ ...LOW, category: 'settings' })).toBe('configuration_change');
    expect(sensitivityOf({ ...LOW, action: 'publish' })).toBe('external_publication');
    expect(sensitivityOf({ ...LOW, category: 'legal' })).toBe('legal');
    expect(sensitivityOf({ ...LOW, riskLevel: 'critical' })).toBe('irreversible');
    expect(sensitivityOf({ ...LOW, provider: { kind: 'external', id: 'x' } })).toBe(
      'external_action',
    );
    expect(sensitivityOf({ ...LOW, riskLevel: 'high' })).toBe('critical_change');
    expect(sensitivityOf(real('message_send', 3))).toBe('external_communication');
    // A read is never sensitive, whatever its category.
    expect(sensitivityOf({ ...READ, category: 'finance' })).toBeUndefined();
  });

  it("adds the organization's own: by tool, by action or by category, never fewer", () => {
    const rules = { sensitiveCategories: ['crm'], sensitiveActions: [], sensitiveTools: [] };
    expect(sensitivityOf({ ...LOW, category: 'crm' }, rules)).toBe('organization_defined');
    expect(sensitivityOf(LOW, { ...rules, sensitiveTools: ['conversation_handoff'] })).toBe(
      'organization_defined',
    );
    expect(sensitivityOf(LOW, { ...rules, sensitiveActions: ['handoff'] })).toBe(
      'organization_defined',
    );
    // MelonOffice's list is the floor: an organization's empty list keeps it.
    expect(sensitivityOf({ ...LOW, category: 'finance' }, rules)).toBe('financial');
    expect(Object.isFrozen(SENSITIVE_ACTIONS.actions)).toBe(true);
  });

  it('a sensitive action waits on a person at every level, and says why', () => {
    for (const level of ['propose', 'controlled', 'within_policy'] as const) {
      expect(decide({ ...LOW, category: 'finance' }, level)).toEqual({
        decision: 'approval_required',
        level: 'B',
        reason: 'sensitive_action',
        sensitivity: 'financial',
        autonomy: level,
      });
      expect(decide(LOW, level, { sensitiveTools: ['conversation_handoff'] })).toMatchObject({
        reason: 'sensitive_action',
        sensitivity: 'organization_defined',
      });
    }
  });
});

describe('the checks before an action (AE-4.4)', () => {
  const allowed = decide(LOW);
  type Over = { [K in keyof AgentActionFacts]?: AgentActionFacts[K] | undefined };
  const facts = (over: Over = {}): AgentActionFacts => {
    const { agent = { organizationId: 'org-a', status: 'active' }, ...rest } = {
      tenantOrganizationId: 'org-a',
      execution: {
        organizationId: 'org-a',
        status: 'running',
        specialistId: 'agent-1',
        specialistVersion: 1,
      },
      toolGranted: true,
      permissionsHeld: true,
      decision: allowed,
      ...over,
    } as AgentActionFacts;
    // No agent found: the fact is absent, not undefined.
    return 'agent' in over && over.agent === undefined ? rest : { ...rest, agent };
  };

  it('runs an action that passes every check, in order', () => {
    expect(evaluateAgentAction(facts())).toEqual({
      outcome: 'run',
      autonomy: 'controlled',
      passed: AGENT_ACTION_CHECKS,
    });
    expect(evaluateAgentAction(facts({ decision: decide(MEDIUM) }))).toMatchObject({
      outcome: 'approval_required',
      reason: 'agent_autonomy',
    });
  });

  it('stops at the first check that fails, with its code, and runs nothing after it', () => {
    const cases: [Over, string, string][] = [
      [{ agent: undefined }, 'identity', 'agent_not_found'],
      [{ agent: { organizationId: 'org-a', status: 'paused' } }, 'status', 'agent_paused'],
      [{ agent: { organizationId: 'org-a', status: 'disabled' } }, 'status', 'agent_disabled'],
      [{ agent: { organizationId: 'org-a', status: 'archived' } }, 'status', 'agent_not_active'],
      [{ tenantOrganizationId: 'org-b' }, 'tenant', 'tenant_mismatch'],
      [{ agent: { organizationId: 'org-b', status: 'active' } }, 'tenant', 'tenant_mismatch'],
      [{ departmentActive: false }, 'department', 'department_not_active'],
      [{ toolGranted: false }, 'skill_and_tool', 'tool_not_granted'],
      [{ permissionsHeld: false }, 'permissions', 'permission_not_held'],
      [{ decision: decide({ ...LOW, riskLevel: 'critical' }) }, 'policy', 'tool_denied'],
      [
        {
          decision: authorizeToolUse({
            tool: LOW,
            granted: true,
            toolCallsUsed: 5,
            maxToolCalls: 5,
          }),
        },
        'budget',
        'tool_call_limit_reached',
      ],
      [
        {
          execution: {
            organizationId: 'org-a',
            status: 'cancelled',
            specialistId: 'a',
            specialistVersion: 1,
          },
        },
        'context',
        'execution_not_running',
      ],
    ];
    for (const [over, check, code] of cases) {
      const result = evaluateAgentAction(facts(over));
      expect(result).toMatchObject({ outcome: 'refused', check, code });
      // Nothing after the failed check passed.
      const at = AGENT_ACTION_CHECKS.indexOf(check as (typeof AGENT_ACTION_CHECKS)[number]);
      expect(result.passed).toEqual(AGENT_ACTION_CHECKS.slice(0, at));
    }
  });
});
