# Self-hosted NIM (research only)

**Nothing is deployed, and no GPUs are created.** This page records what NVIDIA publishes, so a later decision starts from facts.

## Licensing

- Developer Program members may download NIM for "development, testing, and research" on "up to two nodes, or 16 GPUs" ([NVIDIA blog, 2024-07-29](https://developer.nvidia.com/blog/access-to-nvidia-nim-now-available-free-to-developer-program-members/)).
- "Using NIM in production requires an NVIDIA AI Enterprise license". The price is "$4500 per GPU per year or ~ $1 per GPU per hour in the cloud", and "Pricing is based on the number of GPUs, not the number of NIMs" ([NIM FAQ](https://docs.api.nvidia.com/nim/docs/product)).
- A 90-day free NVIDIA AI Enterprise licence is offered for evaluation (blog, as above).

## API

A self-hosted NIM for LLMs serves the same OpenAI-compatible API:

- `/v1/chat/completions` and `/v1/models`;
- `/v1/health/ready` and `/v1/health/live`;
- `/v1/embeddings` on embedding NIMs.

NVIDIA documents structured output (`nvext.guided_json`) for it ([structured generation](https://docs.nvidia.com/nim/large-language-models/1.12.0/structured-generation.html)).

## What MelonOffice has ready

- **The adapter.** `createNvidiaAdapter({ baseUrl })` takes a self-hosted address (https only). So a self-hosted NIM would be the same adapter, a different address, and its own model entries with their own terms and price.
- **Credentials.** The same Secret Manager `ai-*` path, if the NIM needs a key.

## Unknown here

- **GPU and memory per model.** These are in each NIM's support matrix, which was not reviewed for this change: UNKNOWN.
- **Cloud GPU cost and capacity in us-central1.** Not researched: UNKNOWN.
