# NVIDIA provider

NVIDIA is one more official provider behind MelonMotor's AI Gateway ([ADR-0080](../../adr/0080-nvidia-provider.md)). Nothing above the gateway knows it: GIA, agents, workflows and Company Brain ask for a capability, and the existing LLM Router chooses a model.

All facts here come from NVIDIA's official sources, read on **2026-09-29**. Anything NVIDIA does not publish is written as **UNKNOWN / NOT_PUBLISHED**, never guessed.

## The short version

- **What is free.** Members of the free NVIDIA Developer Program get free access to the hosted NIM API endpoints for prototyping ([NIM FAQ](https://docs.api.nvidia.com/nim/docs/product)). This access is "for prototyping, research, development and testing purposes only".
- **What governs it.** The hosted API runs under the [NVIDIA API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf) (v. September 19, 2025):
  - "internal testing and evaluation purposes, not in production", unless a subscription is bought;
  - NVIDIA may use "User Content and Generated Content to improve NVIDIA products and services, including AI models".
- **What production needs.** "Using NIM in production requires an NVIDIA AI Enterprise license", starting at "$4500 per GPU per year or ~ $1 per GPU per hour in the cloud" (NIM FAQ). No price for production use of NVIDIA's _hosted_ endpoints is published there: **UNKNOWN / NOT_PUBLISHED**.
- **Rate limits.** NVIDIA publishes none for the hosted API: **UNKNOWN / NOT_PUBLISHED**. Figures seen in forum posts by users are not official and are not used.

## What MelonOffice does with it

- **Where it runs.** NVIDIA is registered in **DEV only**, and only when the owner sets its key's secret.
- **What data it gets.** Only `public` data. NVIDIA may use what it is sent, so no customer, company or conversation data can reach it. The registry enforces this from the model's recorded terms.
- **The model.** One model is registered: **Nemotron 3 Nano 30B A3B**, for text generation, tool calling and streaming.
- **Cost.** Its provider cost is $0 under free prototyping access. What a customer is charged is still the one credit rule (D-12), unchanged.
- **Where it does not run.** It is not in production, not in staging, and not in any policy that GIA, conversations, Company Brain, decisions or document reading use. Those still pin Gemini on Vertex AI.

## Documents

| File                                         | What it covers                                          |
| -------------------------------------------- | ------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)           | Where NVIDIA sits in MelonMotor, and what was reused.   |
| [MODELS.md](MODELS.md)                       | Models researched, which one is registered, and why.    |
| [CAPABILITIES.md](CAPABILITIES.md)           | Each capability: verified, integrated, or not.          |
| [FREE_ENDPOINTS.md](FREE_ENDPOINTS.md)       | What "free" means here, and what it does not.           |
| [RATE_LIMITS.md](RATE_LIMITS.md)             | Published limits (none) and how 429 is handled.         |
| [SECURITY.md](SECURITY.md)                   | The key, data sensitivity, and what is never logged.    |
| [PRODUCTION_POLICY.md](PRODUCTION_POLICY.md) | Why NVIDIA is DEV only, and what production would need. |
| [SELF_HOSTED_NIM.md](SELF_HOSTED_NIM.md)     | Self-hosted NIM: research only, nothing deployed.       |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md)     | Error codes and what they mean.                         |
| [BENCHMARKS.md](BENCHMARKS.md)               | How to measure it; no results yet.                      |

## Turning it on in DEV

1. Join the NVIDIA Developer Program and create an API key at build.nvidia.com.
2. Create a Secret Manager secret in the DEV project named, for example, `ai-nvidia-api-key`. Put the key in it as its only version. The key never goes in Git, Terraform, chat or logs.
3. Run the DEV plan with `-var nvidia_api_key_secret=ai-nvidia-api-key`. It should add read access on that one secret for the api and worker, and set `NVIDIA_API_KEY_SECRET` on both. Then apply.
