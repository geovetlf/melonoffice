# @melonoffice/ai-nvidia

The NVIDIA provider adapter ([ADR-0080](../../docs/adr/0080-nvidia-provider.md)), behind the AI Gateway ([ADR-0027](../../docs/adr/0027-ai-gateway-and-provider-registry.md)). The only code that knows NVIDIA's endpoint, request and response format. Server only. Full notes: [docs/providers/nvidia](../../docs/providers/nvidia/README.md).

- `catalogue.ts`: the provider (NVIDIA hosted API, DEV only, `public` data only) and its model, Nemotron 3 Nano 30B A3B, with its terms as NVIDIA publishes them (free for prototyping, production needs a licence, content may be used by NVIDIA).
- `adapter.ts`: `createNvidiaAdapter()`: OpenAI-compatible chat completions over REST with the API key from a `CredentialResolver` (Secret Manager); tool calling; streaming; `Retry-After` on 429; reasoning traces dropped; every failure classified, never thrown.
- `discovery.ts`: `listNvidiaModels()` reads `GET /v1/models`; `catalogueDrift()` reports registered models NVIDIA no longer serves. It never registers anything.
