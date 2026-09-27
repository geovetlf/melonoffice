# @melonoffice/tools

Tools: typed, versioned actions MelonOffice can take ([ADR-0026](../../docs/adr/0026-tools-approvals-and-guardrails.md)). A tool is not a skill, a specialist or an execution. Server only, with no HTTP. This package describes tools; it never runs one: only the tool gate in `@melonoffice/guardrails` does.

- `model.ts`: lifecycle (`active` only runs), risk levels, approval policies, environments, and `checkToolVersion()` / `checkToolDefinition()`.
- `schema.ts`: the small, closed schema language and `validate()`. Authority fields and credentials are refused at any depth.
- `registry.ts`: `createToolRegistry()`, frozen, exact versions only, refusing a changed published version. `TOOL_CATALOGUE` is empty until real tools arrive.
- `executor.ts`: the `ToolExecutor` contract, its safe `ToolExecutionContext`, `ToolResult` and `idempotencyKeyOf()`.
- `canonical.ts`: canonical JSON and SHA-256 digests, compared in constant time.
