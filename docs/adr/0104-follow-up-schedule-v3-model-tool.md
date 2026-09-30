# ADR-0104: follow_up_schedule v3, the first tool an agent's model may ask for

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0103](0103-harness-tool-use-mid-task.md) (tools during a task), [ADR-0100](0100-harness-provider-preference-and-task-budget.md) (tool levels, `authorizeToolUse`), [ADR-0084](0084-agents-propose-and-schedule.md) (agents propose follow-ups), [ADR-0083](0083-skill-grants-enforced.md) (skill grants), [ADR-0068](0068-follow-up-tool.md) (`follow_up_schedule`)
- Decision: Geovet, 2026-09-30 17:22Z, after the tool audit (`melonoffice-plan/MelonOffice-Auditoria-Herramientas-Agentes.md`): "Prepara `follow_up_schedule` v3 como herramienta MODEL", level C, commercial agent only, a person approves every call.
- Terraform: none. Firestore: no new field or index. Nothing is migrated.

## Context

Block 5 (ADR-0103) lets an agent ask for tools mid-task, but no tool of the catalogue said a model could ask for it. The audit proposed one: scheduling a follow-up, already used by the commercial agent through the ADR-0084 schedule node, always approved by a person.

## Decision

### 1. A new version, nothing else changes

`follow_up_schedule@3` is added to the catalogue. Versions 1 and 2, `message_send` 1 to 3 and `conversation_handoff` 1 stay exactly as they were (the published-version check and the skills' pinned digests prove it).

Version 3:

- `invocationModes: ['runtime', 'model']`: the only model tool of the catalogue;
- `approvalPolicy: 'approval_required'`, so the Harness's `toolLevelOf` classes it **C** and `authorizeToolUse` answers `approval_required` on every call; the Tool Gate asks a person;
- input: `contact` (a reference of 12 characters), `type`, `title` (at most 120), `date`, `time`. The schema is closed: no contact id, request key, assignee, opportunity or source can be sent;
- permissions: `follow_up.manage` and `contact.read`, both held by the person the task is for;
- internal provider `follow_up`, 15 seconds, never retried, DEV only, like version 2.

### 2. Commercial agents only, and only when a person moves them

`customer_follow_up@3` grants `follow_up_schedule@3` (and the `follow_up.schedule` proposal). A skill may now name the department types whose agents may have it (`departments`); this one names `sales` (Comercial y Ventas):

- agent management refuses it for an agent of another department (`skills.department`), on creation, revision and upgrade;
- `grantsOf` with the agent's department grants nothing from it elsewhere, and the Harness's tool directory reads it that way, so the tool is never offered outside Comercial;
- the capabilities view offers only upgrades the agent's department may take.

The commercial template stays at `customer_follow_up@2`. A person with `specialist.manage` moves an agent to version 3 with the existing "Update to version 3" action; version 2's tool leaves the agent, version 3's arrives. Nothing reaches an agent by itself.

### 3. The contact is resolved on the server only

The model sees the contacts it may schedule with as `c_xxxxxxxxxx: name`, the same references ADR-0084 uses: letters derived from the id, never the id, never other details. It calls the tool with a reference.

After the approval, the executor:

1. checks it runs for the runtime, for an agent, under a recorded approval (`approval_missing` otherwise, whatever the policy said);
2. checks the call has exactly its five fields, well formed (`invalid_input`);
3. resolves the runtime tenant of the person the task is for, in the execution's organization (`permission_denied` if they left);
4. resolves the reference among the contacts of that organization the person may read (`contact.read`), the very list the task is shown. None: `contact_not_found`, which is also what another organization's contact gives. Two with the same reference: `contact_ref_ambiguous`. Nothing is scheduled in either case;
5. makes the request key itself, `agent-task-{executionId}-{sha256 of contact id, type, title, date, time}`;
6. calls the follow-up service's own `create` with `source: 'agent'`, which checks the contact (archived, not found), the date and time, and the per-record limit, and assigns the contact's responsible person.

The model never builds an id: an id sent as the reference, or any extra field, is refused by the schema (the gateway refuses the answer) and again by the executor.

### 4. Approval, continuation and rejection

Agent → `follow_up_schedule` → Harness (`authorizeToolUse`: C) → Tool Gate → approval → the task waits (`waiting_approval`, the tool node pending). Nothing runs.

- **Approved:** the existing resume runs the same node with the same call, the executor resolves and schedules, and the result goes back to the agent's next turn, which continues from there.
- **Rejected:** the gate refuses with `approval_rejected`, the tool never runs, the rejection stays on the approval record, and the task stops there (the existing policy): the next turn is cancelled.

The runtime can never approve (ADR-0029), so an agent cannot approve its own call. The approval is bound to the exact call.

### 5. Idempotency, limits, duplicates

- The request key makes one follow-up per request per task: a retry of the node, a repeated call, or the same call in a later turn returns the same follow-up (`created: false`).
- The Harness's duplicate rule runs a repeated call once in any case; a turn of repeats only is a loop.
- All limits are unchanged: 8 steps, 4 agents, 5 tools, 3 provider calls per turn, 10 minutes of working time (approval waits excluded), depth 1, and the task's credits.

### 6. Trace

Everything asked for is recorded on the records that already hold it:

| What                                  | Where                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| task, tenant, agent                   | the execution (`id`, `organizationId`, `specialistId` and version)                                                               |
| tool, version, request                | the turn's `agentOutputs.toolCalls`, the tool node, the approval's operation                                                     |
| approval required, approver, decision | the node's `approvalRequired`, the approval record (`status`, `decidedBy`, times)                                                |
| result                                | the tool node's output, kept with the agent's outputs; the follow-up (`source: agent`)                                           |
| timestamp, failure                    | the audit trail (`tool.execution_*`, `follow_up.created`, actor runtime for the person), the node's and execution's failure code |

The agent task view returns `toolFollowUp` (contact name resolved for the caller, type, title, date, time, state, approval id while it waits), and the task screen shows it with Approve and Reject, before the agent has answered.

## Consequences

- In DEV nothing changes until a person moves a commercial agent to `customer_follow_up@3`, and nothing is ever scheduled without a person's approval.
- Business checks (a past date, an archived contact, the per-record limit) run after the approval, as the service's own rules. A call they refuse ends the task with that code.
- Real function calling with Gemini on Vertex AI still needs a run in DEV, once billing is restored.
