# Production policy

**NVIDIA is not allowed in staging or production in MelonOffice today.**

## Why

- NVIDIA's hosted API is offered under trial terms. It is for "internal testing and evaluation purposes, not in production" unless a subscription is bought ([Trial ToS](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)).
- Developer Program access is "for prototyping, research, development and testing purposes only" ([NIM FAQ](https://docs.api.nvidia.com/nim/docs/product)).
- NVIDIA may use inputs and outputs to improve its models, so customer data may not be sent.

## How it is enforced

- **The registry.** A model whose `terms.production` is not `allowed` cannot list `prod`.
- **Terraform.** `nvidia_api_key_secret` is refused outside `dev`.
- **The catalogue.** Provider and model are `environments: ['dev']`.

## What production would need (to validate before any change)

1. **A commercial path.** One of:
   - an NVIDIA subscription for the hosted API, whose price is not published (UNKNOWN), with its terms on data use;
   - an NVIDIA AI Enterprise licence for self-hosted NIM: "$4500 per GPU per year or ~ $1 per GPU per hour in the cloud" (NIM FAQ), plus the GPUs.
2. **Per-model licences.** Each model's own licence must allow commercial use. For example, Nemotron 3 Nano is under the NVIDIA Nemotron Open Model License, and its card says "Commercial use permitted". Third-party models carry their own licences.
3. **Data terms** that do not let NVIDIA use customer content. Only then may `contentUse` become `not_used` and sensitivity rise.
4. **A real price** in the model's pricing, with its source and date.
5. **The owner's decision** on each of the above.
