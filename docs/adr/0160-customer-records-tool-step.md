# ADR-0160: a plan's tool step reads the organization's own customer records

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR-0102](0102-harness-crm-context-events-and-usage.md) (the CRM as context), [ADR-0130](0130-knowledge-search-read-tool.md) (`knowledge_search`), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps), [ADR-0159](0159-workflow-step-kinds-and-read-only-tool-steps.md) (read-only tool steps)
- Product decision: Geovet, 2026-10-04 14:19Z, decision 2. Tool steps in v1 read the Company Brain and the organization's own data, with authorization, and nothing else.
- Terraform: none. Firestore: none. Prompts: none.

## Context

`knowledge_search@1` already lets a plan's tool step read the Company Brain. Nothing let a tool step read the organization's own records. The customer records reached an agent only as the counts in its starting context (ADR-0102), and only when the task was about customers.

## Decision

1. **One tool, `customer_records_summary@1`.**
   - Category `crm`, action `read`, not mutating.
   - Provider `internal`/`crm`, no credential, risk low, policy `auto`, DEV only.
   - Invocation `runtime` only: no model is offered it.
   - It takes no input (`{}`). The organization, the agent and the person come from the execution.
2. **What it returns.** Counts and totals only, from the commercial insights the starting context already uses:
   - leads, customers and inactive contacts, and their next actions;
   - open, won and lost opportunities, closing soon, close date passed, quiet, and the open value per currency;
   - open, overdue and due-today follow-ups.

   It never returns a name, title, phone number, message or record. Its output schema has no room for one, and the Tool Gate checks the output against it.

3. **Who may read what.** The executor (`createCustomerRecordsExecutor`, in the Harness's CRM module):
   - reads as the runtime for the person the plan runs for, in the execution's organization;
   - gives each part only when the agent's version lists its permission (`contact.read`, `opportunity.read`, `follow_up.read`);
   - relies on the insights to check the person again: a part the person may not read is left out.

   An agent that lists none of these permissions gets `{ available: false }`, without anything being read.

4. **Which agents.** The tool reaches an agent through `pipeline_analysis@2`. Like every new skill version, it applies only when a person upgrades the agent. No agent changes by itself.
5. **The worker.** It registers the executor under provider `crm` beside `knowledge`, with the same insights as the CRM context.

## Evals

No prompt, model context, routing or model changes. The tool is never offered to a model, so agent behaviour does not change. No run is needed and V3 stays the baseline.

## Consequences

- No credits: the tool calls no model.
- Tests:
  - `packages/tools`: the definition, and that its input takes nothing and its output holds no name;
  - `packages/harness`: the parts by permission, the person and organization read as, and refusals.
