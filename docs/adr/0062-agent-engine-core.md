# ADR-0062: Agent Engine core (AE-1)

- Status: Proposed
- Date: 2026-09-29
- Builds on:
  - ADR-0025 (departments and specialists): a specialist is the agent; versions are immutable;
  - ADR-0026 and ADR-0034 (tools, approvals, Tool Gate): the only way a tool runs;
  - ADR-0043 (conversation agent), where `specialist.manage` was deferred;
  - ADR-0047 (six departments).
- Does not change:
  - the specialist model, eligibility, `AssignmentGuard`, the Tool Gate, approvals, the runtime or the AI Gateway;
  - GIA, which gets no new capability here;
  - any tool: the catalogue still holds only `message_send` and `conversation_handoff`.

## Context

The chain the product needs is GIA → MelonMotor → Agent Engine → Specialist Agent → Skills → Tools → Execution Engine → Result.

Everything after "Specialist Agent" existed:

- the specialist and its versions;
- the tool catalogue and its gate;
- executions, runtime and jobs.

What was missing:

- a catalogue of skills;
- starting configurations for the initial agents;
- a way for the owner to create and change agents without an operator script;
- one answer to "what may this agent do?".

## Decision

### 1. Skills are catalogue data

- `SKILL_CATALOGUE` in `packages/specialists/src/skills.ts` is versioned and resolved by exact version, with no "latest".
- A skill grants nothing (amended by ADR-0069: a skill is now the only source of an agent's tools and Decision Engine actions, still with no authority of its own). It names:
  - the catalogue tools it uses (the agent's version must also have them, and the gate still decides every call);
  - the permissions that read the records it works from.
- No code assumes how many skills exist.
- Only `conversation_reply` uses tools today.

### 2. Agent templates

`AGENT_TEMPLATES` holds the initial agents:

| Template      | Department                                          |
| ------------- | --------------------------------------------------- |
| Comercial     | `sales`                                             |
| Marketing     | `marketing`                                         |
| Creative      | `marketing` (design is part of Marketing, ADR-0047) |
| Operaciones   | `operations`                                        |
| Finanzas      | `finance`                                           |
| Investigación | `research`                                          |

- A template is never an agent.
- GIA is not a template. It is the executive orchestrator (Consejo/Dirección), never a department agent, and it never runs tools.
- Each template has one base role of its own (`commercial_agent`, …), version 1. Geovet chose this on 2026-09-29; it stays provisional until the role catalogue (D-27) is decided.

### 3. What an agent may do

`agentCapabilities` is deterministic: no AI and no rule of its own. It reads the agent's current version against the skill catalogue, the tool registry the gate uses, and the permissions held by the person reading. It reports:

- the skills and tools;
- permissions required and missing;
- problems: unknown skill or tool, a skill tool not assigned, a permission not held, not active;
- `ready`.

The gate, eligibility and approvals still decide at run time.

### 4. `specialist.manage`

- A new permission, owner only.
- It needs a person acting directly:
  - the runtime actor is refused;
  - GIA has no path to it (no tool and no service reference).
- The service checks it again behind the route.

### 5. Management API

- `GET /v1/organizations/:id/agents/catalogue` (`specialist.read`): templates and skills.
- `POST /v1/organizations/:id/specialists` `{templateId, displayName, locale?}`:
  - creates a `draft` agent, version 1;
  - no tools;
  - its permissions are the union of its skills' reads.
- `PATCH /v1/organizations/:id/specialists/:sid` `{fromVersion, configuration}`:
  - creates a new immutable version;
  - a stale `fromVersion` gets 409;
  - tools and the conversation profile must stay exactly as they are;
  - skills and tools must be in the catalogues, and every tool a skill uses must be assigned;
  - every permission the skills and tools need must be listed.
- `POST /v1/organizations/:id/specialists/:sid/status` `{from, to}`: moves along the existing lifecycle.
- `GET /v1/organizations/:id/specialists/:sid/capabilities` (`specialist.read`).

An agent of another organization answers 404, like a missing one.

### 6. Audit with the write

- `specialist.created`, `specialist.version_created` and `specialist.status_changed` are stored in the same Firestore transaction as the change, or nothing is.
- The events carry the target version and, for status, the transition.
- They never carry the name or purpose.

## Consequences

- The owner can create and configure agents. No agent can reach outside MelonOffice through this API: adding tools stays an operator step until AE-4 gives each tool its own rules.
- There is still no general task execution for agents (AE-2) and GIA does not delegate yet (AE-3).
- No infrastructure change. No new collection; audit events go to `auditLogs` as before.
