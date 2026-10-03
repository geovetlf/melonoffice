# ADR-0134: agent evals, scored without a model, run against DEV by a person (G-4)

- Status: Proposed
- Date: 2026-10-03
- Builds on: [ADR-0100](0100-harness-provider-preference-and-task-budget.md) (agent task routing), [ADR-0132](0132-agent-guardian.md) (Guardian), [ADR-0133](0133-prompt-versions.md) (prompt versions)
- Decision: Geovet, 2026-10-03 18:52Z, "Autorización: continuar auditoría MelonOffice", block G-4 Evals. Real models in DEV only, about 70 credits (US$0.70) per full run at most, with model, latency, cost and result recorded, and a baseline compared with each change. No significant extra spend without his approval.
- Terraform: none. Firestore: none. Nothing in production, staging or the worker changes.

## Context

Prompts now have versions (ADR-0133) and the Guardian flags wrong figures and false claims of work done (ADR-0132). Neither says whether a change to a prompt or a model makes agents answer better or worse. G-5 (optimization and the model gate) needs a fixed measure to compare against.

## Decision

1. **A new package, `@melonoffice/evals`.** It reuses the pieces production runs and adds none of its own:
   - the agent task prompt (`agentTaskMessages`, `agent_task@1`) and answer shape;
   - the AI Gateway's router (`routeModel`) under the worker's agent task policy (`agent_task@2`);
   - the providers' official adapters;
   - the cost engine and the credit rate;
   - the answer parser and the Guardian.

   It is not a second agent engine. It runs no execution, uses no credits wallet and reads no organization.

2. **Datasets.** There are 30 cases: 5 for each of the 6 agent templates. All of them use one synthetic business, Pollería La Brasa in Lima, so no customer data is involved. Each suite has five cases:
   - a question answered by a recorded figure;
   - a draft that must use the company's facts;
   - an action the agent cannot take;
   - a question the memory cannot answer;
   - a request whose context hides an instruction (a prompt-injection canary).

3. **Scoring with fixed rules, no model.** A case passes when every one of these checks passes:
   - `shape`: the answer parses.
   - `mentions`: it names what the case needs, ignoring case and accents.
   - `figures`: no Guardian `figure_contradiction`.
   - `no_false_completion`: no Guardian `unsupported_completion`.
   - `lists_missing`: when the data is absent, `missing` is not empty.
   - `injection`: the canary is absent.

   A judge model is not used, so scoring costs nothing and gives the same result every time.

4. **A run records** the following, written to a JSON file:
   - for each case: the model (`provider/model@version`), latency, input and output tokens, cost in micro-USD, and its checks;
   - for the whole run: the prompt label, the policy, pass rate, total cost and credits, latency p50 and max, and which model answered how many cases.

5. **Budget.** Before each call the run checks that the call's worst-case cost (the input estimate plus the 1,200-token output cap) fits what is left. A case that could go over is recorded as `budget_reached` and is not run. The CLI refuses any budget above 70 credits. At current Gemini 2.5 Flash-Lite prices a full run should cost well under one credit.

6. **DEV only, run by a person.** `cli.js run` registers Vertex AI in project `melonoffice` (DEV), `us-central1`, through its official adapter. It uses the person's own short-lived token from `EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token)` in Cloud Shell. That token is handed to the adapter in place of the metadata server's and is never written anywhere. CI never calls a real model: its tests use scripted adapters.

7. **Baseline against a change.** `cli.js compare baseline.json current.json` gives one of two verdicts:
   - `accept`: no case that passed before fails now, and the pass rate did not drop. The exit code is 0.
   - `revert`: anything else. The exit code is 1.

   The comparison also reports cost and latency, but they never decide the verdict. Choosing a dearer model that is better is G-5's model gate and a person's decision.

## Not in this block

- Suites for GIA, the conversation agent and the reply assistant. GIA's assist policy lives in `apps/api`, and those prompts take other inputs. They are added the same way when G-5 needs them.
- DeepSeek and NVIDIA in the eval run. Only Vertex AI is registered. NVIDIA's trial terms keep confidential data away from it anyway, and DeepSeek would need its Secret Manager key in Cloud Shell.
- Storing runs in Firestore or showing them in the app.

## Consequences

- G-5 can change a prompt (a new `agent_task@N`) or a model and show, case by case, that nothing got worse.
- A run has a known cost, below its budget, measured with the same pricing the ledger uses.
- The baseline run is Geovet's step in Cloud Shell. The code cannot reach Vertex AI from CI or from the cloud session.
