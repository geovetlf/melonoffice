# ADR-0011: Separate dev, staging and production cloud projects

- Status: Accepted for planning (D-5, approved for planning by Geovet on 2026-09-26); not implemented
- Date: 2026-09-26

## Decision

- The platform will run in three separate Google Cloud projects: dev, staging and production, managed as code.
- No billing account is assumed or hard-coded. No infrastructure is created and nothing is deployed until the projects and billing configuration exist and Phase 1B is explicitly approved.
- Development work must never be able to modify production resources.
