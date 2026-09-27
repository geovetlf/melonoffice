# @melonoffice/planning

Plans, the planner and delegation ([ADR-0028](../../docs/adr/0028-planner-delegation-and-workflows.md)). Server only. A plan runs nothing by existing: only delegation turns it into pending child executions, and every tool still goes through the X3 gate.

- `proposal.ts`: `checkProposal()`, the closed schema of what a model or workflow may propose.
- `validate.ts`: `createPlanValidator()`, the pipeline `schema → policy → permission → plan`, reusing X2 eligibility, the X3 registry and risk policy, and X1's `checkGraph`.
- `estimate.ts`: `createPlanEstimator()`, estimates from known prices and a configured rate only; otherwise `unknown`.
- `lifecycle.ts`: plan statuses and allowed moves.
- `model.ts`: plans and write-once versions with their SHA-256 digest, decisions bound to one version, stored-record checks.
- `repository.ts`: `PlanRepository` and the in-memory one (Firestore lives in the API).
- `service.ts`: `createPlanService()`: read, `propose` (server side), approve and reject (a user directly, never GIA).
- `planner.ts`: `createPlanner()`: objective → AI Gateway → proposal → plan.
- `delegation.ts`: `createDelegation()`: one pending child execution per specialist step.
- `testkit.ts`: test fixtures only, excluded from the build.
