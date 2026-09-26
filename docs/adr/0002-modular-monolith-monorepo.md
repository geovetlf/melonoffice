# ADR-0002: Modular monolith in a pnpm + Turborepo monorepo

- Status: Accepted (D-1, approved by Geovet on 2026-09-26)
- Date: 2026-09-26

## Context

MelonOffice is built by a small team in one language (TypeScript) with a fast-changing domain. Microservices from day one would add operational cost without a clear benefit.

## Decision

- One TypeScript monorepo managed with **pnpm workspaces** and **Turborepo**.
- A **modular monolith**: module boundaries are enforced in code (package boundaries and lint rules), and the backend is deployed as a small number of services (an `api` and a `worker`), so services can be split later without rewrites.
- Layering: `domain` depends on nothing; application, adapters, AI orchestration and presentation depend inward. UI packages never import server code, and packages never import applications.

## Consequences

- Fast local development and one CI pipeline.
- Boundaries depend on lint discipline, so the rules live in `eslint.config.js` and are part of CI.
