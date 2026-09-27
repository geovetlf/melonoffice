# @melonoffice/guardrails

Guardrails and the tool gate ([ADR-0026](../../docs/adr/0026-tools-approvals-and-guardrails.md)): Execution → Authorization → Guardrails → Approval → Tool → Result → (future) Verification. Server only, with no HTTP.

- `rules.ts`: `evaluatePreExecution()` (allow, deny with a reason, or require an approval), `evaluatePostExecution()`, and the default `RiskPolicy`.
- `gate.ts`: `createToolGate()`, the only code that runs a tool. It checks, asks for or checks the approval, runs the node once in a transaction, applies the timeout and retry policy, checks the output and records every step in the audit log. It never completes an execution.
