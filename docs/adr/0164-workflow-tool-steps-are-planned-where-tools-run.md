# ADR-0164: a workflow's tool steps are planned where this server runs tools

- Status: Accepted
- Date: 2026-10-04
- Builds on: [ADR-0068](0068-follow-up-tool.md) (a person's tools run where the server's environment is set), [ADR-0151](0151-tool-steps-run-in-plans.md) (tool steps), [ADR-0159](0159-workflow-step-kinds-and-read-only-tool-steps.md) (workflow step kinds)
- Product decision: Geovet, 2026-10-04 14:19Z, decision 2 (tool steps v1 read inside MelonOffice).
- Terraform: none. Firestore: none. Prompts: none.

## Context

The API's plan service validates the plans a workflow makes. Its validator was built with no deployment environment, on the assumption that no route reached it. The workflow plan route does reach it. Every tool step was therefore refused with `environment_not_allowed`, in DEV too. A workflow could hold a tool step, but no plan of it could be made.

## Decision

The plan service's validator uses the environment this server runs tools in: the same setting as a person's own tools (`toolEnvironment`, set from the deployment environment).

- Unset, every tool step is still refused (fail closed).
- Every other check is unchanged: read-only tools only, the tool's environments, department, policy, schema, the agent listing the tool, and the person's permissions.
- The worker's Tool Gate checks the call again when the step runs.

The test proves the gap: the same workflow was refused with `environment_not_allowed` before this change and is planned after it.

## Evals

No prompt, model context, routing or model changes. No run is needed and V3 stays the baseline.
