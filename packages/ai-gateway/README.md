# @melonoffice/ai-gateway

The only way MelonOffice calls an AI model ([ADR-0027](../../docs/adr/0027-ai-gateway-and-provider-registry.md)). Server only, with no HTTP route. The provider and model catalogues are empty until the launch provider is decided (D-7); tests use fake adapters.

- `request.ts`: `AIRequest`, closed and free of authority and credentials, and `checkAIRequest()`.
- `secrets.ts`: `looksLikeSecretText()`, used on prompts, metadata and answers.
- `adapter.ts`: the `ProviderAdapter` contract, provider errors, which are retried and which may fall back, the `CredentialResolver` port and `ProviderCredential`, which never prints its value.
- `registry.ts`: `createProviderRegistry()`, official provider APIs only, checked and frozen; the empty `AI_PROVIDER_CATALOGUE` and `AI_MODEL_CATALOGUE`.
- `policy.ts`: model policies and `DEFAULT_MODEL_POLICY` (up to `internal` data).
- `router.ts`: `routeModel()`, deterministic filtering and ordering, with the reason when nothing fits.
- `cost.ts`: cost from known prices only, and credits from a configured rate.
- `credits.ts`: `AICreditsPort`, the Credits engine's own signatures (no second engine), and the credit states.
- `response.ts`: `AIResponse` (`completed`, `failed` or `denied`) and the check on every provider answer.
- `gateway.ts`: `createAIGateway()`: checks, routing, retries, timeout, fallback, charging, audit and logs.
