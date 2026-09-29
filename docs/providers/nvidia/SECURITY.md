# Security

## The API key

- It lives only in Secret Manager, in a secret named `ai-*` that the owner creates.
- The api and worker get it through `NVIDIA_API_KEY_SECRET`. That setting holds the reference (`projects/{p}/secrets/ai-…/versions/latest`), never the key. A pasted key is refused at startup and never echoed.
- Terraform grants `secretAccessor` on that one secret to the api and worker runtime identities. It cannot list, create or change secrets, and Terraform never holds the value.
- The adapter holds the key as an opaque `ProviderCredential`, which prints and serializes as `[redacted]`. It is kept in memory for 5 minutes, and dropped at once on 401 or 403.
- The key is never in the frontend, Git, logs, audit, prompts, responses, Firestore or code. Tests build fake keys at run time, so scanners stay clean.

## Data

- NVIDIA's trial terms let it use what it is sent. So every NVIDIA model has `maxSensitivity: 'public'`, and the registry refuses anything higher while `contentUse` is not `not_used`.
- GIA, conversations, Company Brain, decisions and documents send `confidential` data under policies that allow only Gemini on Vertex AI. None of it can reach NVIDIA.

## What is never passed on

- **NVIDIA's error messages.** Errors are classified (`authentication`, `rate_limited`, …) with the HTTP status only.
- **Reasoning.** Neither `reasoning_content` nor `<think>` traces are passed on.
- **Credentials in answers.** Answers that look like they carry one are refused by the gateway, as for every provider.
- **Content in logs and usage.** Logs and usage events hold ids, units and costs only.

## No intermediaries

MelonOffice calls NVIDIA's own API: `integrate.api.nvidia.com`, or later a self-hosted NIM. It never goes through OpenRouter, Replicate, Together, Hugging Face Inference, fal.ai or any other aggregator; the registry refuses those by name.
