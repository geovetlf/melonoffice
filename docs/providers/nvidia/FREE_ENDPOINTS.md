# What "free" means here

Sources, read 2026-09-29:

- [NIM FAQ](https://docs.api.nvidia.com/nim/docs/product): "Members of the NVIDIA Developer Program have free access to NIM API endpoints for prototyping". "NIM access through the NVIDIA Developer Program is for prototyping, research, development and testing purposes only". "Production use involves any use of NIM for purposes other than development, testing, research or evaluation such as conducting business transactions".
- [NVIDIA API Trial Terms of Service](https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf), v. September 19, 2025:
  - "for limited trial purposes only and without use of the API Service or Generated Content in production";
  - "NVIDIA may extend trial service credits ("Credits")... NVIDIA will deduct Credits based on your usage";
  - "NVIDIA may at any time terminate the availability, or your use, of the API Service".
- [build.nvidia.com](https://build.nvidia.com/): "Free inference with leading models". Some model pages show "Free Endpoint Available".

## So

| Statement                                                | True?                                                                                |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Free endpoint = no charge in US dollars during the trial | Yes. Usage draws on NVIDIA's trial credits, not money.                               |
| Free endpoint = unlimited                                | **No.** Trial credits are deducted, and NVIDIA may end access at any time.           |
| Free endpoint = allowed in production                    | **No.** It is internal testing and evaluation only, unless a subscription is bought. |
| Free endpoint = no rate limit                            | **No.** Limits exist but are not published (see RATE_LIMITS).                        |
| Free endpoint = safe for customer data                   | **No.** NVIDIA may use inputs and outputs to improve its models.                     |

## How MelonOffice records it

The model's `terms` field holds these values:

| Field        | Value              |
| ------------ | ------------------ |
| `offering`   | `free_prototyping` |
| `production` | `requires_license` |
| `contentUse` | `may_be_used`      |
| `source`     | the trial terms    |
| `verifiedAt` | `2026-09-29`       |

The registry then forces `environments: ['dev']` and `maxSensitivity: 'public'`. The price is a zero price with the NIM FAQ as its source. That is the provider's cost only.

The customer's credit cost is still D-12's rule: 1 credit = US$0.01 of real cost, rounded up. So a call that costs $0 charges 0 credits. **Whether MelonOffice should charge a minimum for calls that cost it nothing is a product decision for the owner.** It is not made here.

The values MelonOffice can record are `free_endpoint`, `free_prototyping`, `paid`, `commercial_license`, `not_allowed`, `unavailable` and `unknown`.
