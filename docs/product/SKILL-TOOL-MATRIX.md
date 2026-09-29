# MelonOffice: Skill → Tool/Action authorization matrix

- Date: 2026-09-29. SK-2 (ADR-0083), updated for ADR-0084 ("Proponer y agendar").
- Everything below is read from the code, not from names:
  - skills: `packages/specialists/src/skills.ts`;
  - agent templates: `packages/specialists/src/templates.ts`;
  - tools: `packages/tools/src/registry.ts`;
  - actions: `packages/decisions/src/catalogue.ts`;
  - risk policy: `packages/guardrails/src/rules.ts`;
  - seeded conversation agent: `apps/api/src/operator.ts`.

## The path

`Agent → Skill (exact version) → Tool version / Action → Permission (RBAC, of the person the agent acts for) → Decision Engine / Tool Gate → Execution`

- **Tools.** An agent may be given a tool version only if one of its skills grants that exact version. The rule is checked when the agent is created or revised (SK-1) and now again by the Tool Gate on every call (SK-2).
- **Actions.** An agent may propose an action only if one of its skills grants it. The Decision Engine checks this (SK-2).
- **No shortcut.** There is no Agent → Tool path: the gate refuses `tool_not_granted_by_skill`.
- **Who decides.** The LLM never decides risk or approval. They come from the tool version's `riskLevel` and `approvalPolicy`, made only stricter by the risk policy: low and medium run automatically, high needs approval, critical is always denied. Actions add their catalogue `confirmation`, RBAC and the Company Brain policies.

## 1. Skill → Tool/Action

| Skill               | Version | Tool / action                              | Permission                                     | Human only | Approval                          | Risk   |
| ------------------- | ------- | ------------------------------------------ | ---------------------------------------------- | ---------- | --------------------------------- | ------ |
| conversation_reply  | 1       | `message_send` v2 (supervised agent)       | conversation.send                              | no         | yes, every reply                  | MEDIUM |
| conversation_reply  | 1       | `message_send` v3 (autonomous agent)       | conversation.send                              | no         | no (the owner chose "autonomous") | MEDIUM |
| conversation_reply  | 1       | `conversation_handoff` v1                  | conversation.manage                            | no         | no                                | LOW    |
| conversation_reply  | 1       | reads conversations                        | conversation.read                              | n/a        | n/a                               | LOW    |
| company_knowledge   | 1       | reads Company Brain (own department)       | knowledge.read                                 | n/a        | n/a                               | LOW    |
| company_knowledge   | 2       | v1 reads + action `knowledge.propose_fact` | knowledge.read, knowledge.propose              | no         | the owner confirms each fact      | LOW    |
| customer_follow_up  | 1       | reads contacts, opportunities, follow-ups  | contact.read, opportunity.read, follow_up.read | n/a        | n/a                               | LOW    |
| customer_follow_up  | 2       | v1 reads + action `follow_up.schedule`     | follow_up.manage                               | no         | the person confirms               | LOW    |
| customer_follow_up  | 2       | `follow_up_schedule` v2 (runtime only)     | follow_up.manage                               | no         | yes, every follow-up (2-day TTL)  | LOW    |
| pipeline_analysis   | 1       | reads opportunities, reports               | opportunity.read, report.read                  | n/a        | n/a                               | LOW    |
| campaign_analysis   | 1       | reads contacts, reports                    | contact.read, report.read                      | n/a        | n/a                               | LOW    |
| content_drafting    | 1       | reads Company Brain                        | knowledge.read                                 | n/a        | n/a                               | LOW    |
| design_briefing     | 1       | reads Company Brain                        | knowledge.read                                 | n/a        | n/a                               | LOW    |
| operations_tracking | 1       | reads conversations, follow-ups            | conversation.read, follow_up.read              | n/a        | n/a                               | LOW    |
| finance_review      | 1       | reads reports, credits                     | report.read, credits.read                      | n/a        | n/a                               | LOW    |
| market_research     | 1       | reads Company Brain, reports               | knowledge.read, report.read                    | n/a        | n/a                               | LOW    |

Only the v2 skills grant Decision Engine actions (ADR-0084).

### Tools and actions no skill grants

| Tool / action                       | Version | Permission         | Human only   | Approval                                                              | Risk             | Why no skill grants it                          |
| ----------------------------------- | ------- | ------------------ | ------------ | --------------------------------------------------------------------- | ---------------- | ----------------------------------------------- |
| `message_send`                      | 1       | conversation.send  | **yes**      | no                                                                    | MEDIUM           | A person's own reply (CV-2).                    |
| `follow_up_schedule`                | 1       | follow_up.manage   | **yes**      | no                                                                    | LOW              | A person's own follow-up (TL-1). Agents use v2. |
| action `agent_task.assign`          | 1       | specialist.task    | GIA only     | the person confirms                                                   | LOW (≤ 1 credit) | Proposers: GIA only.                            |
| action `opportunity.offer_discount` | 1       | opportunity.manage | GIA or agent | the person confirms; approval above the Company Brain discount policy | MEDIUM/HIGH      | Nothing carries it out yet (ADR-0065).          |

