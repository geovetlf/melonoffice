---
name: agent-audit
description: Add or change a team review check on agents (auditAgents, G-1) or the Agent Guardian (G-2), and test it.
---

# Agent audit and Guardian

The team review and the Guardian are deterministic: no model call and no credits. Extend them; never add a second verifier or reviewer.

## Where things are

- Team review: `auditAgents` in `packages/agents/src/audit.ts` (ADR-0131). It is served by `GET /v1/organizations/:org/agents/audit` in `apps/api/src/agent-audit.ts`, which needs `specialist.read`.
  - Company Brain, workflows and plans are reviewed only when the reader holds their own read permission. Otherwise the area is listed in `skipped`.
- Upgrade impact: `upgradeImpact` in the same file. It warns before a skill upgrade drops a tool a workflow needs.
- Figure contradictions with Company Brain: `figureContradictions` in `packages/brain/src/consistency.ts`.
- Guardian: `guardAnswer`, run inside `createAgentTaskVerifier` (ADR-0132).
  - Only a figure that contradicts a confirmed fact is critical.
  - Unconfirmed figures, unsupported "done" claims and failed tools are warnings.
  - The worker logs `agent_guardian.warning`, which Cloud Monitoring counts (ADR-0136).

## Adding a check

1. Add the finding `code` and its data to `AgentAuditFacts` if the check needs new facts. The API gathers facts; `auditAgents` stays pure.
2. Give it a severity: `critical` only when an answer or run would be wrong, `warning` when it may be, `info` otherwise. Add a recommendation from `AuditRecommendation`.
3. Add the UI text for the code in every i18n catalogue (EN and ES).
4. Test the pure check in `packages/agents/src/audit.test.ts`, and the permission and tenant cases in `apps/api/src/agent-audit.test.ts`.

```sh
pnpm --filter @melonoffice/agents test
FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 pnpm --filter @melonoffice/api test -- agent-audit
```
