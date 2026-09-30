# ADR-0095: GIA presents herself with the organization's brand (C-5e)

- Status: Proposed
- Date: 2026-09-30
- Builds on: [ADR-0052](0052-gia-chat.md), [ADR-0087](0087-brand-config-and-domain-resolution.md)
- Terraform: none.

## Context

The closing audit of the commercial phases found that GIA's instructions named MelonOffice and MelonMotor whatever the organization's brand. A white-label customer of a partner, or an owner who named their product, saw their own names on every screen, but GIA still called herself GIA of MelonOffice.

## Decision

- GIA takes the organization's resolved brand (the same levels its screens use: platform, a white-label partner, the organization's own, what the partner set for it): its assistant name and product name.
- When they are MelonOffice's own (GIA, MelonOffice), or the brand cannot be read, nothing changes: she is GIA of MelonOffice, powered by MelonMotor.
- Otherwise the names go to the model as data, in a `<presentation>` block with the same escaping as every other block, never inside the instructions. The instructions say to name herself and the app only from it, and, if asked what runs her, to give those names and never an AI provider, a model, or another product or company behind the app.
- The forecast block and its rules say "the app" instead of "MelonOffice", for every organization.

## Consequences

- A white-label customer's GIA never names MelonOffice or MelonMotor. Brand names are already validated (length, no control characters) and reach the model only as data.
- The platform's audit, usage records and screens for administrators are unchanged.
- Tests: the prompt with and without a presentation, a brand read that fails, and through the API an owner's own brand reaching the model for their organization and not for another.
