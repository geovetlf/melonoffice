# @melonoffice/workflows

Reusable, versioned plan templates ([ADR-0028](../../docs/adr/0028-planner-delegation-and-workflows.md)). Server only. A workflow runs nothing: instantiating it proposes a plan through the same validation as the planner's.

- `lifecycle.ts`: `draft → active ⇄ paused → archived`.
- `model.ts`: workflows, write-once versions with their digest, and `checkWorkflowSteps()` (the plan proposal schema, with a department type and role instead of a specialist).
- `repository.ts`: `WorkflowRepository` and the in-memory one (Firestore lives in the API). Every change is stored with its audit events, or not at all.
- `service.ts`: `createWorkflowService()`: read (`workflow.read`), create, version and activate (`workflow.manage`), and `instantiate`, which binds each role to an eligible specialist deterministically. Every change is audited: `workflow.created`, `workflow.version_created`, `workflow.state_changed`.

## Tests

The end-to-end runs of this engine are tested in `apps/worker/src/workflow-runs.test.ts`, on the Firestore emulator. On CI that file has hit Vitest's 40 s limit (run [38215123274](https://github.com/geovetlf/melonoffice/actions/runs/38215123274)). The probable cause is concurrent load on the shared emulator and the CPU, since the api, worker, runtime and firestore suites run in parallel. [#238](https://github.com/geovetlf/melonoffice/pull/238) turned off the metadata-server lookup for the worker's Firestore tests, but its effect has not been shown to be measurable in CI.

Until there is new evidence, the limit stays at 40 s, no assertion changes, and the CI configuration stays as it is.
