# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-09-26

## Context

MelonOffice is built in phases. Architecture decisions are made in planning (Phase 0 and later) and must stay traceable as the codebase grows.

## Decision

Every significant architecture decision is recorded as an Architecture Decision Record (ADR) in `docs/adr/`, numbered sequentially, with status, date, context, decision and consequences. An accepted ADR is not edited to change its meaning; a new ADR supersedes it.

## Consequences

- Reviewers can check each change against the recorded decisions.
- Reversing a decision requires a new ADR, which makes the change explicit.
