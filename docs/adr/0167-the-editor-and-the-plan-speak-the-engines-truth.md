# ADR-0167: the editor and the plan speak the engine's truth

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps), [ADR-0162](0162-a-failed-branch-ends-only-itself.md) (a failed branch ends only itself), [ADR-0165](0165-tool-steps-in-the-workflow-editor.md) (tool steps in the editor)
- Product decision: Geovet, 2026-10-05 05:32Z and 05:39Z (blocks 1 and 2 of the engine and UX audit): the editor offers only what the engine accepts, and the plan reads in the person's words. The answer must come from the same rule the engine uses, never a second source of truth.
- Terraform: none. Firestore: none. Prompts: none.

## Context

The workflow editor offered any read-only tool for a tool step. The plan then refused it with `tool_not_assigned` when the agent bound to the step had no skill granting it. Refusals and failures showed raw codes. The plan page did not list tool steps, what they found, or why a step failed.

## Decision

1. **One rule for who does a role.** `assigneeOf` in `packages/workflows/src/service.ts` picks the agent for a department type and role:
   - the first eligible specialist by id, with that main role, in a catalogue department of that type.

   `bind`, which planning uses, calls it. So does the new `WorkflowService.assignees`, behind `workflow.manage`, through `GET /workflows/assignees`. Each assignee's tools are the agent's `configuration.tools`: the list the plan validator checks, derived from its active skills. There is no Agent→Tool table, no second assignment and no copy of the rule.

2. **The editor uses that answer.** A tool the agent cannot use is still listed, disabled, as "not available to this agent", with the reason:
   - no skill grants it, or which skill would;
   - no active agent has the role;
   - the tools could not be read.

   Saving lists what is missing instead of silently disabling the button. The editor stays the advanced mode.

3. **Refusals and failures in words.** `explain.tsx` maps engine codes to what happened and what the person can do. The code stays folded away as technical detail. Unknown codes read as "something went wrong".
4. **A readable plan.** `GET /plans/:id/steps` now also lists tool steps:
   - their state comes from their node in the agent step's child;
   - a tool step whose agent step ended its branch is skipped;
   - each step shows when it ended.

   A tool step's result is summed up, never shown: list lengths, yes/no values, numbers, and texts up to 80 characters. Anything named like a credential or looking like a secret is left out (G-7). The page shows:
   - each step's state in plain words, who does it, and the current step;
   - for a pending approval: what, by which agent and why, with Approve/Reject through Approvals' own call when the person may decide (GIA never decides);
   - failures, and branches that went on or were skipped (ADR-0162);
   - the existing trace, folded.

## Consequences

The editor and the plan answer the same question the same way: which agent a role's step would get now, and what its skills let it use. If an agent changes between saving and planning, the plan validator still decides.

## Evals

No prompt, model context, routing or model changes. No run is needed.
