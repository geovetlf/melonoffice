# ADR-0105: Sign in with Google

- Status: Accepted
- Date: 2026-09-30
- Builds on: [ADR-0014](0014-firestore-and-identity-platform-in-dev.md), [ADR-0016](0016-auth-and-identity-foundation.md), [ADR-0036](0036-web-identity-foundation.md)
- Changes: ADR-0036 §1 ("no social providers") and ADR-0016's allowed sign-in methods, for Google only.

## Context

Geovet asked for "Entrar con Google" on the sign-in page. The web app signs in over Identity
Platform's REST API with no SDK (ADR-0036), and the API accepted only tokens whose
`firebase.sign_in_provider` is `password`.

## Decision

1. **Redirect flow over REST, still no SDK.** The button calls `accounts:createAuthUri`
   (`providerId: google.com`, `continueUri: <web origin>/login`) and sends the browser to the
   returned Google page. The handle (`sessionId`) is kept in `sessionStorage` for the trip only.
   Back on `/login`, the page posts the full return URL and the handle to
   `accounts:signInWithIdp`; the result is the same session as a password sign-in (ADR-0036 §2).
   Google's answer is removed from the address bar before anything else runs, and the handle is
   used once. Only an `https://accounts.google.com/` page is followed.
2. **The API accepts `google.com` tokens** besides `password`. Anonymous, custom, phone, tenant
   and other providers stay rejected. The user record is the same Identity Platform account, so
   nothing else in the API changes.
3. **Errors the page explains:** provider not turned on or site not authorized, the person said no
   on Google, and an email that already signs in another way (`needConfirmation`).
4. **Enabling it is a console step, not Terraform.** The Google provider needs an OAuth client
   secret; keeping it out of Terraform keeps it out of state and tfvars. Per environment, the owner:
   - creates an OAuth client (Web application) whose authorized redirect URI is the web's
     deterministic URL plus `/login` (DEV: `https://web-988106665456.us-central1.run.app/login`);
   - turns on Google in Identity Platform → Providers with that client;
   - adds the web's host to Identity Platform → Settings → Authorized domains.
     Until then the button says Google sign-in is not turned on here.

## Consequences

- No new dependency and no CSP change: the trip to Google is a top-level navigation.
- An email that already has a password account: with one account per email (our setting),
  Identity Platform links a Google sign-in for a Google-verified address to the same account, so
  the user id does not change.
- The hash URL of the web service still cannot sign in (the browser key's referrer is the
  deterministic URL).
