# ADR-0003: React + Vite single-page app for melonoffice.io

- Status: Accepted (D-2, approved by Geovet on 2026-09-26)
- Date: 2026-09-26

## Context

The application at melonoffice.io is authenticated and highly interactive; search-engine indexing behind login is irrelevant. The marketing site (melonoffice.com) is a separate concern.

## Decision

The web application is a **React** single-page app built with **Vite**. Additional client libraries (routing, server-state caching, UI primitives) are added only in the phase that first needs them, each with its own approval.

## Consequences

- Static hosting on a CDN and a simple mental model.
- No server-side rendering in the app; the marketing site can use a different tool later.
