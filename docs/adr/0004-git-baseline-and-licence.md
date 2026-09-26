# ADR-0004: Git baseline and proprietary licence

- Status: Accepted (D-19, approved by Geovet on 2026-09-26)
- Date: 2026-09-26

## Decision

- The repository starts from a baseline commit on `main` (README, LICENSE, `.gitignore`, `.editorconfig`, ADR-0001).
- The code is **proprietary, all rights reserved** (see `LICENSE`).
- All further changes reach `main` through reviewed pull requests with green CI. Repository history is never modified or deleted; no force-push on shared branches.
- Branch protection on `main` is configured by the repository owner.
