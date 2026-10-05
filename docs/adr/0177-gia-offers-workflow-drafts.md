# ADR-0177: GIA offers to prepare an automation, and the saved draft opens where it is edited

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0171](0171-plan-proposal-2-and-workflow-drafts.md) (GIA drafts a workflow, Block 3 F2), [ADR-0176](0176-planner-stays-on-plan-proposal-3.md) (the planner stays on `plan_proposal@3`)
- Product decision: Geovet, 2026-10-05 20:43Z, Block 3 F3: User → GIA → intent → proposed workflow → real capabilities checked → summary → the person reviews → saves a draft → activates it explicitly. Never auto-save, never auto-activate, GIA never approves.
- Terraform: none. Firestore: none. Prompts: none (`gia_chat@1` and `plan_proposal@3` unchanged). Models and providers: none. Agent Engine, conductor, validator, planner and Credit Core: unchanged.

## Context

F2 lets a person ask for a workflow draft in two places: "Crear con GIA" on Automations, and the "Preparar como automatización" button under GIA's chat. Either way, the person had to know to ask for it. When they told GIA about repeatable work in the chat ("cada lunes…"), GIA answered the words and said nothing about automating them. After saving, the card's link went to Automations without opening the saved workflow.

## Decision

1. **GIA's answer says whether the words read as an automation (`workflowIntent`).** The server reads it from the person's own message with fixed rules (`workflowIntentOf` in `@melonoffice/gia`): work that repeats ("cada lunes", "every week"), starts when something happens ("cada vez que llegue un cliente"), runs in ordered steps ("primero… luego…"), or names an automation outright. A message that starts by asking for facts or figures ("¿cuánto vendí cada mes?") never counts. No model decides it, and neither prompt changes. It is `true` only for a person who may write workflows and create plans (`workflow.manage`, `plan.create`); the browser never decides it.

2. **The chat offers; the person decides.** When `workflowIntent` is true, GIA's reply carries an offer: "Preparar como automatización" or "Ahora no". Nothing is drafted until the person taps it. The tap runs F2's draft unchanged (planner `@3`, the deterministic reader, the validator's dry run) with the words already in the chat. Saving stays the card's "Guardar borrador", through the existing workflow route, as the person. Activation stays the workflow's own "Activar" on Automations. GIA never saves, activates, approves or rejects.

3. **The saved draft opens where it is edited.** The saved card links to `/automations?workflow=<id>`. Automations opens that workflow with its steps and "Editar (nueva versión)", the existing advanced editor.

4. **The ready card counts its steps** ("Qué hará · 4 pasos").

## What a person sees, per surface

|                        | GIA chat offer                                                                     | Draft card (chat and Automations)                                                                                 | Automations, opened workflow                                |
| ---------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Where                  | Under GIA's answer, after her other proposals                                      | In the chat below the offer, or in the "Crear con GIA" panel                                                      | The workflow's row in the Workflows list                    |
| What                   | Says it looks repeatable and that nothing is saved or activated without the person | What it does (with step count), who, what it reads, what it changes, what asks approval, when it runs, the result | Status Borrador, version, steps, Activar / Archivar, Editar |
| Loading                | n/a (comes with GIA's answer)                                                      | "GIA está preparando…" (F2)                                                                                       | The list's loading state                                    |
| Empty                  | Not shown when there is no intent or no permission                                 | n/a                                                                                                               | The list's empty state                                      |
| Error                  | n/a                                                                                | Planner error, validation error, not possible, no agents, credits: F2's messages, codes only                      | The list's error state with retry                           |
| Success                | "Te preparo el borrador aquí abajo."                                               | "Se guardó como borrador" + "Abrir la automatización"                                                             | The saved workflow open                                     |
| Disabled               | Buttons gone once taken or dismissed                                               | "Guardar borrador" absent for an invalid draft                                                                    | Existing transitions by permission                          |
| Approval               | Not decided here                                                                   | "Pide tu aprobación antes" per step                                                                               | "espera tu aprobación" per step                             |
| Processing / completed | Status line once taken                                                             | Saving… / saved                                                                                                   | n/a: activation is explicit                                 |
| Desktop / mobile       | Stacked buttons on mobile, no horizontal scroll (LOCAL QA at 1366 and 390 px)      | Same                                                                                                              | Same                                                        |
| Advanced               | Through the card                                                                   | "Ajustar en modo avanzado"                                                                                        | "Editar (nueva versión)"                                    |
| Reuses                 | `gia-chat__proposal`, `Button`, `mo-form__actions`                                 | `WorkflowDraftCard`                                                                                               | `AutomationsPage`, `WorkflowSteps`, `WorkflowEditor`        |

## Consequences

- A person's repeatable work in the chat leads to a reviewed draft in one tap, with no new model call until they take the offer, and no change to what the planner, validator or engine accept.
- The rules are deterministic and narrow, so some repeatable requests get no offer. The composer button and "Crear con GIA" still draft anything.
