# @melonoffice/workflows

Reusable, versioned plan templates ([ADR-0028](../../docs/adr/0028-planner-delegation-and-workflows.md)). Server only. A workflow runs nothing: instantiating it proposes a plan through the same validation as the planner's.

- `lifecycle.ts`: `draft → active ⇄ paused → archived`.
- `model.ts`: workflows, write-once versions with their digest, and `checkWorkflowSteps()` (the plan proposal schema, with a department type and role instead of a specialist).
- `repository.ts`: `WorkflowRepository` and the in-memory one (Firestore lives in the API). Every change is stored with its audit events, or not at all.
- `service.ts`: `createWorkflowService()`: read (`workflow.read`), create, version and activate (`workflow.manage`), and `instantiate`, which binds each role to an eligible specialist deterministically. Every change is audited: `workflow.created`, `workflow.version_created`, `workflow.state_changed`.
