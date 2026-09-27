# @melonoffice/execution

The execution foundation ([ADR-0024](../../docs/adr/0024-execution-foundation.md)): the persistent, tenant-safe contract that planners, specialists, tools, workflows, approvals, verification and GIA will write into. It runs nothing itself. Server only, with no HTTP.

- `lifecycle.ts`: the 10 execution statuses, the 6 modes, the allowed transitions (`completed`, `failed` and `cancelled` are terminal) and the node statuses.
- `model.ts`: pure operations: `newExecution()`, `applyStatusChange()`, `addNodes()`, `applyNodeChange()`, graph checks (unique ids, known dependencies, no cycles) and the frozen version snapshot.
- `repository.ts`: the `ExecutionRepository` port (writes the execution and its audit events together, one revision at a time) and a memory implementation for tests.
- `service.ts`: `createExecutionService()`, working on a resolved `TenantContext`.
- `errors.ts`: stable codes (`execution_not_found`, `invalid_execution_transition`, `execution_already_terminal`, `execution_concurrency_conflict`…).

A specialist is the agent (D-28): executions reference specialists, they do not define agents. Executions hold references, never prompts, bodies or secrets.
