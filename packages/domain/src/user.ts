import type { IsoTimestamp, UserId } from './ids.js';

/**
 * A person who signs in to MelonOffice. The internal id is ours and never equals the identity
 * provider's subject or the email, so either can change without changing every reference to the
 * user. Credentials never live here: Identity Platform holds them (D-6).
 */
export interface User {
  readonly id: UserId;
  /** The one external account linked to this user. It never changes after creation. */
  readonly identity: ExternalIdentity;
  /** Copied from the last verified sign-in. Contact data only, never an identifier. */
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly lastLoginAt: IsoTimestamp;
}

/** The account at the identity provider that signs in as this user. */
export interface ExternalIdentity {
  readonly provider: 'identity-platform';
  /** The provider's stable user id (the ID token's `sub`). */
  readonly subject: string;
}
