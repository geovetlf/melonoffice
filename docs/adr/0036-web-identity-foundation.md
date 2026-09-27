# ADR-0036: Web identity foundation (sign-in, session, API client)

- Status: Proposed (pending Geovet's review)
- Date: 2026-09-27
- Builds on:
  - [ADR-0014](0014-firestore-and-identity-platform-in-dev.md) (Identity Platform, email and password)
  - [ADR-0016](0016-auth-and-identity-foundation.md) (the API verifies Identity Platform ID tokens)
  - [ADR-0018](0018-tenancy-and-memberships.md) and [ADR-0019](0019-rbac-foundation.md) (tenant and RBAC decided by the API)
- Does not change: the Tool Gate, the runtime, the worker, executions, conversations, credits or the AI Gateway.

## Context

The API authenticates every call with an Identity Platform ID token, but the web app had no way
to get one: it was a placeholder page. The Conversations Center (CV-1 to CV-3) cannot be mounted
until a person can sign in in the browser. Three facts shaped the design:

- the web and the API are different Cloud Run services, so different origins, and the API sent no
  CORS headers;
- the web's CSP allowed connections to its own origin only;
- the email and password REST endpoints of Identity Platform need a browser API key, which the
  environments do not have yet.

## Decision

### 1. Sign-in with Identity Platform, over REST, with no SDK

The browser posts email and password to `accounts:signInWithPassword` and refreshes with
`securetoken.googleapis.com/v1/token`. No SDK or new dependency; no custom auth, no password stored
anywhere, no tokens minted by MelonOffice, no social providers. The API keeps verifying the ID
token itself (ADR-0016).

### 2. Session

- The ID token lives in memory only.
- The refresh token lives in `sessionStorage`: a reload in the same tab resumes, closing the tab ends
  the session. Nothing goes to `localStorage` or cookies.
- A token within a minute of expiry is refreshed before use, once for all concurrent callers.
- A refused refresh (revoked, expired) ends the session; the sign-in page says so.
- Sign-out forgets both tokens.

### 3. One API client

Every call goes through `createApiClient`: it adds `Authorization: Bearer`, never sends cookies
(`credentials: 'omit'`), and only calls `/v1/` paths of the configured API origin.

| Answer | What the client does                                                    |
| ------ | ----------------------------------------------------------------------- |
| 401    | Refreshes the token once and retries; a second 401 ends the session.    |
| 403    | `ApiError` kind `forbidden`: the app shows "access denied".             |
| 404    | `ApiError` kind `not_found`.                                            |
| 5xx    | `ApiError` kind `server`: the app says it could not load, with a retry. |

Errors carry the API's stable code only, never a stack or a token.

### 4. Tenant and permissions come from the API

- User: `POST /v1/me` right after sign-in (records it, ADR-0017); `GET /v1/me` when a session
  resumes.
- A user with no organization is asked to create one: the form sends only its name to the existing
  `POST /v1/organizations` (ADR-0018), which makes them its owner.
- Organization: the first one `GET /v1/me/organizations` lists. That list holds only the caller's
  active memberships. The web app has no way to name any other organization, and the API still
  resolves the tenant from the membership on every call.
- Permissions: `GET /v1/organizations/:id` now also returns `permissions`, the caller's role's
  permissions there. The web app uses them only to shape the screen. It is not a second RBAC: every
  call is still authorized by the API.

### 5. Pages

`/login` is public. Every other path is behind `ProtectedRoute`: it shows loading while the
session resumes, sends anyone without a session to `/login`, and shows the page only to a member of
an organization. A small history-API router is used; a router library is not an approved
dependency. The signed-in page is a frame (organization, user, sign-out) that shows the Conversations
Center (ADR-0035) to a role with `conversation.read`. The center calls the API only through this
session's client, for the organization the API listed; it has no sign-in, tenant choice or
permission rules of its own.

### 6. Runtime configuration, one build for every environment

The web server serves `/config.json` (`apiUrl`, `identityApiKey`) from its environment variables
`MELONOFFICE_API_URL` and `MELONOFFICE_IDENTITY_API_KEY`. `nginx.conf` became a template that the
image renders at start-up, substituting only `MELONOFFICE_*`. Unset values are empty, and the app
then says sign-in is not set up. The CSP adds `connect-src` for the two Identity Platform hosts and
the API origin.

### 7. CORS on the API: one exact origin, no credentials

`WEB_ORIGINS` (comma-separated exact `https` origins; `http` only for localhost) turns CORS on.
Preflights from an allowed origin are answered before authentication; other origins get no CORS
header at all; `Access-Control-Allow-Credentials` is never sent. The origin grants nothing: every
call is still authenticated and authorized.

### 8. Infrastructure (prepared, not applied)

Where apps and Firestore exist (dev today), the environment module now:

- enables `apikeys.googleapis.com` and `securetoken.googleapis.com`;
- creates `google_apikeys_key.web_sign_in`, restricted to `identitytoolkit` and `securetoken` and
  to referrers `https://web-<project number>.<region>.run.app/*`;
- gives the web `MELONOFFICE_API_URL` (the api's deterministic run.app URL) and the key;
- gives the api `WEB_ORIGINS` (the web's deterministic run.app URL);
- adds `apikeys.keys.get` and `apikeys.keys.getKeyString` to the planner's custom role, so plans
  can refresh the key.

A browser key is public by design (every browser that loads the app receives it), so its value is
declared non-sensitive. Staging and prod get nothing (no apps there).

## Consequences

- Nothing changes in dev until Geovet applies the dev plan. Until then `/config.json` is empty and
  the app says sign-in is not set up, and the CD smoke keeps passing.
- Sign-in works from the web's deterministic URL (`https://web-<project number>.<region>.run.app`),
  the origin the API allows and the key accepts. The other run.app URL of the same service is not
  allowed; a custom domain (D-4) would be added to both lists.
- The planner's least-privilege rule (ADR-0015) now also admits `getKeyString`, for this key only.
- Email verification is still not required (pending product decision).
