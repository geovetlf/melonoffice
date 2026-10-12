# ADR-0188: passkeys for sensitive administrators (S-2)

- Status: Proposed
- Date: 2026-10-11
- Builds on: [ADR-0138](0138-recent-sign-in-for-sensitive-administration.md) (recent sign-in), [ADR-0098](0098-white-label-over-resellers-on-one-core.md) (white label and resellers), [ADR-0082](0082-ai-providers-platform-admin-only.md) (platform administrators), [ADR-0092](0092-request-limits-on-sensitive-routes.md) (request limits)
- Decision: Geovet chose "Completa (A)" on 2026-10-11 23:24Z. Commercial administrators sign in again when their last access is old (ADR-0138, already in place). Then passkeys for administrators only, with no codes. A business owner keeps signing in without codes.
- Terraform: none. The relying party is the web app's origin, already in `WEB_ORIGINS`. `PASSKEY_RP_ID` is optional, for a parent domain later.
- Firestore: three new collections, written only by the API: `passkeys`, `passkeyChallenges` and `passkeyConfirmations`. They use single-field equality queries only, so no composite index is needed. No migration.
- Dependencies: `@simplewebauthn/server` 14.0.3 (API) and `@simplewebauthn/browser` 14.0.0 (web). They are the maintained reference WebAuthn implementation and are pinned exactly. We do not write our own signature, CBOR or attestation parsing.

## Context

ADR-0138 asks a platform, white-label or reseller administrator to sign in again before a change once their sign-in is more than 30 minutes old. A password typed again still proves only that someone knows the password.

Identity Platform offers SMS and TOTP codes as second factors, but not passkeys. The product rule rules out typed codes. A passkey is the device's own sign-in (fingerprint, face or PIN) answering a WebAuthn challenge. The private key never leaves the device, and a passkey works only on the site it was made for, so a look-alike page cannot use it.

## Decision

1. **Who.** Only people who administer something may add passkeys:
   - platform administrators;
   - active members of an active white-label, reseller, partner or agency account.

   They also need a verified email. Anyone else gets 403 `passkey_forbidden`, and the screen never offers it. A business owner sees nothing new.

2. **Adding a passkey** (`POST /v1/me/passkeys/registration-options`, then `POST /v1/me/passkeys`):
   - The API issues a one-time challenge that lasts 5 minutes. The device signs it, and the API verifies the answer with user verification required.
   - Only the public key, the credential id, the counter and the transports are stored.
   - Adding the first passkey needs a recent sign-in. Adding another needs a passkey confirmation, so a stolen password cannot add an attacker's key.
   - A person can have at most 10 passkeys, and one credential can never belong to two people.

3. **Confirming** (`POST /v1/me/passkeys/confirmation-options`, then `POST /v1/me/passkeys/confirmations`):
   - The device signs a one-time challenge with one of the person's own passkeys.
   - The API verifies it, updates the signature counter (a counter going back means a cloned key and is refused) and answers a random 32-byte token.
   - Only the token's SHA-256 is stored, for 30 minutes, the same window as ADR-0138.
   - The browser keeps the token in memory only and sends it as `x-melon-passkey`. Reloading or signing out forgets it.

4. **What it changes.** The one check from ADR-0138, `staleSignInRefusal`, now decides as follows for every platform change and every commercial administrator's change:
   - A person with passkeys needs a passkey confirmation from the last 30 minutes, whatever their sign-in time. Otherwise they get 403 `passkey_required`, audited under the route's own action. A fresh password sign-in alone no longer passes.
   - A person without passkeys still needs a recent sign-in (`reauthentication_required`).
   - Reads are never refused, and a business owner's own routes are untouched.
   - A confirmation counts only for its own person, and only while the passkey that made it still exists.

5. **Removing and recovery.**
   - Removing one of your passkeys (`DELETE /v1/me/passkeys/:id`) needs a passkey confirmation, so a password alone never removes one.
   - Someone who lost every device asks a platform administrator. The administrator, who needs their own passkey confirmation or recent sign-in, removes all of that person's passkeys with `POST /v1/platform/users/:userId/passkeys/reset`.
   - After that, the person goes back to ADR-0138's recent sign-in until they add a new passkey.

6. **Audit.** These actions are recorded in the same write as the data:
   - `auth.passkey_added`, `auth.passkey_confirmed`, `auth.passkey_removed` and `auth.passkeys_reset`;
   - each records the passkey id as `reference` and the person as `target`;
   - each is denied with a reason when refused.

   Tokens, challenges, public keys and credential ids are never recorded.

7. **Limits.** Passkey writes have their own limit, 20 per person per 10 minutes (`passkey`, ADR-0092).

8. **Where they work.**
   - The relying party id is the host of the first web origin, unless `PASSKEY_RP_ID` names a parent domain. Answers are accepted only from web origins on that host or below it.
   - With no web origin configured, nobody has passkeys. `GET /v1/me/passkeys` says `available: false`, and ADR-0138 alone applies.

9. **Screens.**
   - The partner console and the platform page show a "Sign-in security" section to administrators: their passkeys, when each was added and last used, "Add a passkey on this device" and "Remove".
   - A change refused with `passkey_required` shows "Confirm with my passkey". After that, the person repeats the change.
   - The platform page adds "Lost passkeys", the reset.

## Not decided here

- **Making a passkey mandatory for administrators.** Today it is optional: an administrator without one keeps ADR-0138's recent sign-in. Requiring one is a product step for later, once every administrator has had the chance to add one.
- **Passkeys moving to another domain.** Passkeys made on the DEV web host stop working if the web app moves to `melonoffice.io`, because a passkey is bound to its site. Setting `PASSKEY_RP_ID=melonoffice.io` before production avoids this there.

## Consequences

- An administrator with a passkey confirms with their fingerprint, face or PIN at most once every 30 minutes of administrative changes. They never type a code, and a stolen password is not enough to act or to add a key.
- The private key never reaches MelonOffice. A leak of the passkey collections reveals no secret.
- Tests:
  - `apps/api/src/passkeys.test.ts` runs the real WebAuthn verification against a software authenticator that signs exactly what a device would, in memory and on Firestore. It covers adding, confirming, refusing another site's answer, a reused challenge and a bad signature, one person's confirmation never serving another, removal, the platform reset and the change rules on platform and white-label routes.
  - The web tests cover the client, the in-memory confirmation, the header, the confirmation prompt and the security section.
