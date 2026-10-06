# ADR-0181: a plan says who decided and who stopped it, and a withdrawn approval says why

- Status: Accepted
- Date: 2026-10-06
- Builds on: [ADR-0026](0026-tools-approvals-and-guardrails.md) (approvals), [ADR-0029](0029-runtime-guards.md) (cancellation cascade), [ADR-0179](0179-workflow-lifecycle-and-reliability.md) (cancel withdraws a plan's approvals), [ADR-0180](0180-each-workflow-shows-its-runs.md)
- Product decision: Geovet, 2026-10-06 19:01Z and 19:40Z, autonomous cycle: observability and a coherent UX between workflow, plan, execution and approvals, on the existing engines, without needing him.
- Terraform: none. Firestore: one optional field on approvals (`cancelReason`), no migration. Prompts, models and providers: none.

## Context

ADR-0179 records who stopped a plan and withdraws its approvals, and the QA of ADR-0179 checked both on the real API. What a person sees afterwards is still partial:

- **The plan card does not say who approved or stopped it.** The plan keeps its decision (`decidedBy`, `decidedAt`), and the planning execution keeps its cancellation (`by`, `at`, `reason`), but the card shows only "Cancelado · Terminó el …". Who did it is only in the audit trail and the technical trace.
- **A withdrawn approval does not say why.** Cancelling an approval stores its status and time, and puts the reason (`plan_cancelled`) only in the audit event. Approvals' history shows "Cancelada" with no cause, so a person cannot tell a plan they stopped from anything else.

## Decision

1. **An approval keeps why it was withdrawn.** `Approval.cancelReason` is set once, by `cancel`, to the stable code it was given (`plan_cancelled` from a plan's cancellation, ADR-0179). A stored approval whose reason is not a code, or that has one without being `cancelled`, is refused. The approvals API shows it as `cancelReason` (or null), and Approvals' history says "Retirada al cancelar el plan" for `plan_cancelled`, or a generic "Retirada" for any other code.
2. **A plan's detail says who stopped it.** `GET plans/:id` adds `stopped: { at, by, reason } | null`, read from the plan's own planning execution when the plan is `cancelled`. Nothing new is stored: the execution already records its cancellation (ADR-0029).
3. **The plan card says who decided and who stopped it**, in words:
   - "Lo aprobaste tú el …" or "Lo aprobó otra persona de tu organización el …", and the same for a rejection;
   - "Lo detuviste tú el …" or "Lo detuvo otra persona de tu organización el …".

   The web compares the user id with the signed-in person's own id and never shows ids. Names need a member directory, which this change does not add.

## What did not change, and why

- **No new store or engine.** The decision and the cancellation already existed; this reads them. The only new stored fact is the withdrawal reason, on the approval that is withdrawn.
- **Approvals cancelled before this change have no reason.** They read "Cancelada" as before.
- **A person still cannot type why they stopped a plan.** The reason stays the code `director_request`. A free-text reason would be stored text from a person and needs its own product decision.

## Tests

- `packages/approvals`: `cancel` records the reason once; a decided approval is not changed by a later cancel; a stored reason that is not a code, or on an approval that is not cancelled, is refused.
- `apps/api` (memory and Firestore): the approvals view carries `cancelReason`; a cancelled plan's detail carries `stopped` with who and when, a running one `null`; another organization sees neither.
- `apps/web`: the plan card says who approved and who stopped it, for the signed-in person and for another; Approvals' history says why an approval was withdrawn.
