# @melonoffice/ai-deepseek

The DeepSeek provider adapter ([ADR-0072](../../docs/adr/0072-llm-router.md)), behind the AI Gateway ([ADR-0027](../../docs/adr/0027-ai-gateway-and-provider-registry.md)). The only code that knows DeepSeek's endpoint, request and response format. Server only.

- `catalogue.ts`: the provider (DeepSeek, official API, DEV only, data up to `internal`) and its models, `deepseek-chat` and `deepseek-reasoner`. Prices are `unknown` until confirmed, so the gateway refuses every call to them until then.
- `adapter.ts`: `createDeepSeekAdapter()`: chat completions over REST with the API key from a `CredentialResolver` (Secret Manager); JSON mode for structured output; cached input reported; every failure classified, never thrown.
