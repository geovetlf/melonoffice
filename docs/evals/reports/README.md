# Model eval reports

One file per model that may serve agents outside DEV, named `provider__model@version.json`. The model gate test (`packages/evals/src/gate.test.ts`, ADR-0135) fails until the model's report:

- was run with the current agent task prompt and cases;
- had every case answered by that model;
- passed at least 90% of the cases.

To make a report, in Cloud Shell:

```sh
EVAL_ACCESS_TOKEN=$(gcloud auth print-access-token) \
  node packages/evals/dist/cli.js run --model <provider/model> --out ~/evals/<model>.json
node packages/evals/dist/cli.js report ~/evals/<model>.json
```

Then commit the new file. Today every model is DEV only, so no report is required yet.