### Business operations that exist only as a person's actions

These have API routes and screens for a person. None is a tool or an action, so no agent can reach them.

| Operation                                       | Permission                         | Risk if an agent did it                    |
| ----------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| Create or edit a contact                        | contact.manage                     | LOW/MEDIUM                                 |
| Create, move, win or lose an opportunity        | opportunity.manage                 | MEDIUM                                     |
| Change the pipeline                             | pipeline.manage                    | MEDIUM                                     |
| Company memory: confirm, edit or delete a fact  | knowledge.manage                   | MEDIUM                                     |
| Upload a document                               | document.upload                    | LOW                                        |
| Create, version or retire a workflow            | workflow.manage                    | HIGH                                       |
| Create, revise or change the status of an agent | specialist.manage                  | HIGH                                       |
| Approve or reject                               | approval.approve                   | CRITICAL: never an agent or GIA (ADR-0026) |
| Connect, change or delete a channel             | channel.*                          | HIGH                                       |
| Start or cancel an execution                    | execution.start / execution.cancel | MEDIUM                                     |

The following do not exist in MelonOffice, so nothing was added for them: create or classify a lead (there is no lead record), quotes, applying a discount, email, meetings, campaigns and financial operations.

## 2. Agent → Skill

| Agent (template)              | Department | Skills (version)                                               | Tools                                          | Actions                                    |
| ----------------------------- | ---------- | -------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------ |
| commercial                    | sales      | company_knowledge@2, customer_follow_up@2, pipeline_analysis@1 | follow_up_schedule v2                          | follow_up.schedule, knowledge.propose_fact |
| marketing                     | marketing  | company_knowledge@2, campaign_analysis@1, content_drafting@1   | none                                           | knowledge.propose_fact                     |
| creative                      | marketing  | company_knowledge@2, design_briefing@1, content_drafting@1     | none                                           | knowledge.propose_fact                     |
| operations                    | operations | company_knowledge@2, operations_tracking@1                     | none                                           | knowledge.propose_fact                     |
| finance                       | finance    | company_knowledge@2, finance_review@1                          | none                                           | knowledge.propose_fact                     |
| research                      | research   | company_knowledge@2, market_research@1                         | none                                           | knowledge.propose_fact                     |
| conversation agent (DEV seed) | sales      | conversation_reply@1                                           | message_send v2 or v3, conversation_handoff v1 | none                                       |

An agent stores its skills with their versions. Its capabilities never follow a newer version of a skill until a person with `specialist.manage` moves it there ("Update to version 2" on the agent's page, ADR-0084), which stores a new version of the agent. A new skill, tool or skill version reaches no template and no agent by itself; the tests in `apps/api/src/skills-catalogue.test.ts` check this.

## 3. Risk matrix

| Action                                     | Level         | Control today                                                                                                                                                                  |
| ------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read company records, as the person allows | LOW           | RBAC for the person; department reach for Company Brain.                                                                                                                       |
| Hand a conversation to a person            | LOW           | Automatic.                                                                                                                                                                     |
| Schedule a follow-up                       | LOW           | Person, or a GIA or agent proposal confirmed by a person. An agent schedules only through `follow_up_schedule` v2, after approval of that exact follow-up.                     |
| Send one message to a customer             | MEDIUM        | Supervised agent: approval on each reply. Autonomous agent: automatic, only when the owner set that level, plus the guards on limits, hours and the last check before sending. |
| Offer a discount                           | MEDIUM/HIGH   | The person confirms. Approval is required above the Company Brain `discount_approval_above_percent` policy, and when the policy is in conflict it is not trusted.              |
| Mass campaign                              | HIGH          | Does not exist. When it does, the risk policy requires approval.                                                                                                               |
| Any financial operation                    | HIGH/CRITICAL | Does not exist. High needs approval; critical is always denied by the gate.                                                                                                    |

## Decisions taken

Geovet chose option B on 2026-09-29 21:10Z (ADR-0084): proposals 1 to 3 are implemented, and `opportunity.offer_discount` stays unassigned until something carries it out.

## UI

- The agent's page lists, under "What this agent can do", each skill with its version. Under each skill it shows:
  - the tools it uses, with their risk and whether each use needs approval;
  - the actions it may propose for a person to confirm;
  - the records it reads.
- The agents screen shows the skills and tools catalogue. The tools list is shown to people with `tool.read`.
- Approvals show each request in the Approval Center (`/approvals`).
- Backend only, by design:
  - the `not_granted_by_skill` reason, which surfaces as a refused call in the audit trail and in the agent's capability problems;
  - which actions an agent may propose, which appears on the agent's page only once a skill grants one.
- An agent task shows the follow-up it proposed, with Approve and Reject for a person with `approval.approve`, and how many facts it proposed, with a link to Company memory.
