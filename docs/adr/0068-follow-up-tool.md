# ADR-0068: First business tool, `follow_up_schedule` (Tool Engine TL-1)

- Status: Proposed
- Date: 2026-09-29
- Builds on:
  - ADR-0026 (tools, approvals, Tool Gate);
  - ADR-0034 (a person's own tool call);
  - ADR-0058 (follow-ups).
- Terraform: none. It reuses `DEPLOYMENT_ENVIRONMENT`, which the API already has wherever follow-ups can be scheduled.

## Context

The Tool Engine audit (`melonoffice-plan/MelonOffice-Tool-Engine-Audit.md`) found three problems:

- The catalogue had only messaging tools.
- Business actions ran outside the Tool Gate. For example, `POST /follow-ups` called the follow-up service directly, including when a person confirmed GIA's proposed follow-up.
- Agents, workflows and the Decision Engine's recommended actions had no governed tool to reach.

## Decision

1. **A new tool, `follow_up_schedule` version 1**, with these properties:
   - `human` only, `auto`, low risk;
   - internal provider `follow_up`, no credentials, permission `follow_up.manage`;
   - `dev` only, never retried by the gate.

   Its closed input is exactly the follow-up's fields: requestKey, contactId, opportunityId, type, title, description, date, time, assignedTo and source. There is no organization, person or credential in it.

2. **The executor wraps the existing service, with no new rules.**
   - It checks that the call is version 1, by a person directly.
   - It resolves that person's active membership again, in the execution's organization. This is a new pattern, because an executor normally gets only the gate's context.
   - It then calls `FollowUpService.create` as them. Contact, opportunity, assignee, time, limits and the `follow_up.created` audit stay the service's.
3. **The route goes through the gate**, with the same request and the same response.
   - `checkCreate` first. It is new and runs the service's own checks without writing, so a refusal keeps its code and field, for example `date_in_past`, and nothing is recorded.
   - Then one execution per attempt, the gate, and `tool.execution_requested/completed/failed` with `execution.*` in the audit.
   - The follow-up's `requestKey` stays the only idempotency: two attempts make one follow-up and two recorded tool calls.
   - The service's refusals pass through unchanged. Anything else is `follow_up_tool_unavailable` (503).
4. **Fail closed.** With no tool environment, or an environment the version does not allow, creating a follow-up answers 503. There is no path around the gate.
5. Update, reschedule, complete and cancel stay direct for now. The worker's "due" step stays the runtime's.

## Consequences

- Every new follow-up, whether made by a person or confirmed from GIA, is a tool call that the gate authorizes and audits.
- The Decision Engine's `follow_up.schedule` action and agents now have a real tool to target. A runtime version for agents, with approval, needs its own decision.
- Staging and production need the version's `environments` extended before follow-ups can be created there. This is deliberate, like `message_send`.
- Next tools use the same pattern: wrap an owning service and never re-implement it. Candidates are `brain_fact_propose` (Company Brain proposals), then contact and opportunity updates.
