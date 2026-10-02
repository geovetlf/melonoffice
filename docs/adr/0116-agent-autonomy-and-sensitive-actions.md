# ADR-0116: Agent autonomy, the sensitive-action policy and the checks before an action

- Status: Proposed
- Date: 2026-10-01
- Builds on: [ADR-0026](0026-tools-approvals-and-guardrails.md), [ADR-0043](0043-conversation-agent.md), [ADR-0100](0100-harness-provider-preference-and-task-budget.md), [ADR-0103](0103-harness-tool-use-mid-task.md), [ADR-0115](0115-agent-lifecycle-readiness-pagination.md)

## Context

The owner approved three levels of autonomy for agents (D2, AE-4.4): propose, controlled (the default) and within policy, with sensitive actions always needing a person. The Harness already decided each tool call an agent's model asks for (`authorizeToolUse`, levels A/B/C, ADR-0100), and the Tool Gate already checked every call that runs (ADR-0026). An agent had no level of its own, and the organization could not say what else it counts as sensitive.

## Decision

1. **The level is part of the agent's configuration** (`configuration.autonomy`, optional; absent means `controlled`). Changing it is its own step, `POST /specialists/:id/autonomy {fromVersion, autonomy}`: `specialist.manage`, a person directly, a new immutable version, audited as `specialist.autonomy_changed` with the transition. A revision keeps the level and cannot change it. An execution decides with the level of the exact version it runs.
2. **One sensitive-action policy** (`packages/specialists/src/action-policy.ts`). It reads only what each tool declares in the catalogue: whether it changes anything, its category, its action, its provider, its risk and its approval policy.
   - Nothing that only reads is sensitive.
   - MelonOffice's list covers irreversible acts, money, purchases, deletions, permission and configuration changes, publishing, legal acts and anything sent or done outside MelonOffice.
   - The organization can add tools, actions or categories (`agentPolicies/{organizationId}`, `GET`/`PUT /agent-policy`, revisioned and audited as `agent_policy.changed`). It can also cap every agent's level (`maxAutonomy`). It can never make an action less sensitive.
3. **The decision** (`authorizeToolUse`, extended) runs in order:
   1. not granted is denied;
   2. past the task's tool budget is denied;
   3. a denied or critical tool is denied;
   4. a sensitive action needs a person's approval, at every level, with the kind recorded;
   5. a tool whose own policy asks for approval needs one;
   6. otherwise the effective level (the stricter of the agent's and the organization's maximum) decides a change (level B):
      - `propose` asks a person;
      - `controlled` runs low risk only and asks a person for the rest;
      - `within_policy` runs what the organization's automatic levels allow.

   A read runs at every level. A level only ever adds an approval: nothing denied is ever allowed.

4. **The checks before an action** (`evaluateAgentAction`, pure) run in order: identity, status, tenant, department, skill and tool, permissions, policy, autonomy, risk, approval, budget and context. The tool loop runs them on every call the model asks for, against the agent as stored now. The first that fails stops the task with its code (for example `agent_paused` or `tenant_mismatch`), and nothing after it runs. The Tool Gate still checks the call when it runs.
5. **Conversations.** An agent at `propose` never sends a reply by itself: its conversation profile acts as `supervised`, however it is configured, and the organization's level and the profile's own stay limits (ADR-0043).

## Consequences

- No Terraform, no composite index and no data migration. Agents without a level act at `controlled`, which matches the default behaviour before this change: the only model-invocable tool today, `follow_up_schedule@3`, already needs approval.
- A reason for an approval (`agent_autonomy`, `sensitive_action`) is decided again from the version and the policy; it is not stored on the node.
- The organization's policy has an API but no screen yet. Its categories and actions are tool codes, which a person should not have to know; a screen will name them in words.
