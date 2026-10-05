# ADR-0176: the planner stays on plan_proposal@3, with the deterministic reading of tool steps

- Status: Accepted
- Date: 2026-10-05
- Builds on: [ADR-0172](0172-plan-proposal-3.md) (@3), [ADR-0173](0173-reading-tool-steps.md), [ADR-0174](0174-plan-proposal-6.md) and [ADR-0175](0175-plan-proposal-7.md) (reading tool steps, @5 to @7)
- Product decision: Geovet, 2026-10-05 18:51Z, chose "@3 + reader" after the measurements below.
- Terraform: none. Firestore: none. Models and providers: none. Agent Engine, conductor, validator and Credit Core: unchanged.

## Context

Real runs with three repetitions per case (Gemini 2.5 Flash-Lite, DEV), all read with today's `resolveToolSteps`:

| Version | Repetitions passed | Language | Valid plan |
| ------- | ------------------ | -------- | ---------- |
| @3      | 34/48              | 33/37    | 34/37      |
| @6      | 30/48              | 22/32    | 26/32      |
| @7      | 25/48              | 22/31    | 26/31      |

What the runs show:

- @7 used @3's own language line, yet it still answered Spanish requests in English. So the regression did not come from that line. It came with the rest of what @4 added.
- Each prompt change also moved cases it did not touch. p11 and p15 fell to 0/3 under @7.
- No measured version passes p07 or p16 reliably, @3 included.

## Decision

1. **The planner sends `plan_proposal@3` again, text unchanged.** Its digest is the one already pinned and running in DEV. No new version is added. @4 to @7 stay frozen in the evals (`--prompt 4` to `7`), and their pinned digests stay, because the list is append-only.
2. **The deterministic reading of tool steps stays** (ADR-0173, ADR-0174, ADR-0175). It covers:
   - a tool written before its agent's work;
   - a step waiting on its own tool;
   - work waiting on a tool;
   - an agent named by specialistId, department or role.

   The reading turns only refused plans into valid ones. It never changes a plan the validator already accepts. That is why it cannot lower @3's validity, and why the @3 run above is the measurement of this configuration.

3. **@3's own example now reads as valid.** Its last step waits on the tool step, which the validator refuses (the bug ADR-0172 fixed in @4). The reading points that step at the tool's agent step. A test checks that the example passes the validator through the product's reading.
4. **Known and open:** p07 (language) and p16 (approval) do not pass reliably. They are not promised fixed. Changing them needs a new decision.

## What a person sees

The draft card and plan pages are unchanged. Plans that @3 answered with the tool first now show as the same ready card as any valid draft, instead of an invalid one. This was checked locally on desktop and mobile in melonoffice-plan/p5-shots and p6-shots, not in DEV.
