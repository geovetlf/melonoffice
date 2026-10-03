# ADR-0133: prompt versions, recorded with every model call (G-3)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0069](0069-skills-grant-tools.md) (versioned catalogue data), [ADR-0100](0100-harness-provider-preference-and-task-budget.md) (call traces), [ADR-0132](0132-agent-guardian.md)
- Decision: Geovet, 2026-10-03 18:52Z, "Autorización: continuar auditoría MelonOffice", block G-3 Prompt Versioning, the base for evals (G-4) and optimization (G-5).
- Terraform: none. Firestore: no new collection or index. Optional fields only, so earlier records read as before. Nothing is migrated.

## Context

Skills, tools, agents and model policies were versioned, but the text MelonOffice sends a model was not. A change to a prompt could not be told apart in results, cost or failures, and an eval baseline could not say which text it measured.

## Decision

1. **A version per prompt.** `PromptRef {id, version}` and the label `id@version` live in `@melonoffice/ai-gateway` (`promptRef`, `promptLabel`, `promptOf`). Each prompt declares its ref next to the code that writes it:

| Prompt                     | Ref                         |
| -------------------------- | --------------------------- |
| Agent tasks and plan steps | `agent_task@1`              |
| AI answer review           | `agent_review@1`            |
| Conversation agent         | `conversation_agent_turn@1` |
| Reply assistant            | `conversation_assist@1`     |
| GIA chat                   | `gia_chat@1`                |
| GIA plan summary           | `gia_summary@1`             |
| Planner                    | `plan_proposal@1`           |
| Company Brain extractor    | `knowledge_extract@1`       |
| Routing decider            | `decision_routing@1`        |
| Document transcription     | `document_transcription@1`  |

2. **It travels with the call.** Each call carries its label in `metadata.prompt`. No new request field is added. The label is recorded in:
   - the call trace (`AICallTrace.prompt`), which the runtime and the AI review write;
   - the AI usage ledger (`attribution.prompt`, checked against the label's shape).

   Results, credits and failures can therefore be grouped by prompt version.

3. **It is in the task's version snapshot.** An agent task's execution records `{kind: 'prompt', id: 'agent_task', version}` next to its agent, skills and tool.
4. **Text changes mean a new version.** `apps/api/src/prompts-catalogue.test.ts` renders every prompt for a fixed example and pins its digest to its version. If the text changes, the test fails until the version goes up and the new digest is added. The list is append-only, so a recorded version always means the same text.

## Rollback

Revert the merge commit. The optional fields already recorded are ignored by the earlier code.
