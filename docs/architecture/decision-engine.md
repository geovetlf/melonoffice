# Decision Engine

The Decision Engine is MelonMotor's one place that decides (ADR-0065). It lives in `packages/decisions`. It decides and explains; it never executes.

## Flow

```
caller (API route, GIA, agent runtime, workflow)
  │  evaluateDecision(tenant, { type, input })
  ▼
Decision Engine
  1. tenant resolved?                        no  → unresolved_tenant
  2. decider known?                          no  → unknown_decision_type
  3. person holds every permission?          no  → permission_denied  (audited: denied)
  4. required ports set up here?             no  → not_configured     (audited: denied)
  5. parse input                             bad → invalid_input
  6. decide: rules → structured reads (as the person) → cache/preload → AI Gateway (only if needed)
  7. frozen DecisionResult                   (audited: success, or failure)
  ▼
caller shows it; a person confirms; the owning engine (follow-ups, agent tasks,
tool gate + approvals) carries it out and audits it
```

## DecisionResult

| Field                         | Meaning                                                                           |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `id`                          | `dec_` + 32 hex; the audit target                                                 |
| `type`, `version`, `category` | the decider, e.g. `action.policy_check@1`, category `policy_check`                |
| `outcome`                     | closed code, e.g. `approval_required`, `attention_needed`, `insufficient_context` |
| `priority`                    | `high`, `medium`, `low` or null                                                   |
| `reasons[]`                   | `{code, rule: 'id@version', params}`: why, and the values compared                |
| `evidence[]`                  | `{source, ref, fact, value}`: which record and which of its facts                 |
| `items[]`                     | one decision per record, for decisions over several                               |
| `requiredApproval`            | an approval is needed before anything is carried out                              |
| `recommendedAction`           | `{code, action, link}`: next step; `action` is a catalogue action or null         |
| `constraints[]`, `warnings[]` | limits (e.g. `lists_partial`) and what to know (e.g. `policy_not_confirmed`)      |
| `rules[]`                     | every rule applied                                                                |
| `sourceContext`               | `sources` read and parts `withheld` from this person                              |
| `model`                       | `{provider, id}` when the AI Gateway was used, else null                          |
| `createdAt`                   | ISO time                                                                          |

There is no confidence field: no decider has a real measure of one.

## Adding a decision type

1. Write a `Decider` in `src/deciders/`:
   - its `type`, `version`, `category`, `permissions`, `requires` (port keys) and `usesAI`;
   - a strict `parse`;
   - a `decide` that reads only through `context.ports` as `context.tenant`.
2. Version its rules (`{id, version}`) and cite them in `reasons` and `rules`.
3. Add it to `DECIDERS`. The API and `listDecisionTypes` pick it up.
4. If it uses a model, call `ports.gateway.assist` with subject `{type:'decision', id: orgId}`, a closed output enum and a person as actor. Treat any answer outside the enum as no answer.

## Adding a company policy

A policy is a Company Brain fact in the `policies` domain whose key a rule knows. `POLICY_KEYS` lists them; today there is one, `discount_approval_above_percent`, a number.

The policy check trusts a policy only when all of these hold:

- it is `active`;
- it is `confirmed`;
- it does not need confirmation;
- it has no open conflict.

Otherwise the result asks for approval and says why.

## Adding an action

Add an entry to `ACTION_CATALOGUE` with:

- a unique `id`;
- the RBAC permission it needs;
- `confirmation` (`person_confirms` or `approval`);
- `proposers`;
- `maxCredits`.

The engine that carries it out must exist before the API's `configured` marks it available.

## Security rules

- Context comes only from ports that re-check tenant and permissions. `preload` is server-only; no route accepts it.
- Text from people or records reaches a model only inside escaped data blocks, with control characters removed.
- The audit records type, version, rules and outcome, never names, amounts or requests.
- Nothing runs by itself:
  - no payment, external message, financial change, deletion or irreversible action;
  - `RECOMMENDED_ACTION_TOOLS` is empty;
  - workflows wait on `await_approval`.
