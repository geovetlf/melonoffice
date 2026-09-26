import type { IsoTimestamp, UserId } from './ids.js';

/**
 * A person who signs in to MelonOffice. The internal id is ours and never equals the identity
 * provider's subject, so the provider can change without changing every reference to the user.
 * Credentials never live here: Identity Platform holds them (D-6).
 */
export interface User {
  readonly id: UserId;
  readonly identity: ExternalIdentity;
  readonly createdAt: IsoTimestamp;
}

/** The account at the identity provider that signs in as this user. */
export interface ExternalIdentity {
  readonly provider: 'identity-platform';
  /** The provider's stable user id (the ID token's `sub`). */
  readonly subject: string;
}
