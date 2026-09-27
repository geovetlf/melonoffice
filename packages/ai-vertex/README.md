# @melonoffice/ai-vertex

The Vertex AI provider adapter ([ADR-0038](../../docs/adr/0038-vertex-ai-activation.md)), behind the AI Gateway ([ADR-0027](../../docs/adr/0027-ai-gateway-and-provider-registry.md)). The only code that knows Vertex AI's endpoint, request and response format. Server only.

- `catalogue.ts`: the provider (Google Cloud Vertex AI, official API, DEV only) and its one model, Gemini 2.5 Flash-Lite, with its published price.
- `adapter.ts`: `createVertexAIAdapter()`: `generateContent` over REST, authenticated as the service's own identity through the metadata server (no key, no SDK); structured output through `responseSchema`; every failure classified, never thrown.
