# ADR-0172: plan_proposal@3

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0133](0133-prompt-versions.md) (prompt versions), [ADR-0169](0169-planner-evals.md) (the planner's evals), [ADR-0171](0171-plan-proposal-2-and-workflow-drafts.md) (`plan_proposal@2` and workflow drafts)
- Product decision: Geovet, 2026-10-05 09:45Z: @2 is not ready if it does worse on the critical cases. This ADR answers the real run that turned it down.
- Terraform: none. Firestore: none. Models and providers: none. New model policy: none.

## Context

The real run on Gemini 2.5 Flash-Lite (2026-10-05 10:49Z) scored @1 3/16 and @2 7/16. The verdict was revert, because p13 (a circular order) passed on @1 and failed on @2. @2 fixed the impossible and vague cases (6/6, up from 1/6) and stopped inventing tools. The failed answers showed five causes, all in the prompt:

- the model wrote `tool` inside an agent step instead of a separate tool step (p01, p02, p04, p07: `valid_plan`, `uses_tool`);
- it set `approvalRequired` on most steps, reading the tool's own `approvalRequired` as an order;
- it gave research work to marketing, because the research agent has no tools (p01, p06);
- it did not read customer figures with `customer_records_summary` (p03);
- it asked back for details (a store's name) or about a circular order, instead of planning (p12, p13).

## Decision

1. **`plan_proposal@3` replaces @2 on the same planner.** The answer format, the step kinds, the context and how the answer is read are unchanged. The instructions now say:
   - a tool step is its own step, never a field of an agent step, performed by a step of the agent that holds the tool;
   - the input is fixed by the model unless `inputFromAllowed` is true;
   - work on a tool's result is a later agent step;
   - work goes to the department whose type fits it, and an agent without tools still works;
   - when the request needs the company memory or customer and pipeline figures, a tool step reads them;
   - `approvalRequired` goes only on the step the person said they want to review;
   - questions are only for a request whose work cannot be told at all, never for missing details;
   - a circular order becomes one order without a cycle, named in the summary;
   - people are named by role, never by name or contact.

   A short example shows the shape with placeholders, not any eval case.

2. **@2 is kept frozen in the evals** (`--prompt 2`, its instruction digest checked), so @1, @2 and @3 are measured on the same cases and scoring.

3. **The run file keeps why a plan was refused**: the schema's reason and field, or the validator's stage, reason and field. These are codes and paths only, never text from the answer.

## Not changed

The validator, G-7, Guardian, approvals, autonomy, RBAC, tenant isolation, audit, D-12, the tools and the `gia_chat` prompt.

## Evals

@3 is accepted only if the real run shows no regression against @1 or @2. Every case that passes on either must pass on @3 (docs/evals/README.md). Until then, the product runs @3 only in DEV, as it ran @2.
